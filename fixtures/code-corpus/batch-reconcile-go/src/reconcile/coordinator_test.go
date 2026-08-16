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

// TestCoordinatorCommitsInInputOrder 验证协调器保持批内输入顺序逐笔成功提交,
// 生成回执并归档批次。
func TestCoordinatorCommitsInInputOrder(t *testing.T) {
	coordinator, store, archive := testCoordinator(t, testEpoch, 3)
	payments := []Payment{
		testPayment("pay-c", "acct-1", "benef-9", CurrencyUSD, 3_100, 3*time.Second),
		testPayment("pay-a", "acct-4", "benef-2", CurrencyEUR, 8_250, time.Second),
		testPayment("pay-b", "acct-7", "benef-5", CurrencyGBP, 1_975, 2*time.Second),
	}
	var calls atomic.Int64
	entries, err := coordinator.Reconcile(context.Background(), testRequest("batch-order-001", payments...), successfulTransfer("token", &calls))
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	assertSuccessfulEntries(t, entries, []string{"pay-c", "pay-a", "pay-b"})
	if calls.Load() != 3 {
		t.Fatalf("transfer calls %d, want 3", calls.Load())
	}
	if store.Count() != 3 {
		t.Fatalf("receipt count %d, want 3", store.Count())
	}
	archived, exists := archive.Get("batch-order-001")
	if !exists || len(archived.Entries) != 3 {
		t.Fatalf("batch was not archived: %+v", archived)
	}
	for position, entry := range entries {
		if entry.Receipt.BatchKey != "batch-order-001" {
			t.Errorf("receipt %d has batch %s", position, entry.Receipt.BatchKey)
		}
		if entry.Receipt.Attempt != 1 {
			t.Errorf("receipt %d attempt %d, want 1", position, entry.Receipt.Attempt)
		}
	}
}

// TestCoordinatorRetriesOnlyFailedPayments 验证只有失败支付会重试(按配置的
// 失败次数),成功支付只调用一次渠道,尝试次数写入回执且指标正确。
func TestCoordinatorRetriesOnlyFailedPayments(t *testing.T) {
	coordinator, store, _ := testCoordinator(t, testEpoch, 4)
	payments := []Payment{
		testPayment("stable-1", "acct-a", "benef-a", CurrencyUSD, 500, 0),
		testPayment("retry-2", "acct-b", "benef-b", CurrencyUSD, 900, time.Second),
		testPayment("retry-3", "acct-c", "benef-c", CurrencyEUR, 1_200, 2*time.Second),
		testPayment("stable-4", "acct-d", "benef-d", CurrencyJPY, 3_300, 3*time.Second),
	}
	transfer := &recordingTransfer{failUntil: map[string]int{"retry-2": 1, "retry-3": 2}}
	entries, err := coordinator.Reconcile(context.Background(), testRequest("batch-retries-002", payments...), transfer.call)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	assertSuccessfulEntries(t, entries, []string{"stable-1", "retry-2", "retry-3", "stable-4"})
	wants := map[string]int{"stable-1": 1, "retry-2": 2, "retry-3": 3, "stable-4": 1}
	for identity, want := range wants {
		if got := transfer.count(identity); got != want {
			t.Errorf("%s calls %d, want %d", identity, got, want)
		}
	}
	if entries[1].Attempts != 2 || entries[2].Attempts != 3 {
		t.Errorf("attempt counts are not preserved: %+v", entries)
	}
	if store.Count() != 4 {
		t.Errorf("receipt count %d, want 4", store.Count())
	}
	metrics := coordinator.Metrics()
	if metrics.RetriesScheduled != 3 {
		t.Errorf("retry metric %d, want 3", metrics.RetriesScheduled)
	}
}

