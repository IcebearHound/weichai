package reconcile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"
)

type TransferOperation func(context.Context, Payment, int) (TransferResult, error)

type CoordinatorConfig struct {
	WorkerLimit    int
	AttemptTimeout time.Duration
	Clock          func() time.Time
	RetryPolicy    *RetryPolicy
}

type batchFlight struct {
	fingerprint string
	done        chan struct{}
	entries     []BatchEntry
	failure     error
}

type BatchCommitCoordinator struct {
	receipts ReceiptStore
	archive  *BatchArchive
	config   CoordinatorConfig

	mu           sync.Mutex
	flights      map[string]*batchFlight
	paymentLocks map[string]*paymentGate
	metrics      CoordinatorMetrics
}

type paymentGate struct {
	lock       sync.Mutex
	references int
}

type CoordinatorMetrics struct {
	BatchesStarted     uint64
	BatchesJoined      uint64
	BatchesReplayed    uint64
	BatchConflicts     uint64
	PaymentsAttempted  uint64
	PaymentsReused     uint64
	TransfersSucceeded uint64
	TransfersFailed    uint64
	RetriesScheduled   uint64
	ActiveBatches      int
	ActivePaymentGates int
}

func NewBatchCommitCoordinator(receipts ReceiptStore, archive *BatchArchive, config CoordinatorConfig) (*BatchCommitCoordinator, error) {
	if receipts == nil {
		return nil, errors.New("receipt store is required")
	}
	if archive == nil {
		return nil, errors.New("batch archive is required")
	}
	if config.WorkerLimit < 1 || config.WorkerLimit > 256 {
		return nil, errors.New("worker limit must be between one and 256")
	}
	if config.AttemptTimeout <= 0 {
		return nil, errors.New("attempt timeout must be positive")
	}
	if config.Clock == nil {
		config.Clock = time.Now
	}
	if config.RetryPolicy == nil {
		policy, _ := NewRetryPolicy(time.Millisecond, 50*time.Millisecond, 2, 0, 1)
		config.RetryPolicy = policy
	}
	return &BatchCommitCoordinator{
		receipts:     receipts,
		archive:      archive,
		config:       config,
		flights:      make(map[string]*batchFlight),
		paymentLocks: make(map[string]*paymentGate),
	}, nil
}

func (coordinator *BatchCommitCoordinator) Reconcile(
	ctx context.Context,
	request CommitRequest,
	transfer TransferOperation,
) ([]BatchEntry, error) {
	if transfer == nil {
		return nil, errors.New("transfer operation is required")
	}
	if err := request.Validate(); err != nil {
		return invalidEntries(request.Payments, err), err
	}
	fingerprint := request.Fingerprint()
	if archived, exists := coordinator.archive.Get(request.IdempotencyKey); exists {
		if archived.Fingerprint != fingerprint {
			coordinator.incrementConflict()
			return nil, &BatchConflictError{
				Key:                 request.IdempotencyKey,
				ExistingFingerprint: archived.Fingerprint,
				IncomingFingerprint: fingerprint,
			}
		}
		coordinator.incrementReplay()
		return cloneEntries(archived.Entries), nil
	}

	flight, leader, err := coordinator.joinOrCreateFlight(request.IdempotencyKey, fingerprint)
	if err != nil {
		return nil, err
	}
	if !leader {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
			return cloneEntries(flight.entries), flight.failure
		}
	}

	started := coordinator.config.Clock().UTC()
	entries, executeErr := coordinator.executeBatch(ctx, request, transfer)
	finished := coordinator.config.Clock().UTC()
	if executeErr == nil {
		archived, archiveErr := coordinator.archive.Put(ArchivedBatch{
			Key:         request.IdempotencyKey,
			Fingerprint: fingerprint,
			Entries:     entries,
			StartedAt:   started,
			FinishedAt:  finished,
		})
		if archiveErr != nil {
			executeErr = archiveErr
		} else {
			entries = archived.Entries
		}
	}
	coordinator.completeFlight(request.IdempotencyKey, flight, entries, executeErr)
	return cloneEntries(entries), executeErr
}

func (coordinator *BatchCommitCoordinator) executeBatch(
	ctx context.Context,
	request CommitRequest,
	transfer TransferOperation,
) ([]BatchEntry, error) {
	entries := make([]BatchEntry, len(request.Payments))
	semaphore := make(chan struct{}, coordinator.config.WorkerLimit)
	var workers sync.WaitGroup
	for position, payment := range request.Payments {
		position := position
		payment := payment
		workers.Add(1)
		go func() {
			defer workers.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				entries[position] = failedEntry(position, payment.Identity, 0, ClassifyTransferError(ctx.Err()))
				return
			}
			entries[position] = coordinator.commitPayment(ctx, request, position, payment, transfer)
		}()
	}
	workers.Wait()
	return entries, nil
}

