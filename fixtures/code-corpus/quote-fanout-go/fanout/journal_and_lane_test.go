package fanout

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func startJournalBatcher(t *testing.T, writer JournalWriter, clock Clock, policy JournalPolicy) (*JournalBatcher, <-chan error) {
	t.Helper()
	batcher, err := NewJournalBatcher(writer, clock, policy)
	requireNoError(t, err)
	finished := make(chan error, 1)
	go func() {
		finished <- batcher.Run(context.Background())
	}()
	return batcher, finished
}

func defaultJournalPolicy() JournalPolicy {
	return JournalPolicy{
		MaximumBatch:   3,
		MaximumPending: 12,
		FlushEvery:     time.Hour,
		WriteTimeout:   time.Second,
	}
}

func TestJournalBatcherFlushesAtThresholdInChronologicalOrder(t *testing.T) {
	clock := newManualClock()
	writer := &recordingJournal{}
	batcher, finished := startJournalBatcher(t, writer, clock, defaultJournalPolicy())
	entries := []JournalEntry{
		sampleJournal(clock, "event-late", 3*time.Second),
		sampleJournal(clock, "event-early", time.Second),
		sampleJournal(clock, "event-middle", 2*time.Second),
	}
	for _, entry := range entries {
		requireNoError(t, batcher.Append(context.Background(), entry))
	}
	waitFor(t, "threshold journal write", func() bool { return len(writer.Batches()) == 1 })
	batches := writer.Batches()
	requireEqual(t, len(batches[0]), 3)
	identifiers := []string{batches[0][0].ID, batches[0][1].ID, batches[0][2].ID}
	expected := []string{"event-early", "event-middle", "event-late"}
	for index := range expected {
		requireEqual(t, identifiers[index], expected[index])
	}
	requireEqual(t, batcher.Pending(), 0)
	requireNoError(t, batcher.Close(context.Background()))
	requireNoError(t, <-finished)
	requireErrorIs(t, batcher.Append(context.Background(), sampleJournal(clock, "after-close", 4*time.Second)), ErrBatcherClosed)
}

func TestJournalBatcherDrainWritesEveryPendingBatch(t *testing.T) {
	clock := newManualClock()
	writer := &recordingJournal{}
	policy := defaultJournalPolicy()
	policy.MaximumBatch = 4
	policy.MaximumPending = 20
	batcher, finished := startJournalBatcher(t, writer, clock, policy)
	for index := 0; index < 11; index++ {
		identifier := fmt.Sprintf("entry-%02d", index)
		entry := sampleJournal(clock, identifier, time.Duration(index)*time.Millisecond)
		requireNoError(t, batcher.Append(context.Background(), entry))
	}
	written, err := batcher.Drain(context.Background())
	requireNoError(t, err)
	if written < 3 || written > 11 {
		t.Fatalf("drain should report pending remainder after automatic writes, got %d", written)
	}
	requireEqual(t, batcher.Pending(), 0)
	batches := writer.Batches()
	requireEqual(t, len(batches), 3)
	all := make([]string, 0, 11)
	for _, batch := range batches {
		if len(batch) == 0 || len(batch) > policy.MaximumBatch {
			t.Fatalf("invalid batch width: %d", len(batch))
		}
		for _, entry := range batch {
			all = append(all, entry.ID)
		}
	}
	requireEqual(t, len(all), 11)
	for index, identifier := range all {
		requireEqual(t, identifier, fmt.Sprintf("entry-%02d", index))
	}
	requireNoError(t, batcher.Close(context.Background()))
	requireNoError(t, <-finished)
}

func TestJournalBatcherRetainsEntriesAfterWriterFailure(t *testing.T) {
	clock := newManualClock()
	writer := &recordingJournal{failures: []error{errors.New("disk temporarily read-only"), nil}}
	policy := defaultJournalPolicy()
	policy.MaximumBatch = 2
	batcher, finished := startJournalBatcher(t, writer, clock, policy)
	requireNoError(t, batcher.Append(context.Background(), sampleJournal(clock, "retain-a", time.Millisecond)))
	requireNoError(t, batcher.Append(context.Background(), sampleJournal(clock, "retain-b", 2*time.Millisecond)))
	waitFor(t, "failed write to leave entries pending", func() bool { return batcher.Pending() == 2 })
	written, err := batcher.Drain(context.Background())
	requireNoError(t, err)
	requireEqual(t, written, 2)
	requireEqual(t, batcher.Pending(), 0)
	batches := writer.Batches()
	requireEqual(t, len(batches), 1)
	requireEqual(t, batches[0][0].ID, "retain-a")
	requireEqual(t, batches[0][1].ID, "retain-b")
	requireNoError(t, batcher.Close(context.Background()))
	requireNoError(t, <-finished)
}

