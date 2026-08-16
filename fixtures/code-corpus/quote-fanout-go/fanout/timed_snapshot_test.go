package fanout

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestTimedSnapshotCachesFreshQuotesAndDefendsStoredValues 验证新鲜期内命中缓存
// 不再回源,且返回的克隆副本可被调用方修改而不污染缓存。
func TestTimedSnapshotCachesFreshQuotesAndDefendsStoredValues(t *testing.T) {
	clock := newManualClock()
	snapshot, err := NewTimedSnapshot(clock, snapshotPolicy())
	requireNoError(t, err)
	request := sampleRequest(t, clock, "EUR/USD", "fresh")
	original := sampleQuote(t, clock, "EUR/USD", "north-bank", 1_086_400)
	loads := 0
	loader := func(context.Context, QuoteRequest) (Quote, error) {
		loads++
		return cloneQuote(original), nil
	}
	first, err := snapshot.Lookup(context.Background(), request, loader)
	requireNoError(t, err)
	requireEqual(t, first.Provider, "north-bank")
	requireEqual(t, loads, 1)
	first.Tags["venue"] = "mutated-by-caller"
	first.BidMicros = 1
	clock.Advance(4 * time.Second)
	second, err := snapshot.Lookup(context.Background(), request, loader)
	requireNoError(t, err)
	requireEqual(t, loads, 1)
	requireEqual(t, second.BidMicros, int64(1_086_400))
	requireEqual(t, second.Tags["venue"], "synthetic")
	requireEqual(t, second.Tags["snapshot-key"], "EUR/USD")
	requireEqual(t, second.Tags["correlation"], "corr-fresh")
	if second.Stale {
		t.Fatalf("fresh cached quote reported stale: %s", explainQuote(second))
	}
	numbers := snapshot.Numbers()
	requireEqual(t, numbers.Loads, uint64(1))
	requireEqual(t, numbers.FreshHits, uint64(1))
	requireEqual(t, numbers.Entries, 1)
	requireEqual(t, numbers.Flights, 0)
}

// TestTimedSnapshotCoalescesConcurrentPairLoads 验证同键并发请求合并为单次回源:
// 24 个调用方共享一次加载,指标中合并等待数正确。
func TestTimedSnapshotCoalescesConcurrentPairLoads(t *testing.T) {
	clock := newManualClock()
	snapshot, err := NewTimedSnapshot(clock, snapshotPolicy())
	requireNoError(t, err)
	request := sampleRequest(t, clock, "GBP/USD", "coalesce")
	quote := sampleQuote(t, clock, "GBP/USD", "harbor-market", 1_274_000)
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	loader := func(ctx context.Context, observed QuoteRequest) (Quote, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-ctx.Done():
			return Quote{}, ctx.Err()
		case <-release:
		}
		if observed.Pair != quote.Pair {
			return Quote{}, errors.New("test loader received wrong pair")
		}
		return cloneQuote(quote), nil
	}
	const callers = 24
	results := make(chan Quote, callers)
	failures := make(chan error, callers)
	var group sync.WaitGroup
	group.Add(1)
	go func() {
		defer group.Done()
		loaded, loadErr := snapshot.Lookup(context.Background(), request, loader)
		if loadErr != nil {
			failures <- loadErr
			return
		}
		results <- loaded
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("initiating loader did not start")
	}
	for index := 1; index < callers; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			loaded, loadErr := snapshot.Lookup(context.Background(), request, loader)
			if loadErr != nil {
				failures <- loadErr
				return
			}
			results <- loaded
		}()
	}
	waitFor(t, "all snapshot waiters to join", func() bool {
		return snapshot.Numbers().JoinedWaiters == callers-1
	})
	close(release)
	group.Wait()
	close(results)
	close(failures)
	for failure := range failures {
		t.Errorf("coalesced lookup failed: %v", failure)
	}
	count := 0
	for loaded := range results {
		count++
		if loaded.BidMicros != quote.BidMicros || loaded.Provider != quote.Provider {
			t.Errorf("unexpected coalesced result: %s", explainQuote(loaded))
		}
	}
	requireEqual(t, count, callers)
	requireEqual(t, calls.Load(), int32(1))
	numbers := snapshot.Numbers()
	requireEqual(t, numbers.Loads, uint64(1))
	requireEqual(t, numbers.JoinedWaiters, uint64(callers-1))
	requireEqual(t, numbers.Flights, 0)
}

