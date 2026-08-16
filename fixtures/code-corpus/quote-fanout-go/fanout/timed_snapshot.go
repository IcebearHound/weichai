package fanout

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// SnapshotLoader 从外部加载一次报价,供 TimedSnapshot 在缓存失效时回源。
type SnapshotLoader func(context.Context, QuoteRequest) (Quote, error)

// SnapshotPolicy 配置缓存行为:FreshFor 为新鲜期(期内直接命中),RetainStaleFor
// 为陈旧保留期(过期但可用作降级),LoadTimeout 限制回源耗时,MaximumEntries
// 为条目容量上限。
type SnapshotPolicy struct {
	FreshFor       time.Duration
	RetainStaleFor time.Duration
	LoadTimeout    time.Duration
	MaximumEntries int
}

// snapshotEntry 是缓存中的一条报价:记录存储时刻、新鲜期与陈旧期边界,以及
// 被读取次数(用于容量淘汰)。
type snapshotEntry struct {
	quote      Quote
	storedAt   time.Time
	freshUntil time.Time
	staleUntil time.Time
	uses       uint64
}

// snapshotFlight 是一次正在进行的回源:同一键的并发请求共享一次加载,结果
// 通过 done 通道广播给全部等待者。
type snapshotFlight struct {
	done      chan struct{}
	quote     Quote
	err       error
	waiters   int
	startedAt time.Time
}

// SnapshotNumbers 是缓存运行指标:新鲜命中、陈旧降级、回源次数、并发等待
// 合并数、超时与淘汰数,以及当前条目与在途回源数。
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

// TimedSnapshot 是带新鲜/陈旧两级语义的报价缓存:新鲜期内直接命中;过期但
// 未超陈旧期时,回源失败可降级返回旧报价;同键并发请求合并为单次回源。
type TimedSnapshot struct {
	mu      sync.Mutex
	clock   Clock
	policy  SnapshotPolicy
	entries map[string]snapshotEntry
	flights map[string]*snapshotFlight
	numbers SnapshotNumbers
}

// NewTimedSnapshot 构造缓存并校验策略:新鲜期为正、陈旧期不短于新鲜期且不
// 超过一天、回源超时与容量在支持范围内。
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

// twoMinutes 是请求级超时的通用上限,防止对下游的等待失控。
const twoMinutes = 2 * time.Minute

// Lookup 返回请求的报价:新鲜期内直接命中;否则发起(或加入)一次回源,回源
// 结果校验通过后写入缓存;回源失败且缓存仍处陈旧期时,降级返回旧报价并
// 标记 Stale,供上层权衡使用。
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
		// 返回克隆副本,防止调用方修改缓存内部的报价状态。
		quote := cloneQuote(entry.quote)
		snapshot.mu.Unlock()
		return quote, nil
	}
	// 同键回源已在途:作为等待者加入,共享同一次加载,而不是重复打下游。
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
			// 报价本身的有效期更早时,以报价到期为准,避免卖出已过期价格。
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

// staleOrFailure 在回源失败时尝试降级:缓存条目仍处陈旧期内则返回带 Stale
// 标记的旧报价,否则删除条目并返回不可用错误。
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

// evictIfNeeded 清理过期条目,并在超出容量时按“使用最少、存储最早”的次序
// 淘汰,控制缓存内存占用。
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

// Invalidate 手动删除指定货币对的缓存条目,返回是否删除了内容。
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

// Numbers 返回当前指标快照,并校验容量与计数不变量。
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
