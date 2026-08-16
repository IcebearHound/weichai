package fanout

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// SourceMode 表示熔断器对一个报价源(提供方)的当前开关状态。
type SourceMode string

// 三种状态:closed 正常放行,open 熔断拒流(等待冷却),half-open 放行单个
// 探针调用验证恢复情况。
const (
	SourceClosed   SourceMode = "closed"
	SourceOpen     SourceMode = "open"
	SourceHalfOpen SourceMode = "half-open"
)

// SwitchPolicy 配置熔断参数:连续/加权失败达到 FailureLimit 时熔断,冷却
// OpenFor 后进入半开;半开状态下连续成功 RecoverySuccesses 次即恢复,探针
// 调用有 RequestTimeout 超时;不可重试失败按 NonRetryableWeight 加权。
type SwitchPolicy struct {
	FailureLimit       int
	RecoverySuccesses  int
	OpenFor            time.Duration
	RequestTimeout     time.Duration
	MaximumProbeCalls  int
	NonRetryableWeight int
}

// SourceRegistration 注册一个受熔断保护的报价源:Provider 实现取价逻辑,
// Priority 决定故障时回退顺序,Pairs 为该源支持的货币对。
type SourceRegistration struct {
	Provider QuoteProvider
	Priority int
	Pairs    []Pair
}

// sourceCircuit 是单个报价源的熔断状态机:当前模式、连续成败计数、加权失败
// 数、熔断时刻、探针占用标记、代际号(每次状态切换递增,供观测比对)与统计。
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

// SourceView 是熔断器状态的对外快照,供监控与排障展示。
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

// switchPermit 是一次路由尝试前从状态机取得的放行凭证:probe 标记该次调用
// 是否为半开探针,allowed 为是否放行,reason 为拒绝原因。
type switchPermit struct {
	provider string
	probe    bool
	allowed  bool
	reason   error
}

// HealthSwitch 按优先级依次尝试受保护的报价源:熔断的源被跳过,恢复中的源
// 只放行单个探针调用;全部失败时汇总各源的原因返回错误。
type HealthSwitch struct {
	mu            sync.Mutex
	clock         Clock
	policy        SwitchPolicy
	registrations []SourceRegistration
	state         map[string]*sourceCircuit
}

// NewHealthSwitch 校验策略与注册表并初始化每个源的状态机:要求至少一个源、
// 名称唯一、存在可回退的重叠货币对;注册表按优先级(同优先级按名称)排序。
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

// Select 为请求选择报价源并返回报价:按注册优先级依次尝试,熔断源直接跳过,
// 每次调用有独立超时;源返回的报价需通过校验(合法、币种对一致、身份一致)。
// 全部失败时以 ErrQuoteUnavailable 包装各失败原因返回。
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
	// 从高优先级到低优先级依次尝试,支持该货币对的源都会进入候选。
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

// classifyProviderError 把错误映射为可观测的类别,供聚合与告警使用。
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

// providerErrorRetryable 判断错误是否值得换源重试:取消不可重试,超时与
// 已分类错误按自身标记,其余默认可重试。
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

// acquire 从状态机申请一次放行:熔断中且未到冷却时间则拒绝;冷却期满自动
// 转入半开;半开状态下已有探针在飞则拒绝其余调用,否则放行唯一探针。
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
		// 冷却期满:自动转为半开,清零恢复计数,准备放行探针。
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

// finish 结算一次调用的结果:成功累计连续成功,半开状态下达到阈值则恢复为
// closed;失败按可重试性加权累计,超过阈值(或半开中失败)则熔断为 open。
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
		// 不可重试失败(如参数错误)说明问题可能持续,给予更高权重。
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

// Snapshot 返回全部报价源状态的排序快照,供监控展示;内部不变量被破坏时
// 直接 panic,避免掩盖状态机损坏。
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

// Reset 手动把指定报价源复位为 closed(清零全部计数),返回是否存在该源。
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
