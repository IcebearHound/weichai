package reconcile

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

func storedReceipt(identity, batch string, offset time.Duration) Receipt {
	return Receipt{
		ReceiptID:      "store-receipt-" + identity,
		PaymentID:      identity,
		BatchKey:       batch,
		Account:        "store-source-" + identity,
		Beneficiary:    "store-target-" + identity,
		Amount:         Money{Currency: CurrencyUSD, Minor: 100 + int64(offset/time.Second)},
		Route:          "store-route",
		ProviderToken:  "store-token-" + identity,
		Attempt:        1,
		CommittedAt:    testEpoch.Add(offset),
		EvidenceDigest: strings.Repeat("d", 64),
	}
}

func TestMemoryReceiptStoreSavesOnceAndListsByCommitTime(t *testing.T) {
	store := NewMemoryReceiptStore()
	receipts := []Receipt{
		storedReceipt("third", "store-batch", 3*time.Second),
		storedReceipt("first", "store-batch", time.Second),
		storedReceipt("second", "store-batch", 2*time.Second),
	}
	for _, receipt := range receipts {
		stored, created, err := store.Save(receipt)
		if err != nil || !created || stored.ReceiptID != receipt.ReceiptID {
			t.Fatalf("save %+v created=%t err=%v", stored, created, err)
		}
	}
	if store.Count() != 3 {
		t.Fatalf("store count %d", store.Count())
	}
	listed, err := store.ListByBatch("store-batch")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(listed) != 3 || listed[0].PaymentID != "first" || listed[1].PaymentID != "second" || listed[2].PaymentID != "third" {
		t.Errorf("list order: %+v", listed)
	}
	prior, created, err := store.Save(receipts[0])
	if err != nil || created || prior.ReceiptID != receipts[0].ReceiptID {
		t.Errorf("idempotent save prior=%+v created=%t err=%v", prior, created, err)
	}
	if store.Count() != 3 {
		t.Error("idempotent save changed store count")
	}
}

func TestMemoryReceiptStoreRejectsIncompatibleDuplicate(t *testing.T) {
	store := NewMemoryReceiptStore()
	original := storedReceipt("duplicate", "batch-original", 0)
	if _, _, err := store.Save(original); err != nil {
		t.Fatalf("save original: %v", err)
	}
	mutations := []func(*Receipt){
		func(receipt *Receipt) { receipt.BatchKey = "batch-changed" },
		func(receipt *Receipt) { receipt.Account = "source-changed" },
		func(receipt *Receipt) { receipt.Amount.Minor++ },
	}
	for index, mutate := range mutations {
		changed := original
		changed.ReceiptID += "-new"
		mutate(&changed)
		if _, created, err := store.Save(changed); err == nil || created {
			t.Errorf("mutation %d created=%t err=%v", index, created, err)
		}
	}
	if store.Count() != 1 {
		t.Errorf("conflicts changed count to %d", store.Count())
	}
}

func TestMemoryReceiptStoreInjectedFailuresAreScoped(t *testing.T) {
	store := NewMemoryReceiptStore()
	receiptA := storedReceipt("failure-a", "failure-batch", 0)
	receiptB := storedReceipt("failure-b", "failure-batch", time.Second)
	store.InjectFailure("save", receiptA.PaymentID, errors.New("disk full"))
	if _, _, err := store.Save(receiptA); err == nil || err.Error() != "disk full" {
		t.Errorf("save failure: %v", err)
	}
	if _, _, err := store.Save(receiptB); err != nil {
		t.Fatalf("unrelated save: %v", err)
	}
	store.InjectFailure("find", receiptB.PaymentID, errors.New("index offline"))
	if _, _, err := store.FindByPayment(receiptB.PaymentID); err == nil || err.Error() != "index offline" {
		t.Errorf("find failure: %v", err)
	}
	store.InjectFailure("list", receiptB.BatchKey, errors.New("scan interrupted"))
	if _, err := store.ListByBatch(receiptB.BatchKey); err == nil || err.Error() != "scan interrupted" {
		t.Errorf("list failure: %v", err)
	}
	store.InjectFailure("find", receiptB.PaymentID, nil)
	if found, exists, err := store.FindByPayment(receiptB.PaymentID); err != nil || !exists || found.ReceiptID != receiptB.ReceiptID {
		t.Errorf("cleared find failure found=%+v exists=%t err=%v", found, exists, err)
	}
}

