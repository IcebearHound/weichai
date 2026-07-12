package reconcile

import (
	"context"
	"errors"
	"math"
	"math/rand"
	"strings"
	"sync"
	"time"
)

type RetryDecision struct {
	Attempt int
	Delay   time.Duration
	Stop    bool
	Reason  string
}

type RetryPolicy struct {
	InitialDelay time.Duration
	MaximumDelay time.Duration
	Multiplier   float64
	Jitter       float64
	RetryKinds   map[FailureKind]bool
	randomMu     sync.Mutex
	random       *rand.Rand
}

func NewRetryPolicy(initial, maximum time.Duration, multiplier, jitter float64, seed int64) (*RetryPolicy, error) {
	if initial < 0 || maximum < initial {
		return nil, errors.New("retry delays are inconsistent")
	}
	if multiplier < 1 || math.IsNaN(multiplier) || math.IsInf(multiplier, 0) {
		return nil, errors.New("retry multiplier must be finite and at least one")
	}
	if jitter < 0 || jitter > 1 || math.IsNaN(jitter) {
		return nil, errors.New("retry jitter must be between zero and one")
	}
	return &RetryPolicy{
		InitialDelay: initial,
		MaximumDelay: maximum,
		Multiplier:   multiplier,
		Jitter:       jitter,
		RetryKinds: map[FailureKind]bool{
			FailureTimeout:   true,
			FailureTransient: true,
		},
		random: rand.New(rand.NewSource(seed)),
	}, nil
}

func (policy *RetryPolicy) Decide(attempt, limit int, failure *CommitFailure) RetryDecision {
	if attempt >= limit {
		return RetryDecision{Attempt: attempt, Stop: true, Reason: "attempt limit reached"}
	}
	if failure == nil || !failure.Retryable || !policy.RetryKinds[failure.Kind] {
		return RetryDecision{Attempt: attempt, Stop: true, Reason: "failure is not retryable"}
	}
	power := math.Pow(policy.Multiplier, float64(max(0, attempt-1)))
	nominal := float64(policy.InitialDelay) * power
	if nominal > float64(policy.MaximumDelay) {
		nominal = float64(policy.MaximumDelay)
	}
	adjusted := nominal
	if policy.Jitter > 0 && nominal > 0 {
		policy.randomMu.Lock()
		delta := policy.random.Float64()*2 - 1
		policy.randomMu.Unlock()
		adjusted = nominal * (1 + delta*policy.Jitter)
	}
	if adjusted < 0 {
		adjusted = 0
	}
	if adjusted > float64(policy.MaximumDelay) {
		adjusted = float64(policy.MaximumDelay)
	}
	return RetryDecision{Attempt: attempt, Delay: time.Duration(adjusted), Reason: "retry scheduled"}
}

func (policy *RetryPolicy) Schedule(limit int, failure *CommitFailure) []RetryDecision {
	if limit < 1 {
		return nil
	}
	decisions := make([]RetryDecision, 0, limit)
	for attempt := 1; attempt <= limit; attempt++ {
		decision := policy.Decide(attempt, limit, failure)
		decisions = append(decisions, decision)
		if decision.Stop {
			break
		}
	}
	return decisions
}

func WaitForRetry(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type ClassifiedTransferError struct {
	Kind      FailureKind
	Retryable bool
	Code      string
	Cause     error
}

func (failure *ClassifiedTransferError) Error() string {
	if failure.Cause == nil {
		return failure.Code
	}
	return failure.Code + ": " + failure.Cause.Error()
}

func (failure *ClassifiedTransferError) Unwrap() error {
	return failure.Cause
}

func ClassifyTransferError(err error) *CommitFailure {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return &CommitFailure{Kind: FailureCancelled, Message: "transfer context cancelled", Cause: err}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &CommitFailure{Kind: FailureTimeout, Message: "transfer deadline exceeded", Retryable: true, Cause: err}
	}
	var classified *ClassifiedTransferError
	if errors.As(err, &classified) {
		return &CommitFailure{
			Kind:      classified.Kind,
			Message:   strings.TrimSpace(classified.Code),
			Retryable: classified.Retryable,
			Cause:     classified.Cause,
		}
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "timeout") || strings.Contains(message, "temporar") || strings.Contains(message, "unavailable") {
		return &CommitFailure{Kind: FailureTransient, Message: "provider reported a transient failure", Retryable: true, Cause: err}
	}
	return &CommitFailure{Kind: FailurePermanent, Message: "provider rejected the transfer", Cause: err}
}