// TestTimedSnapshotReturnsRetainedQuoteWhenRefreshFails 验证刷新失败时降级返回
// 带 Stale 标记的旧报价;超过陈旧保留期后不再降级并返回不可用错误。
func TestTimedSnapshotReturnsRetainedQuoteWhenRefreshFails(t *testing.T) {
	clock := newManualClock()
	snapshot, err := NewTimedSnapshot(clock, snapshotPolicy())
	requireNoError(t, err)
	request := sampleRequest(t, clock, "USD/JPY", "stale")
	initial := sampleQuote(t, clock, "USD/JPY", "tokyo-feed", 149_320_000)
	loaded, err := snapshot.Lookup(context.Background(), request, func(context.Context, QuoteRequest) (Quote, error) {
		return initial, nil
	})
	requireNoError(t, err)
	if loaded.Stale {
		t.Fatal("initially loaded quote should be fresh")
	}
	clock.Advance(6 * time.Second)
	refreshFailure := ProviderFailure{
		Provider:  "tokyo-feed",
		Kind:      "transport",
		Retryable: true,
		Cause:     errors.New("upstream reset"),
	}
	stale, err := snapshot.Lookup(context.Background(), request, func(context.Context, QuoteRequest) (Quote, error) {
		return Quote{}, refreshFailure
	})
	requireNoError(t, err)
	if !stale.Stale {
		t.Fatalf("expected stale marker: %s", explainQuote(stale))
	}
	requireEqual(t, stale.BidMicros, initial.BidMicros)
	requireEqual(t, stale.Provider, initial.Provider)
	numbers := snapshot.Numbers()
	requireEqual(t, numbers.Loads, uint64(2))
	requireEqual(t, numbers.StaleFallbacks, uint64(1))
	clock.Advance(time.Minute)
	_, err = snapshot.Lookup(context.Background(), request, func(context.Context, QuoteRequest) (Quote, error) {
		return Quote{}, errors.New("still unavailable")
	})
	requireErrorIs(t, err, ErrQuoteUnavailable)
	requireEqual(t, snapshot.Numbers().Entries, 0)
}

// TestTimedSnapshotHonorsLoadDeadline 验证回源超过 LoadTimeout 会被取消并计入
// 超时指标,返回不可用错误。
func TestTimedSnapshotHonorsLoadDeadline(t *testing.T) {
	clock := newManualClock()
	policy := snapshotPolicy()
	policy.LoadTimeout = 15 * time.Millisecond
	snapshot, err := NewTimedSnapshot(clock, policy)
	requireNoError(t, err)
	request := sampleRequest(t, clock, "CHF/JPY", "deadline")
	loaderCanceled := make(chan struct{})
	_, err = snapshot.Lookup(context.Background(), request, func(ctx context.Context, request QuoteRequest) (Quote, error) {
		<-ctx.Done()
		close(loaderCanceled)
		return Quote{}, ctx.Err()
	})
	requireErrorIs(t, err, ErrQuoteUnavailable)
	select {
	case <-loaderCanceled:
	case <-time.After(time.Second):
		t.Fatal("snapshot did not cancel timed-out loader")
	}
	requireEqual(t, snapshot.Numbers().Timeouts, uint64(1))
	requireEqual(t, snapshot.Numbers().Flights, 0)
}

// TestTimedSnapshotWaiterCanCancelWithoutCancelingSharedLoad 验证等待者取消不
// 影响共享回源:发起者仍能完成并写入缓存,后续请求直接命中。
func TestTimedSnapshotWaiterCanCancelWithoutCancelingSharedLoad(t *testing.T) {
	clock := newManualClock()
	snapshot, err := NewTimedSnapshot(clock, snapshotPolicy())
	requireNoError(t, err)
	request := sampleRequest(t, clock, "CAD/USD", "waiter")
	quote := sampleQuote(t, clock, "CAD/USD", "maple-feed", 742_300)
	started := make(chan struct{})
	release := make(chan struct{})
	loader := func(ctx context.Context, request QuoteRequest) (Quote, error) {
		close(started)
		select {
		case <-ctx.Done():
			return Quote{}, ctx.Err()
		case <-release:
			return quote, nil
		}
	}
	initiator := make(chan error, 1)
	go func() {
		_, loadErr := snapshot.Lookup(context.Background(), request, loader)
		initiator <- loadErr
	}()
	<-started
	waitContext, cancel := context.WithCancel(context.Background())
	waiter := make(chan error, 1)
	go func() {
		_, loadErr := snapshot.Lookup(waitContext, request, loader)
		waiter <- loadErr
	}()
	waitFor(t, "cancelable snapshot waiter", func() bool {
		return snapshot.Numbers().JoinedWaiters == 1
	})
	cancel()
	waitErr := <-waiter
	requireErrorIs(t, waitErr, context.Canceled)
	close(release)
	requireNoError(t, <-initiator)
	loaded, err := snapshot.Lookup(context.Background(), request, loader)
	requireNoError(t, err)
	requireEqual(t, loaded.Provider, "maple-feed")
	requireEqual(t, snapshot.Numbers().Loads, uint64(1))
}

