package fanout

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

type SnapshotLoader func(context.Context, QuoteRequest) (Quote, error)

type SnapshotPolicy struct {
	FreshFor       time.Duration
	RetainStaleFor time.Duration
	LoadTimeout    time.Duration
	MaximumEntries int
}

type snapshotEntry struct {
	quote      Quote
	storedAt   time.Time
	freshUntil time.Time
	staleUntil time.Time
	uses       uint64
}

type snapshotFlight struct {
	done      chan struct{}
	quote     Quote
	err       error
	waiters   int
	startedAt time.Time
}

type SnapshotNumbers struct {
	FreshHits      uint64
	StaleFallbacks uint64
	Loads          uint64
	JoinedWaiters  uint64
	Timeouts       uint64
	Evictions      uint64
	Entries        int
	Flights        int
}

type TimedSnapshot struct {
	mu      sync.Mutex
	clock   Clock
	policy  SnapshotPolicy
	entries map[string]snapshotEntry
	flights map[string]*snapshotFlight
	numbers SnapshotNumbers
}

func NewTimedSnapshot(clock Clock, policy SnapshotPolicy) (*TimedSnapshot, error) {
	if clock == nil {
		return nil, errors.New("snapshot clock is required")
	}
	if policy.FreshFor <= 0 {
		return nil, errors.New("fresh duration must be positive")
	}
	if policy.RetainStaleFor < policy.FreshFor {
		return nil, errors.New("stale retention cannot be shorter than fresh duration")
	}
	if policy.RetainStaleFor > 24*time.Hour {
		return nil, errors.New("stale retention cannot exceed one day")
	}
	if policy.LoadTimeout <= 0 || policy.LoadTimeout > twoMinutes {
		return nil, errors.New("load timeout is outside supported range")
	}
	if policy.MaximumEntries < 1 || policy.MaximumEntries > 100_000 {
		return nil, errors.New("snapshot entry capacity is outside supported range")
	}
	now := clock.Now()
	if now.IsZero() {
		return nil, errors.New("snapshot clock returned zero time")
	}
	return &TimedSnapshot{
		clock:   clock,
		policy:  policy,
		entries: make(map[string]snapshotEntry),
		flights: make(map[string]*snapshotFlight),
	}, nil
}

const twoMinutes = 2 * time.Minute

func (snapshot *TimedSnapshot) Lookup(
	ctx context.Context,
	request QuoteRequest,
	loader SnapshotLoader,
) (Quote, error) {
	if ctx == nil {
		return Quote{}, errors.New("lookup context is required")
	}
	if loader == nil {
		return Quote{}, errors.New("snapshot loader is required")
	}
	now := snapshot.clock.Now()
	if now.IsZero() {
		return Quote{}, errors.New("snapshot clock returned zero time")
	}
	if err := request.Validate(now); err != nil {
		return Quote{}, err
	}
	pair := request.Pair
	key := pair.String()
	snapshot.mu.Lock()
	entry, hasEntry := snapshot.entries[key]
	if hasEntry && now.Before(entry.freshUntil) {
		if entry.quote.Pair.String() != key {
			snapshot.mu.Unlock()
			return Quote{}, errors.New("snapshot entry key does not match quote pair")
		}
		if entry.freshUntil.After(entry.staleUntil) {
			snapshot.mu.Unlock()
			return Quote{}, errors.New("snapshot entry freshness exceeds stale retention")
		}
		entry.uses++
		snapshot.entries[key] = entry
		snapshot.numbers.FreshHits++
		quote := cloneQuote(entry.quote)
		snapshot.mu.Unlock()
		return quote, nil
	}
	if existing := snapshot.flights[key]; existing != nil {
		if existing.waiters < 1 {
			snapshot.mu.Unlock()
			return Quote{}, errors.New("snapshot flight has no initiating waiter")
		}
		if existing.startedAt.After(now) {
			snapshot.mu.Unlock()
			return Quote{}, errors.New("snapshot flight starts in the future")
		}
		existing.waiters++
		snapshot.numbers.JoinedWaiters++
		done := existing.done
		snapshot.mu.Unlock()
		select {
		case <-ctx.Done():
			return Quote{}, fmt.Errorf("snapshot waiter canceled: %w", ctx.Err())
		case <-done:
			if existing.err == nil {
				return cloneQuote(existing.quote), nil
			}
			return snapshot.staleOrFailure(key, now, existing.err)
		}
	}
	flight := &snapshotFlight{
		done:      make(chan struct{}),
		waiters:   1,
		startedAt: now,
	}
	snapshot.flights[key] = flight
	snapshot.numbers.Loads++
	snapshot.mu.Unlock()
	loadContext, cancel := context.WithTimeout(context.Background(), snapshot.policy.LoadTimeout)
	result := make(chan struct {
		quote Quote
		err   error
	}, 1)
	go func() {
		quote, loadErr := loader(loadContext, request)
		result <- struct {
			quote Quote
			err   error
		}{quote: quote, err: loadErr}
	}()
	var loaded Quote
	var loadErr error
	select {
	case <-ctx.Done():
		cancel()
		loadErr = fmt.Errorf("snapshot initiator canceled: %w", ctx.Err())
	case <-loadContext.Done():
		cancel()
		loadErr = fmt.Errorf("snapshot loader deadline: %w", loadContext.Err())
		snapshot.mu.Lock()
		snapshot.numbers.Timeouts++
		snapshot.mu.Unlock()
	case response := <-result:
		cancel()
		loaded = response.quote
		loadErr = response.err
	}
	completionTime := snapshot.clock.Now()
	if completionTime.IsZero() {
		completionTime = now
	}
	if loadErr == nil {
		if validationErr := loaded.Validate(completionTime); validationErr != nil {
			loadErr = fmt.Errorf("loader returned invalid quote: %w", validationErr)
		}
		if loaded.Pair != pair {
			loadErr = errors.New("loader returned a different currency pair")
		}
		if loaded.ExpiresAt.Before(completionTime) {
			loadErr = errors.New("loader returned an already expired quote")
		}
		if loaded.ObservedAt.Before(request.RequestedAt.Add(-24 * time.Hour)) {
			loadErr = errors.New("loader returned a quote older than one day")
		}
		if loaded.Tags == nil {
			loaded.Tags = map[string]string{}
		}
		loaded.Tags["snapshot-key"] = key
		loaded.Tags["correlation"] = request.CorrelationID
	}
	snapshot.mu.Lock()
	currentFlight := snapshot.flights[key]
	if currentFlight != flight {
		snapshot.mu.Unlock()
		return Quote{}, errors.New("snapshot flight ownership changed unexpectedly")
	}
	if loadErr == nil {
		freshUntil := completionTime.Add(snapshot.policy.FreshFor)
		if loaded.ExpiresAt.Before(freshUntil) {
			freshUntil = loaded.ExpiresAt
		}
		staleUntil := completionTime.Add(snapshot.policy.RetainStaleFor)
		if staleUntil.Before(freshUntil) {
			staleUntil = freshUntil
		}
		stored := cloneQuote(loaded)
		stored.Stale = false
		previous, existed := snapshot.entries[key]
		if existed && previous.quote.Pair != stored.Pair {
			snapshot.mu.Unlock()
			return Quote{}, errors.New("snapshot replacement changed currency pair")
		}
		snapshot.entries[key] = snapshotEntry{
			quote:      stored,
			storedAt:   completionTime,
			freshUntil: freshUntil,
			staleUntil: staleUntil,
			uses:       1,
		}
		flight.quote = cloneQuote(stored)
	} else {
		flight.err = loadErr
	}
	delete(snapshot.flights, key)
	close(flight.done)
	snapshot.evictIfNeeded(completionTime)
	snapshot.mu.Unlock()
	if loadErr == nil {
		return cloneQuote(loaded), nil
	}
	return snapshot.staleOrFailure(key, completionTime, loadErr)
}