func TestJournalBatcherTimerFlushesQuietTraffic(t *testing.T) {
	clock := newManualClock()
	writer := &recordingJournal{}
	policy := defaultJournalPolicy()
	policy.MaximumBatch = 10
	policy.FlushEvery = 15 * time.Millisecond
	batcher, finished := startJournalBatcher(t, writer, clock, policy)
	requireNoError(t, batcher.Append(context.Background(), sampleJournal(clock, "quiet-entry", time.Millisecond)))
	waitFor(t, "periodic journal flush", func() bool { return len(writer.Batches()) == 1 })
	requireEqual(t, writer.Batches()[0][0].ID, "quiet-entry")
	requireEqual(t, batcher.Pending(), 0)
	requireNoError(t, batcher.Close(context.Background()))
	requireNoError(t, <-finished)
}

func TestJournalBatcherCloseWaitsForInFlightWriteAndFlushesRemainder(t *testing.T) {
	clock := newManualClock()
	writeStarted := make(chan struct{})
	releaseWrite := make(chan struct{})
	writer := &recordingJournal{started: writeStarted, wait: releaseWrite}
	policy := defaultJournalPolicy()
	policy.MaximumBatch = 2
	batcher, finished := startJournalBatcher(t, writer, clock, policy)
	requireNoError(t, batcher.Append(context.Background(), sampleJournal(clock, "shutdown-a", time.Millisecond)))
	requireNoError(t, batcher.Append(context.Background(), sampleJournal(clock, "shutdown-b", 2*time.Millisecond)))
	select {
	case <-writeStarted:
	case <-time.After(time.Second):
		t.Fatal("threshold write did not start")
	}
	closeResult := make(chan error, 1)
	go func() {
		closeResult <- batcher.Close(context.Background())
	}()
	select {
	case err := <-closeResult:
		t.Fatalf("close returned before in-flight write finished: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseWrite)
	requireNoError(t, <-closeResult)
	requireNoError(t, <-finished)
	batches := writer.Batches()
	requireEqual(t, len(batches), 1)
	requireEqual(t, len(batches[0]), 2)
}

func TestJournalBatcherAcceptsConcurrentProducersWithoutLosingEntries(t *testing.T) {
	clock := newManualClock()
	writer := &recordingJournal{}
	policy := defaultJournalPolicy()
	policy.MaximumBatch = 13
	policy.MaximumPending = 200
	batcher, finished := startJournalBatcher(t, writer, clock, policy)
	const producers = 8
	const perProducer = 17
	var group sync.WaitGroup
	failures := make(chan error, producers*perProducer)
	for producer := 0; producer < producers; producer++ {
		producer := producer
		group.Add(1)
		go func() {
			defer group.Done()
			for sequence := 0; sequence < perProducer; sequence++ {
				identifier := fmt.Sprintf("producer-%02d-event-%02d", producer, sequence)
				offset := time.Duration(producer*perProducer+sequence) * time.Microsecond
				if err := batcher.Append(context.Background(), sampleJournal(clock, identifier, offset)); err != nil {
					failures <- err
				}
			}
		}()
	}
	group.Wait()
	close(failures)
	for failure := range failures {
		t.Errorf("concurrent append failed: %v", failure)
	}
	_, err := batcher.Drain(context.Background())
	requireNoError(t, err)
	requireNoError(t, batcher.Close(context.Background()))
	requireNoError(t, <-finished)
	seen := make(map[string]struct{})
	for _, batch := range writer.Batches() {
		for _, entry := range batch {
			if _, duplicate := seen[entry.ID]; duplicate {
				t.Errorf("entry written twice: %s", entry.ID)
			}
			seen[entry.ID] = struct{}{}
		}
	}
	requireEqual(t, len(seen), producers*perProducer)
}

func TestJournalBatcherRejectsDuplicateAndMalformedEntries(t *testing.T) {
	clock := newManualClock()
	writer := &recordingJournal{}
	batcher, finished := startJournalBatcher(t, writer, clock, defaultJournalPolicy())
	entry := sampleJournal(clock, "duplicate-id", time.Millisecond)
	requireNoError(t, batcher.Append(context.Background(), entry))
	err := batcher.Append(context.Background(), entry)
	if err == nil || !strings.Contains(err.Error(), "duplicate journal entry") {
		t.Fatalf("expected duplicate rejection, got %v", err)
	}
	malformed := []JournalEntry{
		{Kind: "kind", OccurredAt: clock.Now(), CorrelationID: "corr"},
		{ID: "id", OccurredAt: clock.Now(), CorrelationID: "corr"},
		{ID: "id", Kind: "kind", CorrelationID: "corr"},
		{ID: "id", Kind: "kind", OccurredAt: clock.Now()},
		{ID: "id", Kind: "kind", OccurredAt: clock.Now().Add(2 * time.Minute), CorrelationID: "corr"},
	}
	for index, candidate := range malformed {
		if err := batcher.Append(context.Background(), candidate); err == nil {
			t.Errorf("malformed entry %d was accepted", index)
		}
	}
	requireNoError(t, batcher.Close(context.Background()))
	requireNoError(t, <-finished)
}

func TestJournalEntryCanonicalRepresentationIsStableAndEscaped(t *testing.T) {
	clock := newManualClock()
	entry := sampleJournal(clock, "canonical|id", time.Second)
	entry.CorrelationID = "corr=with|syntax"
	entry.Fields = map[string]string{
		"zeta":    "line-one\nline-two",
		"alpha":   "left=right",
		"slashes": `a\b`,
	}
	canonical, err := entry.Canonical()
	requireNoError(t, err)
	expectedFragments := []string{
		`id=canonical\|id`,
		`correlation=corr\=with\|syntax`,
		`field.alpha=left\=right`,
		`field.slashes=a\\b`,
		`field.zeta=line-one\nline-two`,
	}
	for _, fragment := range expectedFragments {
		if !strings.Contains(canonical, fragment) {
			t.Errorf("canonical text lacks %q: %s", fragment, canonical)
		}
	}
	if strings.Index(canonical, "field.alpha") > strings.Index(canonical, "field.zeta") {
		t.Fatal("canonical fields are not sorted")
	}
}

func accountMessage(clock Clock, id, account string, sequence uint64) (AccountMessage, *atomic.Int32, *atomic.Int32) {
	acknowledgements := &atomic.Int32{}
	rejections := &atomic.Int32{}
	message := AccountMessage{
		MessageID:  id,
		EventID:    "event-" + id,
		AccountID:  account,
		Sequence:   sequence,
		Delivery:   1,
		ReceivedAt: clock.Now(),
		Payload:    []byte(`{"kind":"trade-booked"}`),
		Acknowledge: func(context.Context) error {
			acknowledgements.Add(1)
			return nil
		},
		RejectDelivery: func(context.Context, error) error {
			rejections.Add(1)
			return nil
		},
	}
	return message, acknowledgements, rejections
}

func newLaneWorker(t *testing.T, clock Clock) *AccountLaneWorker {
	t.Helper()
	worker, err := NewAccountLaneWorker(clock, AccountLanePolicy{
		MaximumDelivery: 5,
		MaximumPayload:  16 * 1024,
		DedupeFor:       time.Hour,
		IdleLaneFor:     10 * time.Minute,
	})
	requireNoError(t, err)
	return worker
}

func TestAccountLaneWorkerProcessesAnAccountInSequence(t *testing.T) {
	clock := newManualClock()
	worker := newLaneWorker(t, clock)
	processed := make([]uint64, 0, 3)
	var mu sync.Mutex
	for sequence := uint64(0); sequence < 3; sequence++ {
		message, acknowledgements, rejections := accountMessage(clock, fmt.Sprintf("ordered-%d", sequence), "account-a", sequence)
		err := worker.Accept(context.Background(), message, func(ctx context.Context, received AccountMessage) error {
			mu.Lock()
			processed = append(processed, received.Sequence)
			mu.Unlock()
			return nil
		})
		requireNoError(t, err)
		requireEqual(t, acknowledgements.Load(), int32(1))
		requireEqual(t, rejections.Load(), int32(0))
	}
	for index, sequence := range processed {
		requireEqual(t, sequence, uint64(index))
	}
	view := worker.Snapshot()[0]
	requireEqual(t, view.AccountID, "account-a")
	requireEqual(t, view.LastSequence, uint64(2))
	if !view.HasSequence || view.Running {
		t.Fatalf("unexpected lane view: %#v", view)
	}
}

func TestAccountLaneWorkerRejectsGapWithoutAcknowledging(t *testing.T) {
	clock := newManualClock()
	worker := newLaneWorker(t, clock)
	first, firstAck, _ := accountMessage(clock, "gap-first", "account-gap", 0)
	requireNoError(t, worker.Accept(context.Background(), first, func(context.Context, AccountMessage) error { return nil }))
	requireEqual(t, firstAck.Load(), int32(1))
	gap, gapAck, gapReject := accountMessage(clock, "gap-third", "account-gap", 2)
	err := worker.Accept(context.Background(), gap, func(context.Context, AccountMessage) error {
		t.Fatal("gap message should not reach handler")
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "sequence gap") {
		t.Fatalf("expected sequence gap error, got %v", err)
	}
	requireEqual(t, gapAck.Load(), int32(0))
	requireEqual(t, gapReject.Load(), int32(1))
	view := worker.Snapshot()[0]
	requireEqual(t, view.LastSequence, uint64(0))
	requireEqual(t, view.Failures, uint64(1))
}

func TestAccountLaneWorkerDoesNotAcknowledgeHandlerFailureAndAllowsRetry(t *testing.T) {
	clock := newManualClock()
	worker := newLaneWorker(t, clock)
	message, acknowledgements, rejections := accountMessage(clock, "retry-message", "account-retry", 0)
	err := worker.Accept(context.Background(), message, func(context.Context, AccountMessage) error {
		return errors.New("ledger lock unavailable")
	})
	if err == nil || !strings.Contains(err.Error(), "ledger lock unavailable") {
		t.Fatalf("expected handler cause, got %v", err)
	}
	requireEqual(t, acknowledgements.Load(), int32(0))
	requireEqual(t, rejections.Load(), int32(1))
	message.Delivery = 2
	err = worker.Accept(context.Background(), message, func(context.Context, AccountMessage) error { return nil })
	requireNoError(t, err)
	requireEqual(t, acknowledgements.Load(), int32(1))
	requireEqual(t, rejections.Load(), int32(1))
	view := worker.Snapshot()[0]
	requireEqual(t, view.LastSequence, uint64(0))
	requireEqual(t, view.Failures, uint64(0))
}

func TestAccountLaneWorkerAcknowledgesDuplicateWithoutRunningHandler(t *testing.T) {
	clock := newManualClock()
	worker := newLaneWorker(t, clock)
	message, acknowledgements, rejections := accountMessage(clock, "dedupe-message", "account-dedupe", 0)
	handled := 0
	handler := func(context.Context, AccountMessage) error {
		handled++
		return nil
	}
	requireNoError(t, worker.Accept(context.Background(), message, handler))
	err := worker.Accept(context.Background(), message, handler)
	requireErrorIs(t, err, ErrDuplicateMessage)
	requireEqual(t, handled, 1)
	requireEqual(t, acknowledgements.Load(), int32(2))
	requireEqual(t, rejections.Load(), int32(0))
	message.AccountID = "different-account"
	err = worker.Accept(context.Background(), message, handler)
	if err == nil || !strings.Contains(err.Error(), "reused") {
		t.Fatalf("identifier reuse with changed account should fail, got %v", err)
	}
}

func TestAccountLaneWorkerAllowsDifferentAccountsToRunInParallel(t *testing.T) {
	clock := newManualClock()
	worker := newLaneWorker(t, clock)
	release := make(chan struct{})
	started := make(chan string, 2)
	var active atomic.Int32
	var maximum atomic.Int32
	handler := func(ctx context.Context, message AccountMessage) error {
		current := active.Add(1)
		for {
			prior := maximum.Load()
			if current <= prior || maximum.CompareAndSwap(prior, current) {
				break
			}
		}
		started <- message.AccountID
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-release:
		}
		active.Add(-1)
		return nil
	}
	accounts := []string{"account-parallel-a", "account-parallel-b"}
	results := make(chan error, len(accounts))
	for index, account := range accounts {
		message, _, _ := accountMessage(clock, fmt.Sprintf("parallel-%d", index), account, 0)
		go func(message AccountMessage) {
			results <- worker.Accept(context.Background(), message, handler)
		}(message)
	}
	observed := []string{<-started, <-started}
	sort.Strings(observed)
	if observed[0] != accounts[0] || observed[1] != accounts[1] {
		t.Fatalf("unexpected accounts started: %v", observed)
	}
	close(release)
	for range accounts {
		requireNoError(t, <-results)
	}
	requireEqual(t, maximum.Load(), int32(2))
}

func TestAccountLaneWorkerSerializesConcurrentMessagesForOneAccount(t *testing.T) {
	clock := newManualClock()
	worker := newLaneWorker(t, clock)
	firstRelease := make(chan struct{})
	firstStarted := make(chan struct{})
	var invocationMu sync.Mutex
	invocations := make([]uint64, 0, 2)
	handler := func(ctx context.Context, message AccountMessage) error {
		invocationMu.Lock()
		invocations = append(invocations, message.Sequence)
		invocationMu.Unlock()
		if message.Sequence == 0 {
			close(firstStarted)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-firstRelease:
			}
		}
		return nil
	}
	first, _, _ := accountMessage(clock, "serial-zero", "account-serial", 0)
	second, _, _ := accountMessage(clock, "serial-one", "account-serial", 1)
	results := make(chan error, 2)
	go func() { results <- worker.Accept(context.Background(), first, handler) }()
	<-firstStarted
	go func() { results <- worker.Accept(context.Background(), second, handler) }()
	time.Sleep(15 * time.Millisecond)
	invocationMu.Lock()
	beforeRelease := append([]uint64(nil), invocations...)
	invocationMu.Unlock()
	if len(beforeRelease) != 1 || beforeRelease[0] != 0 {
		t.Fatalf("second same-account handler ran early: %v", beforeRelease)
	}
	close(firstRelease)
	requireNoError(t, <-results)
	requireNoError(t, <-results)
	invocationMu.Lock()
	defer invocationMu.Unlock()
	if len(invocations) != 2 || invocations[0] != 0 || invocations[1] != 1 {
		t.Fatalf("same-account order changed: %v", invocations)
	}
}

func TestAccountLaneWorkerRejectsExhaustedDelivery(t *testing.T) {
	clock := newManualClock()
	worker := newLaneWorker(t, clock)
	message, acknowledgements, rejections := accountMessage(clock, "poison-message", "account-poison", 0)
	message.Delivery = 6
	err := worker.Accept(context.Background(), message, func(context.Context, AccountMessage) error {
		t.Fatal("exhausted delivery should not reach handler")
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "exceeds maximum") {
		t.Fatalf("unexpected exhausted delivery error: %v", err)
	}
	requireEqual(t, acknowledgements.Load(), int32(0))
	requireEqual(t, rejections.Load(), int32(1))
}

func TestAccountLaneWorkerPrunesExpiredDedupeRecordsAndIdleLanes(t *testing.T) {
	clock := newManualClock()
	worker := newLaneWorker(t, clock)
	message, _, _ := accountMessage(clock, "prunable", "account-idle", 0)
	requireNoError(t, worker.Accept(context.Background(), message, func(context.Context, AccountMessage) error { return nil }))
	removedMessages, removedLanes := worker.Prune()
	requireEqual(t, removedMessages, 0)
	requireEqual(t, removedLanes, 0)
	clock.Advance(2 * time.Hour)
	removedMessages, removedLanes = worker.Prune()
	requireEqual(t, removedMessages, 1)
	requireEqual(t, removedLanes, 1)
	requireEqual(t, len(worker.Snapshot()), 0)
}

func TestAccountLaneWorkerValidatesMessageEnvelope(t *testing.T) {
	clock := newManualClock()
	worker := newLaneWorker(t, clock)
	valid, _, _ := accountMessage(clock, "valid-envelope", "account-envelope", 0)
	cases := []struct {
		name   string
		change func(*AccountMessage)
	}{
		{name: "message id missing", change: func(message *AccountMessage) { message.MessageID = "" }},
		{name: "event id missing", change: func(message *AccountMessage) { message.EventID = "" }},
		{name: "account missing", change: func(message *AccountMessage) { message.AccountID = "" }},
		{name: "delivery invalid", change: func(message *AccountMessage) { message.Delivery = 0 }},
		{name: "receive time missing", change: func(message *AccountMessage) { message.ReceivedAt = time.Time{} }},
		{name: "future receive time", change: func(message *AccountMessage) { message.ReceivedAt = clock.Now().Add(2 * time.Minute) }},
		{name: "empty payload", change: func(message *AccountMessage) { message.Payload = nil }},
		{name: "same event id", change: func(message *AccountMessage) { message.EventID = message.MessageID }},
		{name: "ack missing", change: func(message *AccountMessage) { message.Acknowledge = nil }},
		{name: "reject missing", change: func(message *AccountMessage) { message.RejectDelivery = nil }},
	}
	for _, candidate := range cases {
		t.Run(candidate.name, func(t *testing.T) {
			message := valid
			message.Payload = append([]byte(nil), valid.Payload...)
			candidate.change(&message)
			if err := worker.Accept(context.Background(), message, func(context.Context, AccountMessage) error { return nil }); err == nil {
				t.Fatal("expected envelope validation error")
			}
		})
	}
}
