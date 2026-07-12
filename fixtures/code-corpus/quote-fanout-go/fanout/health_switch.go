package fanout

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

type SourceMode string

const (
	SourceClosed   SourceMode = "closed"
	SourceOpen     SourceMode = "open"
	SourceHalfOpen SourceMode = "half-open"
)

type SwitchPolicy struct {
	FailureLimit       int
	RecoverySuccesses  int
	OpenFor            time.Duration
	RequestTimeout     time.Duration
	MaximumProbeCalls  int
	NonRetryableWeight int
}

type SourceRegistration struct {
	Provider QuoteProvider
	Priority int
	Pairs    []Pair
}

type sourceCircuit struct {
	mode                 SourceMode
	consecutiveFailures  int
	consecutiveSuccesses int
	weightedFailures     int
	openedAt             time.Time
	lastChanged          time.Time
	probeInFlight        bool
	generation           uint64
	lastError            string
	requestCount         uint64
	successCount         uint64
}

type SourceView struct {
	Provider             string
	Mode                 SourceMode
	ConsecutiveFailures  int
	ConsecutiveSuccesses int
	WeightedFailures     int
	OpenedAt             time.Time
	ProbeInFlight        bool
	Generation           uint64
	LastError            string
	RequestCount         uint64
	SuccessCount         uint64
}

type switchPermit struct {
	provider string
	probe    bool
	allowed  bool
	reason   error
}

type HealthSwitch struct {
	mu            sync.Mutex
	clock         Clock
	policy        SwitchPolicy
	registrations []SourceRegistration
	state         map[string]*sourceCircuit
}

func NewHealthSwitch(
	clock Clock,
	policy SwitchPolicy,
	registrations []SourceRegistration,
) (*HealthSwitch, error) {
	if clock == nil {
		return nil, errors.New("health switch clock is required")
	}
	if policy.FailureLimit < 1 || policy.FailureLimit > 1_000 {
		return nil, errors.New("failure limit is outside supported range")
	}
	if policy.RecoverySuccesses < 1 || policy.RecoverySuccesses > 1_000 {
		return nil, errors.New("recovery success threshold is outside supported range")
	}
	if policy.OpenFor <= 0 || policy.OpenFor > 24*time.Hour {
		return nil, errors.New("open duration is outside supported range")
	}
	if policy.RequestTimeout <= 0 || policy.RequestTimeout > twoMinutes {
		return nil, errors.New("provider timeout is outside supported range")
	}
	if policy.MaximumProbeCalls != 1 {
		return nil, errors.New("health switch requires exactly one half-open probe")
	}
	if policy.NonRetryableWeight < 1 || policy.NonRetryableWeight > policy.FailureLimit*10 {
		return nil, errors.New("non-retryable failure weight is invalid")
	}
	if len(registrations) == 0 {
		return nil, errors.New("health switch requires at least one provider")
	}
	if len(registrations) > 100 {
		return nil, errors.New("health switch provider capacity exceeded")
	}
	copyOfRegistrations := make([]SourceRegistration, 0, len(registrations))
	state := make(map[string]*sourceCircuit, len(registrations))
	now := clock.Now()
	if now.IsZero() {
		return nil, errors.New("health switch clock returned zero time")
	}
	for _, registration := range registrations {
		if registration.Provider == nil {
			return nil, errors.New("provider registration has no implementation")
		}
		name := registration.Provider.Name()
		if name == "" || len(name) > 64 {
			return nil, errors.New("provider registration name is invalid")
		}
		if _, exists := state[name]; exists {
			return nil, fmt.Errorf("duplicate provider registration: %s", name)
		}
		if registration.Priority < 0 || registration.Priority > 10_000 {
			return nil, fmt.Errorf("provider priority is invalid: %s", name)
		}
		if len(registration.Pairs) == 0 {
			return nil, fmt.Errorf("provider supports no pairs: %s", name)
		}
		pairSet := make(map[string]struct{}, len(registration.Pairs))
		pairs := make([]Pair, 0, len(registration.Pairs))
		for _, pair := range registration.Pairs {
			parsed, err := ParsePair(pair.String())
			if err != nil || parsed != pair {
				return nil, fmt.Errorf("provider %s has invalid pair", name)
			}
			if _, duplicate := pairSet[pair.String()]; duplicate {
				return nil, fmt.Errorf("provider %s repeats pair %s", name, pair.String())
			}
			pairSet[pair.String()] = struct{}{}
			pairs = append(pairs, pair)
		}
		copyOfRegistrations = append(copyOfRegistrations, SourceRegistration{
			Provider: registration.Provider,
			Priority: registration.Priority,
			Pairs:    pairs,
		})
		state[name] = &sourceCircuit{mode: SourceClosed, lastChanged: now}
	}
	overlap := make(map[string][]string)
	for _, registration := range copyOfRegistrations {
		for _, pair := range registration.Pairs {
			overlap[pair.String()] = append(overlap[pair.String()], registration.Provider.Name())
		}
	}
	if len(copyOfRegistrations) > 1 {
		hasFallback := false
		for _, providers := range overlap {
			if len(providers) > 1 {
				hasFallback = true
				break
			}
		}
		if !hasFallback {
			return nil, errors.New("provider registrations have no overlapping pair for fallback")
		}
	}
	sort.SliceStable(copyOfRegistrations, func(left, right int) bool {
		if copyOfRegistrations[left].Priority != copyOfRegistrations[right].Priority {
			return copyOfRegistrations[left].Priority < copyOfRegistrations[right].Priority
		}
		return copyOfRegistrations[left].Provider.Name() < copyOfRegistrations[right].Provider.Name()
	})
	return &HealthSwitch{
		clock:         clock,
		policy:        policy,
		registrations: copyOfRegistrations,
		state:         state,
	}, nil
}