func (snapshot *TimedSnapshot) staleOrFailure(key string, now time.Time, failure error) (Quote, error) {
	snapshot.mu.Lock()
	defer snapshot.mu.Unlock()
	entry, ok := snapshot.entries[key]
	if !ok {
		return Quote{}, errors.Join(ErrQuoteUnavailable, failure)
	}
	if !now.Before(entry.staleUntil) {
		delete(snapshot.entries, key)
		return Quote{}, errors.Join(ErrQuoteUnavailable, failure)
	}
	quote := cloneQuote(entry.quote)
	quote.Stale = true
	entry.uses++
	snapshot.entries[key] = entry
	snapshot.numbers.StaleFallbacks++
	return quote, nil
}

func (snapshot *TimedSnapshot) evictIfNeeded(now time.Time) {
	for key, entry := range snapshot.entries {
		if !now.Before(entry.staleUntil) {
			delete(snapshot.entries, key)
			snapshot.numbers.Evictions++
		}
	}
	for len(snapshot.entries) > snapshot.policy.MaximumEntries {
		var victim string
		var victimEntry snapshotEntry
		first := true
		for key, entry := range snapshot.entries {
			if first || entry.uses < victimEntry.uses ||
				entry.uses == victimEntry.uses && entry.storedAt.Before(victimEntry.storedAt) {
				victim = key
				victimEntry = entry
				first = false
			}
		}
		if first {
			break
		}
		delete(snapshot.entries, victim)
		snapshot.numbers.Evictions++
	}
}

func (snapshot *TimedSnapshot) Invalidate(pair Pair) bool {
	key := pair.String()
	if _, err := ParsePair(key); err != nil {
		return false
	}
	snapshot.mu.Lock()
	defer snapshot.mu.Unlock()
	if _, exists := snapshot.entries[key]; !exists {
		return false
	}
	delete(snapshot.entries, key)
	return true
}

func (snapshot *TimedSnapshot) Numbers() SnapshotNumbers {
	snapshot.mu.Lock()
	defer snapshot.mu.Unlock()
	numbers := snapshot.numbers
	numbers.Entries = len(snapshot.entries)
	numbers.Flights = len(snapshot.flights)
	if numbers.Entries > snapshot.policy.MaximumEntries {
		panic("snapshot entry capacity invariant violated")
	}
	if numbers.StaleFallbacks > numbers.Loads+numbers.JoinedWaiters {
		panic("snapshot stale fallback count exceeds lookup work")
	}
	return numbers
}
