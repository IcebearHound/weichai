package fanout

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

type manualClock struct {
	mu  sync.Mutex
	now time.Time
}

func newManualClock() *manualClock {
	return &manualClock{now: time.Date(2026, time.January, 14, 9, 30, 0, 0, time.UTC)}
}

func (clock *manualClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *manualClock) Advance(duration time.Duration) {
	clock.mu.Lock()
	clock.now = clock.now.Add(duration)
	clock.mu.Unlock()
}

func (clock *manualClock) Set(value time.Time) {
	clock.mu.Lock()
	clock.now = value
	clock.mu.Unlock()
}

type providerResponse struct {
	quote Quote
	err   error
	wait  <-chan struct{}
}

type scriptedProvider struct {
	mu           sync.Mutex
	name         string
	responses    []providerResponse
	calls        []QuoteRequest
	active       int
	maximumAlive int
}

func (provider *scriptedProvider) Name() string {
	return provider.name
}

func (provider *scriptedProvider) Fetch(ctx context.Context, request QuoteRequest) (Quote, error) {
	provider.mu.Lock()
	provider.calls = append(provider.calls, request)
	provider.active++
	if provider.active > provider.maximumAlive {
		provider.maximumAlive = provider.active
	}
	var response providerResponse
	if len(provider.responses) == 0 {
		response.err = errors.New("script exhausted")
	} else {
		response = provider.responses[0]
		provider.responses = provider.responses[1:]
	}
	provider.mu.Unlock()
	defer func() {
		provider.mu.Lock()
		provider.active--
		provider.mu.Unlock()
	}()
	if response.wait != nil {
		select {
		case <-ctx.Done():
			return Quote{}, ctx.Err()
		case <-response.wait:
		}
	}
	if response.err != nil {
		return Quote{}, response.err
	}
	return cloneQuote(response.quote), nil
}

func (provider *scriptedProvider) CallCount() int {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return len(provider.calls)
}

func (provider *scriptedProvider) MaximumConcurrent() int {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return provider.maximumAlive
}

func (provider *scriptedProvider) Requests() []QuoteRequest {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	result := make([]QuoteRequest, len(provider.calls))
	copy(result, provider.calls)
	return result
}

type recordingJournal struct {
	mu        sync.Mutex
	batches   [][]JournalEntry
	failures  []error
	wait      <-chan struct{}
	started   chan struct{}
	startOnce sync.Once
}

func (writer *recordingJournal) WriteJournal(ctx context.Context, entries []JournalEntry) error {
	writer.startOnce.Do(func() {
		if writer.started != nil {
			close(writer.started)
		}
	})
	if writer.wait != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-writer.wait:
		}
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if len(writer.failures) > 0 {
		failure := writer.failures[0]
		writer.failures = writer.failures[1:]
		if failure != nil {
			return failure
		}
	}
	batch := make([]JournalEntry, len(entries))
	for index, entry := range entries {
		batch[index] = cloneJournalEntry(entry)
	}
	writer.batches = append(writer.batches, batch)
	return nil
}

func (writer *recordingJournal) Batches() [][]JournalEntry {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	result := make([][]JournalEntry, len(writer.batches))
	for index, batch := range writer.batches {
		result[index] = make([]JournalEntry, len(batch))
		for entryIndex, entry := range batch {
			result[index][entryIndex] = cloneJournalEntry(entry)
		}
	}
	return result
}

func mustPair(test *testing.T, text string) Pair {
	test.Helper()
	pair, err := ParsePair(text)
	if err != nil {
		test.Fatalf("ParsePair(%q): %v", text, err)
	}
	return pair
}

func sampleRequest(test *testing.T, clock Clock, pairText, suffix string) QuoteRequest {
	test.Helper()
	return QuoteRequest{
		Pair:          mustPair(test, pairText),
		AmountMinor:   125_000,
		RequestedAt:   clock.Now(),
		CorrelationID: "corr-" + suffix,
		Region:        "eu-west",
	}
}

func sampleQuote(test *testing.T, clock Clock, pairText, provider string, bid int64) Quote {
	test.Helper()
	return Quote{
		Pair:       mustPair(test, pairText),
		BidMicros:  bid,
		AskMicros:  bid + 120,
		Provider:   provider,
		ObservedAt: clock.Now(),
		ExpiresAt:  clock.Now().Add(20 * time.Minute),
		Tags: map[string]string{
			"venue":  "synthetic",
			"region": "eu-west",
		},
	}
}

func sampleJournal(clock Clock, identifier string, offset time.Duration) JournalEntry {
	return JournalEntry{
		ID:            identifier,
		Kind:          "quote.observed",
		OccurredAt:    clock.Now().Add(offset),
		CorrelationID: "corr-" + identifier,
		AccountID:     "account-17",
		Fields: map[string]string{
			"provider": "north-bank",
			"pair":     "EUR/USD",
			"status":   "accepted",
		},
	}
}

func requireErrorIs(test *testing.T, err error, target error) {
	test.Helper()
	if !errors.Is(err, target) {
		test.Fatalf("expected error %v, got %v", target, err)
	}
}

func requireNoError(test *testing.T, err error) {
	test.Helper()
	if err != nil {
		test.Fatalf("unexpected error: %v", err)
	}
}

func requireEqual[T comparable](test *testing.T, actual, expected T) {
	test.Helper()
	if actual != expected {
		test.Fatalf("expected %v, got %v", expected, actual)
	}
}

func waitFor(test *testing.T, description string, condition func() bool) {
	test.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	test.Fatalf("timed out waiting for %s", description)
}

func providerFor(name string, responses ...providerResponse) *scriptedProvider {
	return &scriptedProvider{name: name, responses: append([]providerResponse(nil), responses...)}
}

func switchPolicy() SwitchPolicy {
	return SwitchPolicy{
		FailureLimit:       2,
		RecoverySuccesses:  1,
		OpenFor:            5 * time.Second,
		RequestTimeout:     200 * time.Millisecond,
		MaximumProbeCalls:  1,
		NonRetryableWeight: 2,
	}
}

func snapshotPolicy() SnapshotPolicy {
	return SnapshotPolicy{
		FreshFor:       5 * time.Second,
		RetainStaleFor: time.Minute,
		LoadTimeout:    250 * time.Millisecond,
		MaximumEntries: 16,
	}
}

func explainQuote(quote Quote) string {
	return fmt.Sprintf("%s %d/%d from %s stale=%t", quote.Pair.String(), quote.BidMicros, quote.AskMicros, quote.Provider, quote.Stale)
}