func (coordinator *BatchCommitCoordinator) commitPayment(
	ctx context.Context,
	request CommitRequest,
	position int,
	payment Payment,
	transfer TransferOperation,
) BatchEntry {
	gate := coordinator.acquirePaymentGate(payment.Identity)
	gate.lock.Lock()
	defer func() {
		gate.lock.Unlock()
		coordinator.releasePaymentGate(payment.Identity, gate)
	}()

	prior, exists, lookupErr := coordinator.receipts.FindByPayment(payment.Identity)
	if lookupErr != nil {
		return failedEntry(position, payment.Identity, 0, &CommitFailure{
			Kind:    FailurePermanent,
			Message: "receipt lookup failed",
			Cause:   lookupErr,
		})
	}
	if exists {
		if prior.Account != payment.Account || prior.Beneficiary != payment.Beneficiary || prior.Amount != payment.Amount {
			return failedEntry(position, payment.Identity, 0, &CommitFailure{
				Kind:    FailureConflict,
				Message: "payment identity already names different transfer details",
			})
		}
		coordinator.mu.Lock()
		coordinator.metrics.PaymentsReused++
		coordinator.mu.Unlock()
		copyReceipt := prior
		return BatchEntry{Position: position, PaymentID: payment.Identity, Receipt: &copyReceipt}
	}

	var lastFailure *CommitFailure
	for attempt := 1; attempt <= request.MaximumAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			lastFailure = ClassifyTransferError(err)
			return failedEntry(position, payment.Identity, attempt-1, lastFailure)
		}
		if !request.Deadline.IsZero() && !coordinator.config.Clock().Before(request.Deadline) {
			lastFailure = &CommitFailure{Kind: FailureTimeout, Message: "batch deadline elapsed", Retryable: false}
			return failedEntry(position, payment.Identity, attempt-1, lastFailure)
		}

		coordinator.mu.Lock()
		coordinator.metrics.PaymentsAttempted++
		coordinator.mu.Unlock()
		attemptContext, cancel := context.WithTimeout(ctx, coordinator.config.AttemptTimeout)
		result, transferErr := transfer(attemptContext, payment, attempt)
		cancel()
		if transferErr == nil {
			receipt := coordinator.makeReceipt(request.IdempotencyKey, payment, attempt, result)
			stored, _, saveErr := coordinator.receipts.Save(receipt)
			if saveErr != nil {
				lastFailure = &CommitFailure{Kind: FailurePermanent, Message: "receipt persistence failed", Cause: saveErr}
				coordinator.mu.Lock()
				coordinator.metrics.TransfersFailed++
				coordinator.mu.Unlock()
				return failedEntry(position, payment.Identity, attempt, lastFailure)
			}
			coordinator.mu.Lock()
			coordinator.metrics.TransfersSucceeded++
			coordinator.mu.Unlock()
			copyReceipt := stored
			return BatchEntry{Position: position, PaymentID: payment.Identity, Receipt: &copyReceipt, Attempts: attempt}
		}

		lastFailure = ClassifyTransferError(transferErr)
		coordinator.mu.Lock()
		coordinator.metrics.TransfersFailed++
		coordinator.mu.Unlock()
		decision := coordinator.config.RetryPolicy.Decide(attempt, request.MaximumAttempts, lastFailure)
		if decision.Stop {
			return failedEntry(position, payment.Identity, attempt, lastFailure)
		}
		coordinator.mu.Lock()
		coordinator.metrics.RetriesScheduled++
		coordinator.mu.Unlock()
		if waitErr := WaitForRetry(ctx, decision.Delay); waitErr != nil {
			return failedEntry(position, payment.Identity, attempt, ClassifyTransferError(waitErr))
		}
	}
	if lastFailure == nil {
		lastFailure = &CommitFailure{Kind: FailureRetryBudget, Message: "payment exhausted its retry budget"}
	}
	return failedEntry(position, payment.Identity, request.MaximumAttempts, lastFailure)
}

