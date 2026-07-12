package reconcile

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCoordinatorRejectsInvalidEnvelopeBeforeSideEffects(t *testing.T) {
	coordinator, store, archive := testCoordinator(t, testEpoch, 2)
	base := testPayment("invalid-envelope", "source", "target", CurrencyUSD, 100, 0)
	tests := []struct {
		name    string
		request CommitRequest
	}{
		{"short key", CommitRequest{IdempotencyKey: "tiny", Payments: []Payment{base}, MaximumAttempts: 1, RequestedAt: testEpoch}},
		{"empty items", CommitRequest{IdempotencyKey: "empty-items-key", Payments: nil, MaximumAttempts: 1, RequestedAt: testEpoch}},
		{"zero attempts", CommitRequest{IdempotencyKey: "zero-attempts-key", Payments: []Payment{base}, MaximumAttempts: 0, RequestedAt: testEpoch}},
		{"bad deadline", CommitRequest{IdempotencyKey: "bad-deadline-key", Payments: []Payment{base}, MaximumAttempts: 1, RequestedAt: testEpoch, Deadline: testEpoch.Add(-time.Second)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int64
			entries, err := coordinator.Reconcile(context.Background(), test.request, successfulTransfer("invalid", &calls))
			if err == nil {
				t.Fatal("invalid request should return an error")
			}
			if len(test.request.Payments) > 0 {
				if len(entries) != len(test.request.Payments) || entries[0].Failure == nil || entries[0].Failure.Kind != FailureInvalid {
					t.Errorf("invalid entries: %+v", entries)
				}
			}
			if calls.Load() != 0 {
				t.Errorf("invalid request invoked transfer %d times", calls.Load())
			}
		})
	}
	if store.Count() != 0 {
		t.Errorf("invalid requests created %d receipts", store.Count())
	}
	if len(archive.Summaries()) != 0 {
		t.Errorf("invalid requests were archived: %+v", archive.Summaries())
	}
}

func TestCoordinatorRequiresOperationAndDependencies(t *testing.T) {
	policy, _ := NewRetryPolicy(0, 0, 1, 0, 1)
	validConfig := CoordinatorConfig{WorkerLimit: 1, AttemptTimeout: time.Second, Clock: func() time.Time { return testEpoch }, RetryPolicy: policy}
	store := NewMemoryReceiptStore()
	archive := NewBatchArchive()
	if coordinator, err := NewBatchCommitCoordinator(nil, archive, validConfig); err == nil || coordinator != nil {
		t.Errorf("nil store coordinator=%+v err=%v", coordinator, err)
	}
	if coordinator, err := NewBatchCommitCoordinator(store, nil, validConfig); err == nil || coordinator != nil {
		t.Errorf("nil archive coordinator=%+v err=%v", coordinator, err)
	}
	for _, workers := range []int{-1, 0, 257} {
		config := validConfig
		config.WorkerLimit = workers
		if coordinator, err := NewBatchCommitCoordinator(store, archive, config); err == nil || coordinator != nil {
			t.Errorf("workers %d coordinator=%+v err=%v", workers, coordinator, err)
		}
	}
	config := validConfig
	config.AttemptTimeout = 0
	if coordinator, err := NewBatchCommitCoordinator(store, archive, config); err == nil || coordinator != nil {
		t.Errorf("zero timeout coordinator=%+v err=%v", coordinator, err)
	}
	coordinator, err := NewBatchCommitCoordinator(store, archive, validConfig)
	if err != nil {
		t.Fatalf("valid coordinator: %v", err)
	}
	request := testRequest("nil-operation-key", testPayment("nil-operation", "source", "target", CurrencyUSD, 100, 0))
	if entries, err := coordinator.Reconcile(context.Background(), request, nil); err == nil || entries != nil {
		t.Errorf("nil operation entries=%+v err=%v", entries, err)
	}
}