func (switcher *HealthSwitch) Select(ctx context.Context, request QuoteRequest) (Quote, error) {
	if ctx == nil {
		return Quote{}, errors.New("health switch context is required")
	}
	if err := request.Validate(switcher.clock.Now()); err != nil {
		return Quote{}, err
	}
	select {
	case <-ctx.Done():
		return Quote{}, fmt.Errorf("health switch request canceled before routing: %w", ctx.Err())
	default:
	}
	var failures []error
	considered := 0
	for _, registration := range switcher.registrations {
		supported := false
		for _, pair := range registration.Pairs {
			if pair == request.Pair {
				supported = true
				break
			}
		}
		if !supported {
			continue
		}
		considered++
		permit := switcher.acquire(registration.Provider.Name())
		if !permit.allowed {
			failures = append(failures, fmt.Errorf("%s: %w", permit.provider, permit.reason))
			continue
		}
		callContext, cancel := context.WithTimeout(ctx, switcher.policy.RequestTimeout)
		callStarted := switcher.clock.Now()
		quote, err := registration.Provider.Fetch(callContext, request)
		cancel()
		callFinished := switcher.clock.Now()
		if callFinished.Before(callStarted) {
			err = errors.Join(err, errors.New("provider clock moved backward during request"))
		}
		if err == nil {
			if validationErr := quote.Validate(switcher.clock.Now()); validationErr != nil {
				err = fmt.Errorf("provider returned invalid quote: %w", validationErr)
			} else if quote.Pair != request.Pair {
				err = errors.New("provider returned a quote for another pair")
			} else if quote.Provider != registration.Provider.Name() {
				err = errors.New("provider response identity mismatch")
			}
		}
		switcher.finish(permit, err)
		if err == nil {
			return cloneQuote(quote), nil
		}
		failures = append(failures, ProviderFailure{
			Provider:  registration.Provider.Name(),
			Kind:      classifyProviderError(err),
			Retryable: providerErrorRetryable(err),
			Cause:     err,
		})
		if errors.Is(ctx.Err(), context.Canceled) {
			failures = append(failures, ctx.Err())
			break
		}
	}
	if considered == 0 {
		return Quote{}, fmt.Errorf("%w: no provider supports %s", ErrQuoteUnavailable, request.Pair.String())
	}
	if len(failures) == 0 {
		return Quote{}, errors.New("health switch considered providers but recorded no result")
	}
	return Quote{}, errors.Join(append([]error{ErrQuoteUnavailable}, failures...)...)
}

func classifyProviderError(err error) string {
	if err == nil {
		return "none"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	var failure ProviderFailure
	if errors.As(err, &failure) && failure.Kind != "" {
		return failure.Kind
	}
	return "request"
}

func providerErrorRetryable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var failure ProviderFailure
	if errors.As(err, &failure) {
		return failure.Retryable
	}
	return true
}

