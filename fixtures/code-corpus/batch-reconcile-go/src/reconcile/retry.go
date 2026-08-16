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

// RetryDecision 是一次重试决策的结果:是否停止(Stop)以及下次重试前应等待的
// 延迟(Delay);Reason 说明决策依据,便于日志排查。
type RetryDecision struct {
	Attempt int
	Delay   time.Duration
	Stop    bool
	Reason  string
}

// RetryPolicy 描述指数退避加重抖动的重试策略。Multiplier 为退避乘数,
// Jitter 为 0~1 的抖动幅度(0 表示不抖动);RetryKinds 是允许重试的失败
// 类别白名单。randomMu 串行化随机数访问,保证并发调用安全。
type RetryPolicy struct {
	InitialDelay time.Duration
	MaximumDelay time.Duration
	Multiplier   float64
	Jitter       float64
	RetryKinds   map[FailureKind]bool
	randomMu     sync.Mutex
	random       *rand.Rand
}

// NewRetryPolicy 构造重试策略并校验参数一致性:初试延迟非负、最大延迟不小于
// 初试延迟、乘数有限且不小于 1、抖动幅度在 [0,1]。默认仅对超时与瞬时故障
// 开启重试,调用方可通过 RetryKinds 调整。
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

// Decide 根据当前尝试次数(attempt 从 1 开始)与失败原因给出重试决策。
// 达到尝试上限或失败不可重试时立即停止;否则按 initial * multiplier^(attempt-1)
// 计算退避延迟,封顶到 MaximumDelay,再叠加 ±Jitter 的随机抖动。
func (policy *RetryPolicy) Decide(attempt, limit int, failure *CommitFailure) RetryDecision {
	if attempt >= limit {
		return RetryDecision{Attempt: attempt, Stop: true, Reason: "attempt limit reached"}
	}
	if failure == nil || !failure.Retryable || !policy.RetryKinds[failure.Kind] {
		return RetryDecision{Attempt: attempt, Stop: true, Reason: "failure is not retryable"}
	}
	// 退避曲线:第 1 次重试用初试延迟,之后按乘数指数增长。
	power := math.Pow(policy.Multiplier, float64(max(0, attempt-1)))
	nominal := float64(policy.InitialDelay) * power
	if nominal > float64(policy.MaximumDelay) {
		nominal = float64(policy.MaximumDelay)
	}
	adjusted := nominal
	if policy.Jitter > 0 && nominal > 0 {
		// 抖动取 [-1,1] 的随机系数,将多个客户端同时重试的峰谷错开,
		// 避免重试风暴同步冲击下游。
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

// Schedule 预生成第 1 次到第 limit 次尝试的完整决策序列,遇 Stop 提前截断。
// 调用方可据此预估整批提交的总耗时,或在提交前完成延迟规划。
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

// WaitForRetry 等待指定的退避延迟,同时监听上下文取消:context 先完成时返回
// 其错误,否则返回 nil。delay 不大于 0 时仅做一次可取消的即时检查。
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

// ClassifiedTransferError 是渠道返回的、已按业务语义分类的传输错误。
// Code 为渠道侧的错误码,Retryable 标记该错误是否值得重试。
type ClassifiedTransferError struct {
	Kind      FailureKind
	Retryable bool
	Code      string
	Cause     error
}

// Error 实现 error 接口,展示渠道错误码(以及可选的底层原因)。
func (failure *ClassifiedTransferError) Error() string {
	if failure.Cause == nil {
		return failure.Code
	}
	return failure.Code + ": " + failure.Cause.Error()
}

// Unwrap 返回底层原因,支持 errors.Is/errors.As 链式匹配。
func (failure *ClassifiedTransferError) Unwrap() error {
	return failure.Cause
}

// ClassifyTransferError 把任意底层错误归类为标准的 CommitFailure:context 取消
// 视为被取消、截止时间到视为超时,已分类错误直接透传;其余错误根据消息文本
// 启发式判定为瞬时故障或永久失败,供上层决定是否重试。
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
	// 无法精确分类时退化为关键词启发式:命中超时/临时/不可用语义的错误
	// 视为瞬时故障放行重试,其余按永久失败处理,避免无限重试。
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "timeout") || strings.Contains(message, "temporar") || strings.Contains(message, "unavailable") {
		return &CommitFailure{Kind: FailureTransient, Message: "provider reported a transient failure", Retryable: true, Cause: err}
	}
	return &CommitFailure{Kind: FailurePermanent, Message: "provider rejected the transfer", Cause: err}
}