func TestCoordinatorAttemptTimeoutCanRetryAndRecover(t *testing.T) {
	policy, _ := NewRetryPolicy(0, 0, 1, 0, 17)
	store := NewMemoryReceiptStore()
	archive := NewBatchArchive()
	coordinator, err := NewBatchCommitCoordinator(store, archive, CoordinatorConfig{
		WorkerLimit:    1,
		AttemptTimeout: 15 * time.Millisecond,
		Clock:          func() time.Time { return testEpoch },
		RetryPolicy:    policy,
	})
	if err != nil {
		t.Fatalf("coordinator: %v", err)
	}
	request := testRequest("attempt-timeout-key", testPayment("attempt-timeout", "source", "target", CurrencyUSD, 500, 0))
	var attempts atomic.Int64
	operation := func(ctx context.Context, payment Payment, attempt int) (TransferResult, error) {
		attempts.Add(1)
		if attempt == 1 {
			<-ctx.Done()
			return TransferResult{}, ctx.Err()
		}
		return TransferResult{ProviderToken: "recovered", Route: "backup", CommittedAt: testEpoch}, nil
	}
	entries, err := coordinator.Reconcile(context.Background(), request, operation)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !entries[0].Successful() || entries[0].Attempts != 2 || entries[0].Receipt.Attempt != 2 {
		t.Errorf("timeout recovery: %+v", entries[0])
	}
	if attempts.Load() != 2 || store.Count() != 1 {
		t.Errorf("attempts=%d receipts=%d", attempts.Load(), store.Count())
	}
}

func TestCoordinatorContextCancellationStopsWaitingJoiner(t *testing.T) {
	coordinator, store, _ := testCoordinator(t, testEpoch, 1)
	request := testRequest("cancel-join-key", testPayment("cancel-join", "source", "target", CurrencyEUR, 700, 0))
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	operation := func(ctx context.Context, payment Payment, attempt int) (TransferResult, error) {
		entered <- struct{}{}
		select {
		case <-release:
			return TransferResult{ProviderToken: "leader", Route: "main", CommittedAt: testEpoch}, nil
		case <-ctx.Done():
			return TransferResult{}, ctx.Err()
		}
	}
	leaderDone := make(chan error, 1)
	go func() {
		_, err := coordinator.Reconcile(context.Background(), request, operation)
		leaderDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("leader did not enter transfer")
	}
	joinContext, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	joined, err := coordinator.Reconcile(joinContext, request, operation)
	if joined != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("cancelled join entries=%+v err=%v", joined, err)
	}
	close(release)
	if err := <-leaderDone; err != nil {
		t.Errorf("leader failed: %v", err)
	}
	if store.Count() != 1 {
		t.Errorf("leader receipt count %d", store.Count())
	}
	if coordinator.Metrics().BatchesJoined != 1 {
		t.Errorf("joined metrics: %+v", coordinator.Metrics())
	}
}

func TestCoordinatorConcurrentConflictingFlightFailsImmediately(t *testing.T) {
	coordinator, store, _ := testCoordinator(t, testEpoch, 1)
	original := testRequest("live-conflict-key", testPayment("live-conflict", "source", "target", CurrencyGBP, 1_000, 0))
	changed := original
	changed.Payments = append([]Payment(nil), original.Payments...)
	changed.Payments[0].Amount.Minor = 2_000
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	leaderDone := make(chan error, 1)
	go func() {
		_, err := coordinator.Reconcile(context.Background(), original, func(ctx context.Context, payment Payment, attempt int) (TransferResult, error) {
			entered <- struct{}{}
			select {
			case <-release:
				return TransferResult{ProviderToken: "leader", Route: "main", CommittedAt: testEpoch}, nil
			case <-ctx.Done():
				return TransferResult{}, ctx.Err()
			}
		})
		leaderDone <- err
	}()
	<-entered
	called := false
	entries, err := coordinator.Reconcile(context.Background(), changed, func(context.Context, Payment, int) (TransferResult, error) {
		called = true
		return TransferResult{}, nil
	})
	var conflict *BatchConflictError
	if entries != nil || !errors.As(err, &conflict) || called {
		t.Errorf("live conflict entries=%+v err=%v called=%t", entries, err, called)
	}
	if conflict.Key != original.IdempotencyKey || conflict.ExistingFingerprint == conflict.IncomingFingerprint {
		t.Errorf("conflict details: %+v", conflict)
	}
	close(release)
	if err := <-leaderDone; err != nil {
		t.Errorf("leader: %v", err)
	}
	if store.Count() != 1 {
		t.Errorf("receipt count %d", store.Count())
	}
}