func TestMemoryReceiptStoreConcurrentSaveKeepsCanonicalReceipt(t *testing.T) {
	store := NewMemoryReceiptStore()
	base := storedReceipt("concurrent", "concurrent-batch", 0)
	const writers = 24
	created := make(chan Receipt, writers)
	errorsSeen := make(chan error, writers)
	var group sync.WaitGroup
	for writer := 0; writer < writers; writer++ {
		writer := writer
		group.Add(1)
		go func() {
			defer group.Done()
			candidate := base
			candidate.ReceiptID = candidate.ReceiptID + "-" + string(rune('a'+writer))
			candidate.ProviderToken = candidate.ProviderToken + "-variant"
			stored, wasCreated, err := store.Save(candidate)
			if err != nil {
				errorsSeen <- err
				return
			}
			if wasCreated {
				created <- stored
			}
		}()
	}
	group.Wait()
	close(created)
	close(errorsSeen)
	if len(errorsSeen) != 0 {
		for err := range errorsSeen {
			t.Errorf("concurrent save: %v", err)
		}
	}
	if len(created) != 1 {
		t.Errorf("created count %d, want 1", len(created))
	}
	if store.Count() != 1 {
		t.Errorf("store count %d, want 1", store.Count())
	}
}

func TestBatchArchivePutReplayConflictAndClone(t *testing.T) {
	archive := NewBatchArchive()
	receipt := storedReceipt("archive", "archive-key", 0)
	batch := ArchivedBatch{
		Key:         "archive-key",
		Fingerprint: strings.Repeat("a", 64),
		Entries:     []BatchEntry{{Position: 0, PaymentID: receipt.PaymentID, Receipt: &receipt, Attempts: 1}},
		StartedAt:   testEpoch,
		FinishedAt:  testEpoch.Add(time.Second),
	}
	created, err := archive.Put(batch)
	if err != nil || created.Revision != 1 {
		t.Fatalf("archive put: %+v err=%v", created, err)
	}
	created.Entries[0].Receipt.ReceiptID = "mutated-outside"
	read, exists := archive.Get(batch.Key)
	if !exists || read.Entries[0].Receipt.ReceiptID == "mutated-outside" {
		t.Errorf("archive did not clone: %+v", read)
	}
	replayed, err := archive.Put(batch)
	if err != nil || replayed.Revision != 1 {
		t.Errorf("archive replay: %+v err=%v", replayed, err)
	}
	conflicting := batch
	conflicting.Fingerprint = strings.Repeat("b", 64)
	if _, err := archive.Put(conflicting); err == nil {
		t.Error("archive conflict should fail")
	}
	invalid := ArchivedBatch{Key: "", Fingerprint: ""}
	if _, err := archive.Put(invalid); err == nil {
		t.Error("empty archive key should fail")
	}
}

func TestBatchArchiveSummariesAreSortedByKey(t *testing.T) {
	archive := NewBatchArchive()
	for _, key := range []string{"batch-zulu", "batch-alpha", "batch-middle"} {
		receipt := storedReceipt(key, key, 0)
		_, err := archive.Put(ArchivedBatch{
			Key:         key,
			Fingerprint: strings.Repeat(key[len(key)-1:], 64),
			Entries:     []BatchEntry{{PaymentID: key, Receipt: &receipt, Attempts: 1}},
			StartedAt:   testEpoch,
			FinishedAt:  testEpoch.Add(time.Second),
		})
		if err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}
	summaries := archive.Summaries()
	if len(summaries) != 3 || summaries[0].BatchKey != "batch-alpha" || summaries[1].BatchKey != "batch-middle" || summaries[2].BatchKey != "batch-zulu" {
		t.Errorf("summary order: %+v", summaries)
	}
}