// TestTimedSnapshotEvictsLeastUsedEntryAndSupportsInvalidation 验证容量淘汰(最
// 少使用优先)与手动失效接口,非法货币对不接受失效。
func TestTimedSnapshotEvictsLeastUsedEntryAndSupportsInvalidation(t *testing.T) {
	clock := newManualClock()
	policy := snapshotPolicy()
	policy.MaximumEntries = 2
	snapshot, err := NewTimedSnapshot(clock, policy)
	requireNoError(t, err)
	pairs := []string{"EUR/USD", "GBP/USD", "AUD/USD"}
	for index, text := range pairs {
		request := sampleRequest(t, clock, text, fmt.Sprintf("capacity-%d", index))
		quote := sampleQuote(t, clock, text, fmt.Sprintf("feed-%d", index), 900_000+int64(index*10_000))
		_, err = snapshot.Lookup(context.Background(), request, func(context.Context, QuoteRequest) (Quote, error) {
			return quote, nil
		})
		requireNoError(t, err)
		clock.Advance(time.Millisecond)
	}
	numbers := snapshot.Numbers()
	requireEqual(t, numbers.Entries, 2)
	requireEqual(t, numbers.Evictions, uint64(1))
	if snapshot.Invalidate(mustPair(t, "EUR/USD")) {
		t.Fatal("oldest least-used pair should already have been evicted")
	}
	if !snapshot.Invalidate(mustPair(t, "GBP/USD")) {
		t.Fatal("expected retained pair to be invalidated")
	}
	requireEqual(t, snapshot.Numbers().Entries, 1)
	if snapshot.Invalidate(Pair{Base: "bad", Counter: "USD"}) {
		t.Fatal("invalid pair should not be accepted for invalidation")
	}
}

// TestTimedSnapshotRejectsInvalidPolicies 验证策略参数越界与空时钟都被构造器拒绝。
func TestTimedSnapshotRejectsInvalidPolicies(t *testing.T) {
	clock := newManualClock()
	cases := []struct {
		name   string
		policy SnapshotPolicy
	}{
		{name: "no fresh interval", policy: SnapshotPolicy{RetainStaleFor: time.Minute, LoadTimeout: time.Second, MaximumEntries: 1}},
		{name: "stale shorter than fresh", policy: SnapshotPolicy{FreshFor: time.Minute, RetainStaleFor: time.Second, LoadTimeout: time.Second, MaximumEntries: 1}},
		{name: "stale over one day", policy: SnapshotPolicy{FreshFor: time.Second, RetainStaleFor: 25 * time.Hour, LoadTimeout: time.Second, MaximumEntries: 1}},
		{name: "no load timeout", policy: SnapshotPolicy{FreshFor: time.Second, RetainStaleFor: time.Minute, MaximumEntries: 1}},
		{name: "load timeout too long", policy: SnapshotPolicy{FreshFor: time.Second, RetainStaleFor: time.Minute, LoadTimeout: 3 * time.Minute, MaximumEntries: 1}},
		{name: "zero capacity", policy: SnapshotPolicy{FreshFor: time.Second, RetainStaleFor: time.Minute, LoadTimeout: time.Second}},
		{name: "excess capacity", policy: SnapshotPolicy{FreshFor: time.Second, RetainStaleFor: time.Minute, LoadTimeout: time.Second, MaximumEntries: 100_001}},
	}
	for _, candidate := range cases {
		t.Run(candidate.name, func(t *testing.T) {
			if _, err := NewTimedSnapshot(clock, candidate.policy); err == nil {
				t.Fatal("expected policy validation error")
			}
		})
	}
	if _, err := NewTimedSnapshot(nil, snapshotPolicy()); err == nil {
		t.Fatal("nil clock should be rejected")
	}
	zeroClock := &manualClock{}
	if _, err := NewTimedSnapshot(zeroClock, snapshotPolicy()); err == nil {
		t.Fatal("zero-valued clock should be rejected")
	}
}

// TestTimedSnapshotRejectsMalformedLoaderResults 验证回源结果非法(货币对不符、
// 空提供方、交叉价、已过期)时,加载被拒且不写入缓存。
func TestTimedSnapshotRejectsMalformedLoaderResults(t *testing.T) {
	clock := newManualClock()
	cases := []struct {
		name  string
		quote func(*testing.T) Quote
	}{
		{name: "wrong pair", quote: func(t *testing.T) Quote {
			return sampleQuote(t, clock, "GBP/USD", "feed", 1_200_000)
		}},
		{name: "empty provider", quote: func(t *testing.T) Quote {
			quote := sampleQuote(t, clock, "EUR/USD", "feed", 1_080_000)
			quote.Provider = ""
			return quote
		}},
		{name: "crossed price", quote: func(t *testing.T) Quote {
			quote := sampleQuote(t, clock, "EUR/USD", "feed", 1_080_000)
			quote.AskMicros = quote.BidMicros - 1
			return quote
		}},
		{name: "already expired", quote: func(t *testing.T) Quote {
			quote := sampleQuote(t, clock, "EUR/USD", "feed", 1_080_000)
			quote.ExpiresAt = clock.Now().Add(-time.Second)
			quote.ObservedAt = clock.Now().Add(-time.Minute)
			return quote
		}},
	}
	for _, candidate := range cases {
		t.Run(candidate.name, func(t *testing.T) {
			snapshot, err := NewTimedSnapshot(clock, snapshotPolicy())
			requireNoError(t, err)
			request := sampleRequest(t, clock, "EUR/USD", "bad-loader")
			_, err = snapshot.Lookup(context.Background(), request, func(context.Context, QuoteRequest) (Quote, error) {
				return candidate.quote(t), nil
			})
			requireErrorIs(t, err, ErrQuoteUnavailable)
			requireEqual(t, snapshot.Numbers().Entries, 0)
		})
	}
}