func TestCoordinatorReceiptLookupFailureDoesNotInvokeProvider(t *testing.T) {
	coordinator, store, archive := testCoordinator(t, testEpoch, 1)
	payment := testPayment("lookup-failure", "source", "target", CurrencyCHF, 250, 0)
	request := testRequest("lookup-failure-key", payment)
	store.InjectFailure("find", payment.Identity, errors.New("receipt index unavailable"))
	var calls atomic.Int64
	entries, err := coordinator.Reconcile(context.Background(), request, successfulTransfer("should-not-run", &calls))
	if err != nil {
		t.Fatalf("batch-level error: %v", err)
	}
	if len(entries) != 1 || entries[0].Failure == nil || !strings.Contains(entries[0].Failure.Message, "lookup") {
		t.Fatalf("lookup failure entry: %+v", entries)
	}
	if calls.Load() != 0 || store.Count() != 0 {
		t.Errorf("calls=%d store=%d", calls.Load(), store.Count())
	}
	archived, exists := archive.Get(request.IdempotencyKey)
	if !exists || archived.Entries[0].Failure == nil {
		t.Errorf("failed outcome should be replayable: %+v", archived)
	}
}

func TestCoordinatorReceiptSaveFailureDoesNotRetryTransfer(t *testing.T) {
	coordinator, store, _ := testCoordinator(t, testEpoch, 1)
	payment := testPayment("save-failure", "source", "target", CurrencyCNY, 880, 0)
	request := testRequest("save-failure-key", payment)
	store.InjectFailure("save", payment.Identity, errors.New("journal read-only"))
	var calls atomic.Int64
	entries, err := coordinator.Reconcile(context.Background(), request, successfulTransfer("provider-committed", &calls))
	if err != nil {
		t.Fatalf("batch-level error: %v", err)
	}
	if entries[0].Failure == nil || !strings.Contains(entries[0].Failure.Message, "persistence") || entries[0].Attempts != 1 {
		t.Errorf("save failure entry: %+v", entries[0])
	}
	if calls.Load() != 1 {
		t.Errorf("provider calls %d, want 1", calls.Load())
	}
	if store.Count() != 0 {
		t.Errorf("failed save created receipt")
	}
}