func TestRetryPolicyValidationAndDeterministicSchedule(t *testing.T) {
	invalid := []struct {
		initial    time.Duration
		maximum    time.Duration
		multiplier float64
		jitter     float64
	}{
		{-time.Second, time.Second, 2, 0},
		{2 * time.Second, time.Second, 2, 0},
		{time.Second, time.Second, 0.5, 0},
		{time.Second, time.Second, 2, -0.1},
		{time.Second, time.Second, 2, 1.1},
	}
	for index, test := range invalid {
		if policy, err := NewRetryPolicy(test.initial, test.maximum, test.multiplier, test.jitter, 1); err == nil || policy != nil {
			t.Errorf("invalid policy %d returned policy=%+v err=%v", index, policy, err)
		}
	}
	policy, err := NewRetryPolicy(10*time.Millisecond, 55*time.Millisecond, 2, 0, 9)
	if err != nil {
		t.Fatalf("valid policy: %v", err)
	}
	failure := &CommitFailure{Kind: FailureTransient, Retryable: true, Message: "temporary"}
	wants := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond, 55 * time.Millisecond}
	for index, want := range wants {
		decision := policy.Decide(index+1, 6, failure)
		if decision.Stop || decision.Delay != want {
			t.Errorf("attempt %d decision %+v, want delay %s", index+1, decision, want)
		}
	}
	last := policy.Decide(6, 6, failure)
	if !last.Stop || !strings.Contains(last.Reason, "limit") {
		t.Errorf("last decision: %+v", last)
	}
}

func TestRetryPolicyStopsPermanentAndDisabledKinds(t *testing.T) {
	policy, _ := NewRetryPolicy(time.Millisecond, time.Second, 2, 0, 7)
	permanent := &CommitFailure{Kind: FailurePermanent, Retryable: false, Message: "no"}
	if decision := policy.Decide(1, 4, permanent); !decision.Stop {
		t.Errorf("permanent decision: %+v", decision)
	}
	markedButDisabled := &CommitFailure{Kind: FailureConflict, Retryable: true, Message: "conflict"}
	if decision := policy.Decide(1, 4, markedButDisabled); !decision.Stop {
		t.Errorf("disabled kind decision: %+v", decision)
	}
	if decision := policy.Decide(1, 4, nil); !decision.Stop {
		t.Errorf("nil failure decision: %+v", decision)
	}
	sequence := policy.Schedule(4, permanent)
	if len(sequence) != 1 || !sequence[0].Stop {
		t.Errorf("permanent schedule: %+v", sequence)
	}
	if schedule := policy.Schedule(0, permanent); schedule != nil {
		t.Errorf("zero limit schedule: %+v", schedule)
	}
}