// TestCoordinatorLeavesPermanentFailureInPlace 验证永久失败不再重试、原样保留
// 在结果中,批次其他支付照常成功,且汇总错误能反映部分失败。
func TestCoordinatorLeavesPermanentFailureInPlace(t *testing.T) {
	coordinator, store, _ := testCoordinator(t, testEpoch, 2)
	request := testRequest(
		"batch-partial-003",
		testPayment("good-first", "src-1", "dst-1", CurrencyCAD, 700, 0),
		testPayment("bad-middle", "src-2", "dst-2", CurrencyCHF, 800, time.Second),
		testPayment("good-last", "src-3", "dst-3", CurrencyCNY, 900, 2*time.Second),
	)
	operation := func(_ context.Context, payment Payment, attempt int) (TransferResult, error) {
		if payment.Identity == "bad-middle" {
			return TransferResult{}, &ClassifiedTransferError{
				Kind:  FailurePermanent,
				Code:  "beneficiary closed",
				Cause: errors.New("account no longer exists"),
			}
		}
		return TransferResult{ProviderToken: payment.Identity, Route: "main", CommittedAt: testEpoch}, nil
	}
	entries, err := coordinator.Reconcile(context.Background(), request, operation)
	if err != nil {
		t.Fatalf("batch-level error: %v", err)
	}
	if !entries[0].Successful() || entries[1].Successful() || !entries[2].Successful() {
		t.Fatalf("unexpected outcome pattern: %+v", entries)
	}
	if entries[1].Attempts != 1 || entries[1].Failure.Kind != FailurePermanent {
		t.Errorf("permanent failure not classified: %+v", entries[1])
	}
	if store.Count() != 2 {
		t.Errorf("receipt count %d, want 2", store.Count())
	}
	formatted := FormatBatchFailure(entries)
	if formatted == nil || formatted.Error() == "" {
		t.Error("partial failure should produce a diagnostic")
	}
}

// TestCoordinatorConcurrentDuplicateJoinsSingleFlight 验证同一幂等键的 8 个并发
// 请求合并为一次执行:仅 leader 调用渠道,其余加入者拿到相同回执,无重复
// 副作用,指标中合并/重放计数正确。
func TestCoordinatorConcurrentDuplicateJoinsSingleFlight(t *testing.T) {
	coordinator, store, archive := testCoordinator(t, testEpoch, 2)
	request := testRequest(
		"batch-concurrent-004",
		testPayment("join-a", "acct-one", "benef-one", CurrencyUSD, 1_100, 0),
		testPayment("join-b", "acct-two", "benef-two", CurrencyEUR, 2_200, time.Second),
	)
	entered := make(chan string, 4)
	release := make(chan struct{})
	transfer := &recordingTransfer{failUntil: map[string]int{}, entered: entered, release: release}
	const callers = 8
	results := make([][]BatchEntry, callers)
	errorsByCaller := make([]error, callers)
	start := make(chan struct{})
	var group sync.WaitGroup
	for caller := 0; caller < callers; caller++ {
		caller := caller
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			results[caller], errorsByCaller[caller] = coordinator.Reconcile(context.Background(), request, transfer.call)
		}()
	}
	close(start)
	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case identity := <-entered:
			seen[identity] = true
		case <-time.After(2 * time.Second):
			t.Fatal("leader transfer did not start both payments")
		}
	}
	if metrics := coordinator.Metrics(); metrics.BatchesStarted != 1 || metrics.ActiveBatches != 1 {
		t.Fatalf("unexpected active metrics: %+v", metrics)
	}
	close(release)
	group.Wait()
	for caller, err := range errorsByCaller {
		if err != nil {
			t.Errorf("caller %d: %v", caller, err)
		}
		assertSuccessfulEntries(t, results[caller], []string{"join-a", "join-b"})
		if results[caller][0].Receipt.ReceiptID != results[0][0].Receipt.ReceiptID {
			t.Errorf("caller %d received a different first receipt", caller)
		}
	}
	if transfer.count("join-a") != 1 || transfer.count("join-b") != 1 {
		t.Errorf("duplicate side effects: a=%d b=%d", transfer.count("join-a"), transfer.count("join-b"))
	}
	if store.Count() != 2 {
		t.Errorf("receipt store contains %d records", store.Count())
	}
	if _, exists := archive.Get(request.IdempotencyKey); !exists {
		t.Error("joined flight was not archived")
	}
	metrics := coordinator.Metrics()
	if metrics.BatchesJoined+metrics.BatchesReplayed != callers-1 {
		t.Errorf(
			"duplicate caller metrics joined=%d replayed=%d, want %d total",
			metrics.BatchesJoined,
			metrics.BatchesReplayed,
			callers-1,
		)
	}
}

