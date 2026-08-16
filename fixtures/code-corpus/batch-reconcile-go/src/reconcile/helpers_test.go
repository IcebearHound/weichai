package reconcile

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testEpoch 是全部测试共用的固定基准时刻,保证断言可复现、不受实际时钟影响。
var testEpoch = time.Date(2028, 4, 17, 10, 30, 0, 0, time.UTC)

// testPayment 构造一笔可用的测试支付:基础字段齐全,RequestedAt 相对基准时间
// 偏移 offset,便于构造时序相关的场景。
func testPayment(identity, source, target string, currency Currency, minor int64, offset time.Duration) Payment {
	return Payment{
		Identity:    identity,
		Account:     source,
		Beneficiary: target,
		Amount:      Money{Currency: currency, Minor: minor},
		RequestedAt: testEpoch.Add(offset),
		Reference:   "invoice-" + identity,
		Attributes: map[string]string{
			"channel": "api",
			"desk":    "treasury",
		},
		Priority:      4,
		ExpectedRoute: "clearing-main",
	}
}

// testRequest 构造一笔带固定幂等键与截止时间的批次请求,默认允许 4 次尝试。
func testRequest(key string, payments ...Payment) CommitRequest {
	return CommitRequest{
		IdempotencyKey:  key,
		Payments:        payments,
		MaximumAttempts: 4,
		RequestedAt:     testEpoch,
		Deadline:        testEpoch.Add(10 * time.Minute),
	}
}

// testCoordinator 构造测试用协调器:注入固定时钟与零延迟退避策略(初试/上限
// 均为 0、乘数 1),使重试行为在测试中可预期。
func testCoordinator(t *testing.T, now time.Time, workers int) (*BatchCommitCoordinator, *MemoryReceiptStore, *BatchArchive) {
	t.Helper()
	policy, err := NewRetryPolicy(0, 0, 1, 0, 41)
	if err != nil {
		t.Fatalf("create retry policy: %v", err)
	}
	store := NewMemoryReceiptStore()
	archive := NewBatchArchive()
	coordinator, err := NewBatchCommitCoordinator(store, archive, CoordinatorConfig{
		WorkerLimit:    workers,
		AttemptTimeout: 2 * time.Second,
		Clock:          func() time.Time { return now },
		RetryPolicy:    policy,
	})
	if err != nil {
		t.Fatalf("create coordinator: %v", err)
	}
	return coordinator, store, archive
}

// successfulTransfer 构造永远成功的渠道函数:凭据含前缀与尝试序号,可验证
// 幂等键之外的调用细节;calls 非空时累计调用次数供断言。
func successfulTransfer(prefix string, calls *atomic.Int64) TransferOperation {
	return func(_ context.Context, payment Payment, attempt int) (TransferResult, error) {
		if calls != nil {
			calls.Add(1)
		}
		return TransferResult{
			ProviderToken: fmt.Sprintf("%s-%s-%d", prefix, payment.Identity, attempt),
			Route:         "domestic-fast",
			CommittedAt:   testEpoch.Add(time.Duration(attempt) * time.Second),
			Metadata:      map[string]string{"rail": "synthetic-clearing"},
		}, nil
	}
}

// transientError 构造可重试的瞬时错误,供失败路径测试复用。
func transientError(code string) error {
	return &ClassifiedTransferError{
		Kind:      FailureTransient,
		Retryable: true,
		Code:      code,
		Cause:     errors.New("temporary provider outage"),
	}
}

// assertSuccessfulEntries 断言条目列表逐笔成功、位置与身份均匹配预期。
func assertSuccessfulEntries(t *testing.T, entries []BatchEntry, identities []string) {
	t.Helper()
	if len(entries) != len(identities) {
		t.Fatalf("entry count %d, want %d", len(entries), len(identities))
	}
	for position, identity := range identities {
		entry := entries[position]
		if entry.Position != position {
			t.Errorf("entry %d has position %d", position, entry.Position)
		}
		if entry.PaymentID != identity {
			t.Errorf("entry %d has payment %s, want %s", position, entry.PaymentID, identity)
		}
		if !entry.Successful() || entry.Receipt == nil {
			t.Errorf("entry %d should be successful: %+v", position, entry)
		}
	}
}

// recordingTransfer 是可编程的测试渠道:可配置每笔支付失败前的前 N 次尝试
// (failUntil)、阻塞入口(entered)与放行信号(release),用于精确控制并发
// 时序与重试路径;attempts 记录每笔支付的实际尝试次数。
type recordingTransfer struct {
	mu        sync.Mutex
	attempts  map[string]int
	failUntil map[string]int
	entered   chan string
	release   <-chan struct{}
}

// call 实现渠道逻辑:按配置先失败指定次数,需要时可阻塞在 entered/release
// 通道上以模拟慢渠道,并尊重 context 取消。
func (transfer *recordingTransfer) call(ctx context.Context, payment Payment, attempt int) (TransferResult, error) {
	transfer.mu.Lock()
	if transfer.attempts == nil {
		transfer.attempts = make(map[string]int)
	}
	transfer.attempts[payment.Identity]++
	failures := transfer.failUntil[payment.Identity]
	transfer.mu.Unlock()
	if transfer.entered != nil {
		select {
		case transfer.entered <- payment.Identity:
		case <-ctx.Done():
			return TransferResult{}, ctx.Err()
		}
	}
	if transfer.release != nil {
		select {
		case <-transfer.release:
		case <-ctx.Done():
			return TransferResult{}, ctx.Err()
		}
	}
	if attempt <= failures {
		return TransferResult{}, transientError("retry-me")
	}
	return TransferResult{
		ProviderToken: fmt.Sprintf("provider-%s-%d", payment.Identity, attempt),
		Route:         "reserve-rail",
		CommittedAt:   testEpoch.Add(time.Duration(attempt) * time.Second),
	}, nil
}

// count 返回指定支付累计的尝试次数。
func (transfer *recordingTransfer) count(identity string) int {
	transfer.mu.Lock()
	defer transfer.mu.Unlock()
	return transfer.attempts[identity]
}
