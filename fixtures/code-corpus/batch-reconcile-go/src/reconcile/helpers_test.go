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

var testEpoch = time.Date(2028, 4, 17, 10, 30, 0, 0, time.UTC)

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

func testRequest(key string, payments ...Payment) CommitRequest {
	return CommitRequest{
		IdempotencyKey:  key,
		Payments:        payments,
		MaximumAttempts: 4,
		RequestedAt:     testEpoch,
		Deadline:        testEpoch.Add(10 * time.Minute),
	}
}

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

func transientError(code string) error {
	return &ClassifiedTransferError{
		Kind:      FailureTransient,
		Retryable: true,
		Code:      code,
		Cause:     errors.New("temporary provider outage"),
	}
}

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

type recordingTransfer struct {
	mu        sync.Mutex
	attempts  map[string]int
	failUntil map[string]int
	entered   chan string
	release   <-chan struct{}
}

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

func (transfer *recordingTransfer) count(identity string) int {
	transfer.mu.Lock()
	defer transfer.mu.Unlock()
	return transfer.attempts[identity]
}