// TestCoordinatorReplayNeverCallsTransferAgain 验证已完成批次的再次提交直接
// 从归档重放,不再次调用渠道,返回相同的回执。
func TestCoordinatorReplayNeverCallsTransferAgain(t *testing.T) {
	coordinator, store, _ := testCoordinator(t, testEpoch, 1)
	request := testRequest("batch-replay-005", testPayment("replay-one", "src", "dst", CurrencyGBP, 6_700, 0))
	var firstCalls atomic.Int64
	first, err := coordinator.Reconcile(context.Background(), request, successfulTransfer("first", &firstCalls))
	if err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	var replayCalls atomic.Int64
	replayed, err := coordinator.Reconcile(context.Background(), request, successfulTransfer("second", &replayCalls))
	if err != nil {
		t.Fatalf("replay reconcile: %v", err)
	}
	if firstCalls.Load() != 1 || replayCalls.Load() != 0 {
		t.Fatalf("unexpected calls first=%d replay=%d", firstCalls.Load(), replayCalls.Load())
	}
	if first[0].Receipt.ReceiptID != replayed[0].Receipt.ReceiptID {
		t.Error("replay returned a different receipt")
	}
	if store.Count() != 1 {
		t.Errorf("receipt store count %d, want 1", store.Count())
	}
	if coordinator.Metrics().BatchesReplayed != 1 {
		t.Errorf("replay metric: %+v", coordinator.Metrics())
	}
}

// TestCoordinatorRejectsKeyReuseWithDifferentPayload 验证同一幂等键携带不同
// 内容时被拒绝为 BatchConflictError,且冲突重放绝不调用渠道。
func TestCoordinatorRejectsKeyReuseWithDifferentPayload(t *testing.T) {
	coordinator, _, _ := testCoordinator(t, testEpoch, 1)
	original := testRequest("batch-conflict-006", testPayment("same-id", "src", "dst", CurrencyAUD, 1_000, 0))
	if _, err := coordinator.Reconcile(context.Background(), original, successfulTransfer("original", nil)); err != nil {
		t.Fatalf("original reconcile: %v", err)
	}
	changed := original
	changed.Payments = append([]Payment(nil), original.Payments...)
	changed.Payments[0].Amount.Minor = 2_000
	entries, err := coordinator.Reconcile(context.Background(), changed, func(context.Context, Payment, int) (TransferResult, error) {
		t.Fatal("conflicting replay must not invoke transfer")
		return TransferResult{}, nil
	})
	if entries != nil {
		t.Errorf("conflict returned entries: %+v", entries)
	}
	var conflict *BatchConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("error %v is not a BatchConflictError", err)
	}
	if conflict.ExistingFingerprint == conflict.IncomingFingerprint {
		t.Error("conflicting fingerprints should differ")
	}
}

// TestCoordinatorDifferentBatchKeysSharePaymentGate 验证支付级锁跨批次生效:
// 两个不同批次并发提交同一支付时,第二笔转账必须等待第一笔完成,最终只
// 产生一次渠道调用与一条回执。
func TestCoordinatorDifferentBatchKeysSharePaymentGate(t *testing.T) {
	coordinator, store, _ := testCoordinator(t, testEpoch, 4)
	payment := testPayment("global-payment", "source-shared", "benef-shared", CurrencyUSD, 4_400, 0)
	first := testRequest("batch-shared-a", payment)
	second := testRequest("batch-shared-b", payment)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	var calls atomic.Int64
	operation := func(ctx context.Context, item Payment, attempt int) (TransferResult, error) {
		calls.Add(1)
		entered <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return TransferResult{}, ctx.Err()
		}
		return TransferResult{ProviderToken: fmt.Sprintf("token-%d", attempt), Route: "shared", CommittedAt: testEpoch}, nil
	}
	var group sync.WaitGroup
	results := make([][]BatchEntry, 2)
	errs := make([]error, 2)
	group.Add(2)
	go func() {
		defer group.Done()
		results[0], errs[0] = coordinator.Reconcile(context.Background(), first, operation)
	}()
	go func() {
		defer group.Done()
		results[1], errs[1] = coordinator.Reconcile(context.Background(), second, operation)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("first transfer did not enter")
	}
	select {
	case <-entered:
		t.Fatal("second transfer crossed the per-payment gate")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	group.Wait()
	for index, err := range errs {
		if err != nil {
			t.Errorf("batch %d: %v", index, err)
		}
		if !results[index][0].Successful() {
			t.Errorf("batch %d failed: %+v", index, results[index])
		}
	}
	if calls.Load() != 1 {
		t.Errorf("transfer calls %d, want 1", calls.Load())
	}
	if store.Count() != 1 {
		t.Errorf("receipt count %d, want 1", store.Count())
	}
}