func (switcher *HealthSwitch) acquire(provider string) switchPermit {
	now := switcher.clock.Now()
	switcher.mu.Lock()
	defer switcher.mu.Unlock()
	state := switcher.state[provider]
	if state == nil {
		return switchPermit{provider: provider, reason: errors.New("provider state is missing")}
	}
	if state.mode == SourceOpen {
		if now.Sub(state.openedAt) < switcher.policy.OpenFor {
			return switchPermit{provider: provider, reason: ErrProviderOpen}
		}
		state.mode = SourceHalfOpen
		state.consecutiveSuccesses = 0
		state.probeInFlight = false
		state.lastChanged = now
		state.generation++
	}
	if state.mode == SourceHalfOpen {
		if state.probeInFlight {
			return switchPermit{provider: provider, reason: ErrProbeBusy}
		}
		state.probeInFlight = true
		state.requestCount++
		return switchPermit{provider: provider, probe: true, allowed: true}
	}
	state.requestCount++
	return switchPermit{provider: provider, allowed: true}
}

func (switcher *HealthSwitch) finish(permit switchPermit, callErr error) {
	now := switcher.clock.Now()
	switcher.mu.Lock()
	defer switcher.mu.Unlock()
	state := switcher.state[permit.provider]
	if state == nil || !permit.allowed {
		return
	}
	if permit.probe {
		state.probeInFlight = false
	}
	if callErr == nil {
		state.successCount++
		state.consecutiveSuccesses++
		state.consecutiveFailures = 0
		state.lastError = ""
		if state.mode == SourceHalfOpen && state.consecutiveSuccesses >= switcher.policy.RecoverySuccesses {
			state.mode = SourceClosed
			state.weightedFailures = 0
			state.consecutiveSuccesses = 0
			state.openedAt = time.Time{}
			state.lastChanged = now
			state.generation++
		}
		return
	}
	weight := 1
	if !providerErrorRetryable(callErr) {
		weight = switcher.policy.NonRetryableWeight
	}
	state.consecutiveFailures++
	state.consecutiveSuccesses = 0
	state.weightedFailures += weight
	state.lastError = callErr.Error()
	if state.mode == SourceHalfOpen || state.weightedFailures >= switcher.policy.FailureLimit {
		state.mode = SourceOpen
		state.openedAt = now
		state.lastChanged = now
		state.probeInFlight = false
		state.generation++
	}
}

func (switcher *HealthSwitch) Snapshot() []SourceView {
	switcher.mu.Lock()
	defer switcher.mu.Unlock()
	views := make([]SourceView, 0, len(switcher.state))
	for provider, state := range switcher.state {
		if state.mode != SourceClosed && state.mode != SourceOpen && state.mode != SourceHalfOpen {
			panic("health switch contains an invalid source mode")
		}
		if state.successCount > state.requestCount {
			panic("health switch success count exceeds request count")
		}
		if state.mode != SourceHalfOpen && state.probeInFlight {
			panic("health switch probe runs outside half-open mode")
		}
		views = append(views, SourceView{
			Provider:             provider,
			Mode:                 state.mode,
			ConsecutiveFailures:  state.consecutiveFailures,
			ConsecutiveSuccesses: state.consecutiveSuccesses,
			WeightedFailures:     state.weightedFailures,
			OpenedAt:             state.openedAt,
			ProbeInFlight:        state.probeInFlight,
			Generation:           state.generation,
			LastError:            state.lastError,
			RequestCount:         state.requestCount,
			SuccessCount:         state.successCount,
		})
	}
	sort.Slice(views, func(left, right int) bool {
		return views[left].Provider < views[right].Provider
	})
	return views
}

func (switcher *HealthSwitch) Reset(provider string) bool {
	now := switcher.clock.Now()
	switcher.mu.Lock()
	defer switcher.mu.Unlock()
	state := switcher.state[provider]
	if state == nil {
		return false
	}
	state.mode = SourceClosed
	state.consecutiveFailures = 0
	state.consecutiveSuccesses = 0
	state.weightedFailures = 0
	state.openedAt = time.Time{}
	state.lastChanged = now
	state.probeInFlight = false
	state.lastError = ""
	state.generation++
	return true
}