func (coordinator *BatchCommitCoordinator) makeReceipt(batchKey string, payment Payment, attempt int, result TransferResult) Receipt {
	committedAt := result.CommittedAt.UTC()
	if committedAt.IsZero() {
		committedAt = coordinator.config.Clock().UTC()
	}
	evidence := sha256.New()
	writeFingerprintPart(evidence, batchKey)
	writeFingerprintPart(evidence, payment.Fingerprint())
	writeFingerprintPart(evidence, result.ProviderToken)
	writeFingerprintPart(evidence, result.Route)
	writeFingerprintPart(evidence, committedAt.Format(time.RFC3339Nano))
	digest := hex.EncodeToString(evidence.Sum(nil))
	identityMaterial := sha256.Sum256([]byte(batchKey + "\x00" + payment.Identity + "\x00" + result.ProviderToken))
	return Receipt{
		ReceiptID:      "rcpt_" + hex.EncodeToString(identityMaterial[:12]),
		PaymentID:      payment.Identity,
		BatchKey:       batchKey,
		Account:        payment.Account,
		Beneficiary:    payment.Beneficiary,
		Amount:         payment.Amount,
		Route:          result.Route,
		ProviderToken:  result.ProviderToken,
		Attempt:        attempt,
		CommittedAt:    committedAt,
		EvidenceDigest: digest,
	}
}

func (coordinator *BatchCommitCoordinator) joinOrCreateFlight(key, fingerprint string) (*batchFlight, bool, error) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if running, exists := coordinator.flights[key]; exists {
		if running.fingerprint != fingerprint {
			coordinator.metrics.BatchConflicts++
			return nil, false, &BatchConflictError{
				Key:                 key,
				ExistingFingerprint: running.fingerprint,
				IncomingFingerprint: fingerprint,
			}
		}
		coordinator.metrics.BatchesJoined++
		return running, false, nil
	}
	created := &batchFlight{fingerprint: fingerprint, done: make(chan struct{})}
	coordinator.flights[key] = created
	coordinator.metrics.BatchesStarted++
	coordinator.metrics.ActiveBatches++
	return created, true, nil
}

func (coordinator *BatchCommitCoordinator) completeFlight(key string, flight *batchFlight, entries []BatchEntry, failure error) {
	coordinator.mu.Lock()
	flight.entries = cloneEntries(entries)
	flight.failure = failure
	if coordinator.flights[key] == flight {
		delete(coordinator.flights, key)
	}
	coordinator.metrics.ActiveBatches--
	close(flight.done)
	coordinator.mu.Unlock()
}

func (coordinator *BatchCommitCoordinator) acquirePaymentGate(identity string) *paymentGate {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	gate := coordinator.paymentLocks[identity]
	if gate == nil {
		gate = &paymentGate{}
		coordinator.paymentLocks[identity] = gate
	}
	gate.references++
	coordinator.metrics.ActivePaymentGates = len(coordinator.paymentLocks)
	return gate
}

func (coordinator *BatchCommitCoordinator) releasePaymentGate(identity string, gate *paymentGate) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	gate.references--
	if gate.references == 0 && coordinator.paymentLocks[identity] == gate {
		delete(coordinator.paymentLocks, identity)
	}
	coordinator.metrics.ActivePaymentGates = len(coordinator.paymentLocks)
}

func (coordinator *BatchCommitCoordinator) Metrics() CoordinatorMetrics {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	return coordinator.metrics
}

func (coordinator *BatchCommitCoordinator) incrementReplay() {
	coordinator.mu.Lock()
	coordinator.metrics.BatchesReplayed++
	coordinator.mu.Unlock()
}

func (coordinator *BatchCommitCoordinator) incrementConflict() {
	coordinator.mu.Lock()
	coordinator.metrics.BatchConflicts++
	coordinator.mu.Unlock()
}

func invalidEntries(payments []Payment, validation error) []BatchEntry {
	entries := make([]BatchEntry, len(payments))
	for position, payment := range payments {
		entries[position] = failedEntry(position, payment.Identity, 0, &CommitFailure{
			Kind:    FailureInvalid,
			Message: "batch validation failed at payment " + strconv.Itoa(position),
			Cause:   validation,
		})
	}
	return entries
}

func failedEntry(position int, paymentID string, attempts int, failure *CommitFailure) BatchEntry {
	if failure == nil {
		failure = &CommitFailure{Kind: FailurePermanent, Message: "unknown transfer failure"}
	}
	return BatchEntry{Position: position, PaymentID: paymentID, Attempts: attempts, Failure: failure}
}

func FormatBatchFailure(entries []BatchEntry) error {
	failed := 0
	first := ""
	for _, entry := range entries {
		if entry.Successful() {
			continue
		}
		failed++
		if first == "" && entry.Failure != nil {
			first = entry.Failure.Error()
		}
	}
	if failed == 0 {
		return nil
	}
	return fmt.Errorf("%d of %d payments failed; first failure: %s", failed, len(entries), first)
}