func TestCoordinatorWorkerLimitBoundsParallelTransfers(t *testing.T) {
	coordinator, _, _ := testCoordinator(t, testEpoch, 3)
	payments := make([]Payment, 12)
	for index := range payments {
		payments[index] = testPayment(
			"worker-"+string(rune('a'+index)),
			"source-"+string(rune('a'+index)),
			"target-"+string(rune('a'+index)),
			CurrencyUSD,
			int64(100+index),
			time.Duration(index)*time.Second,
		)
	}
	request := testRequest("worker-limit-key", payments...)
	var active atomic.Int64
	var maximum atomic.Int64
	operation := func(ctx context.Context, payment Payment, attempt int) (TransferResult, error) {
		current := active.Add(1)
		for {
			previous := maximum.Load()
			if current <= previous || maximum.CompareAndSwap(previous, current) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		active.Add(-1)
		return TransferResult{ProviderToken: payment.Identity, Route: "worker-test", CommittedAt: testEpoch}, nil
	}
	entries, err := coordinator.Reconcile(context.Background(), request, operation)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if maximum.Load() > 3 || maximum.Load() < 2 {
		t.Errorf("maximum active transfers %d", maximum.Load())
	}
	for index, entry := range entries {
		if !entry.Successful() || entry.Position != index {
			t.Errorf("entry %d: %+v", index, entry)
		}
	}
}

func TestCoordinatorPaymentGatesAreReleasedAfterCompletion(t *testing.T) {
	coordinator, _, _ := testCoordinator(t, testEpoch, 4)
	for batch := 0; batch < 20; batch++ {
		payment := testPayment(
			"gate-"+string(rune('a'+batch)),
			"gate-source",
			"gate-target-"+string(rune('a'+batch)),
			CurrencyEUR,
			int64(100+batch),
			time.Duration(batch)*time.Second,
		)
		request := testRequest("gate-batch-"+string(rune('a'+batch))+"-key", payment)
		if _, err := coordinator.Reconcile(context.Background(), request, successfulTransfer("gate", nil)); err != nil {
			t.Fatalf("batch %d: %v", batch, err)
		}
	}
	metrics := coordinator.Metrics()
	if metrics.ActivePaymentGates != 0 || metrics.ActiveBatches != 0 {
		t.Errorf("active coordinator state leaked: %+v", metrics)
	}
}

func TestCoordinatorDefaultClockAndRetryPolicyAreUsable(t *testing.T) {
	coordinator, err := NewBatchCommitCoordinator(NewMemoryReceiptStore(), NewBatchArchive(), CoordinatorConfig{
		WorkerLimit:    1,
		AttemptTimeout: time.Second,
	})
	if err != nil {
		t.Fatalf("default configuration: %v", err)
	}
	payment := testPayment("default-config", "source", "target", CurrencyAUD, 250, 0)
	request := testRequest("default-config-key", payment)
	request.Deadline = time.Time{}
	entries, err := coordinator.Reconcile(context.Background(), request, func(_ context.Context, payment Payment, attempt int) (TransferResult, error) {
		return TransferResult{ProviderToken: "default-token", Route: "default-route"}, nil
	})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if entries[0].Receipt == nil || entries[0].Receipt.CommittedAt.IsZero() {
		t.Errorf("default clock did not stamp receipt: %+v", entries[0])
	}
}

func TestCoordinatorArchiveClonePreventsCallerMutation(t *testing.T) {
	coordinator, _, archive := testCoordinator(t, testEpoch, 1)
	request := testRequest("clone-protection-key", testPayment("clone-protection", "source", "target", CurrencyUSD, 100, 0))
	first, err := coordinator.Reconcile(context.Background(), request, successfulTransfer("canonical", nil))
	if err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	canonicalID := first[0].Receipt.ReceiptID
	first[0].Receipt.ReceiptID = "caller-mutated"
	first[0].Failure = &CommitFailure{Kind: FailurePermanent, Message: "caller mutation"}
	replayed, err := coordinator.Reconcile(context.Background(), request, successfulTransfer("unused", nil))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if replayed[0].Receipt.ReceiptID != canonicalID || replayed[0].Failure != nil {
		t.Errorf("archive leaked caller mutation: %+v", replayed[0])
	}
	archived, exists := archive.Get(request.IdempotencyKey)
	if !exists || archived.Entries[0].Receipt.ReceiptID != canonicalID {
		t.Errorf("stored archive mutated: %+v", archived)
	}
}

func TestConcurrentArchiveReadsReturnIndependentCopies(t *testing.T) {
	archive := NewBatchArchive()
	receipt := storedReceipt("archive-concurrent", "archive-concurrent-key", 0)
	_, err := archive.Put(ArchivedBatch{
		Key:         "archive-concurrent-key",
		Fingerprint: strings.Repeat("e", 64),
		Entries:     []BatchEntry{{PaymentID: receipt.PaymentID, Receipt: &receipt}},
		StartedAt:   testEpoch,
		FinishedAt:  testEpoch.Add(time.Second),
	})
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	const readers = 32
	var group sync.WaitGroup
	failures := make(chan string, readers)
	for reader := 0; reader < readers; reader++ {
		reader := reader
		group.Add(1)
		go func() {
			defer group.Done()
			batch, exists := archive.Get("archive-concurrent-key")
			if !exists || len(batch.Entries) != 1 {
				failures <- "missing batch"
				return
			}
			batch.Entries[0].Receipt.ReceiptID = "reader-" + string(rune('a'+reader))
		}()
	}
	group.Wait()
	close(failures)
	if len(failures) != 0 {
		t.Errorf("read failures: %d", len(failures))
	}
	canonical, _ := archive.Get("archive-concurrent-key")
	if canonical.Entries[0].Receipt.ReceiptID != receipt.ReceiptID {
		t.Errorf("concurrent read mutated archive: %+v", canonical)
	}
}