func TestWaitForRetryObservesContext(t *testing.T) {
	if err := WaitForRetry(context.Background(), 0); err != nil {
		t.Errorf("zero delay: %v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := WaitForRetry(cancelled, time.Second); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled wait: %v", err)
	}
	start := time.Now()
	if err := WaitForRetry(context.Background(), 5*time.Millisecond); err != nil {
		t.Errorf("short wait: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 3*time.Millisecond {
		t.Errorf("wait returned too early: %s", elapsed)
	}
}

func validationContext() ValidationContext {
	return ValidationContext{
		Now:                  testEpoch,
		AllowedCurrencies:    map[Currency]bool{CurrencyUSD: true, CurrencyEUR: true},
		AccountPrefixes:      []string{"eu-", "us-"},
		BlockedBeneficiaries: map[string]string{"blocked-1": "sanctions hold", "blocked-2": "closed account"},
		MaximumByCurrency:    map[Currency]int64{CurrencyUSD: 10_000, CurrencyEUR: 20_000},
		AttributeAllowList:   map[string]bool{"channel": true, "desk": true, "purpose": true},
		ReferencePattern:     regexp.MustCompile(`^[A-Z]{2}-[0-9]{4,12}$`),
		MaximumFutureSkew:    2 * time.Minute,
		MaximumPastAge:       24 * time.Hour,
	}
}

func TestPaymentValidatorCollectsPolicyIssues(t *testing.T) {
	validator := NewPaymentValidator(validationContext())
	payment := testPayment("inspect", "apac-source", "blocked-1", CurrencyGBP, 30_000, 5*time.Minute)
	payment.Reference = "bad reference"
	payment.Attributes["unknown"] = "value"
	issues := validator.Inspect(payment, 7)
	byCode := GroupIssuesByCode(issues)
	wants := []string{"currency.disallowed", "account.region", "beneficiary.blocked", "reference.format", "time.future", "attribute.unknown"}
	for _, code := range wants {
		if len(byCode[code]) != 1 {
			t.Errorf("code %s issues: %+v", code, byCode[code])
		}
		if len(byCode[code]) == 1 && byCode[code][0].Position != 7 {
			t.Errorf("code %s position: %+v", code, byCode[code][0])
		}
	}
	if len(issues) != len(wants) {
		t.Errorf("all issues: %+v", issues)
	}
}

func TestPaymentValidatorAcceptsCompliantPayment(t *testing.T) {
	validator := NewPaymentValidator(validationContext())
	payment := testPayment("compliant", "us-source", "beneficiary-ok", CurrencyUSD, 9_999, -time.Hour)
	payment.Reference = "US-123456"
	payment.Attributes = map[string]string{"channel": "api", "purpose": "invoice"}
	if issues := validator.Inspect(payment, 0); len(issues) != 0 {
		t.Errorf("compliant payment issues: %+v", issues)
	}
}

func TestPaymentValidatorBatchFindsDuplicateAndEnvelopeIssues(t *testing.T) {
	validator := NewPaymentValidator(validationContext())
	payment := testPayment("duplicate-id", "eu-source", "beneficiary-ok", CurrencyEUR, 500, 0)
	payment.Reference = "EU-1234"
	request := CommitRequest{
		IdempotencyKey:  "bad",
		Payments:        []Payment{payment, payment},
		MaximumAttempts: 0,
		RequestedAt:     testEpoch,
		Deadline:        testEpoch.Add(-time.Minute),
	}
	issues := validator.InspectBatch(request)
	byCode := GroupIssuesByCode(issues)
	for _, code := range []string{"batch.key", "batch.attempts", "batch.deadline", "payment.duplicate"} {
		if len(byCode[code]) != 1 {
			t.Errorf("batch code %s: %+v", code, byCode[code])
		}
	}
	if duplicate := byCode["payment.duplicate"][0]; duplicate.Position != 1 || !strings.Contains(duplicate.Message, "position 0") {
		t.Errorf("duplicate detail: %+v", duplicate)
	}
}

func TestPaymentValidatorCopiesConfiguration(t *testing.T) {
	configuration := validationContext()
	validator := NewPaymentValidator(configuration)
	configuration.AllowedCurrencies[CurrencyGBP] = true
	configuration.MaximumByCurrency[CurrencyUSD] = 1
	configuration.AttributeAllowList["mutated"] = true
	configuration.BlockedBeneficiaries["new-block"] = "late mutation"
	configuration.AccountPrefixes[0] = "changed-"
	payment := testPayment("copy-check", "us-account", "new-block", CurrencyGBP, 5_000, 0)
	payment.Reference = "US-5555"
	payment.Attributes = map[string]string{"mutated": "value"}
	issues := GroupIssuesByCode(validator.Inspect(payment, 0))
	if len(issues["currency.disallowed"]) != 1 || len(issues["attribute.unknown"]) != 1 {
		t.Errorf("validator observed map mutation: %+v", issues)
	}
	if len(issues["beneficiary.blocked"]) != 0 || len(issues["account.region"]) != 0 {
		t.Errorf("validator observed blocked/prefix mutation: %+v", issues)
	}
}
