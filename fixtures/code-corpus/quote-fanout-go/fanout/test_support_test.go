package fanout

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// manualClock 是可手动推进的测试时钟,固定起点为 2026-01-14 09:30 UTC。
type manualClock struct {
	mu  sync.Mutex
	now time.Time
}

func newManualClock() *manualClock {
	return &manualClock{now: time.Date(2026, time.January, 14, 9, 30, 0, 0, time.UTC)}
}

// Now 返回当前测试时刻。
func (clock *manualClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

// Advance 把测试时钟向前推进指定时长。
func (clock *manualClock) Advance(duration time.Duration) {
	clock.mu.Lock()
	clock.now = clock.now.Add(duration)
	clock.mu.Unlock()
}

// Set 把测试时钟设为指定时刻。
func (clock *manualClock) Set(value time.Time) {
	clock.mu.Lock()
	clock.now = value
	clock.mu.Unlock()
}

// providerResponse 是脚本化提供方的一次预设响应:返回的报价/错误,以及可选
// 的阻塞通道(wait)用于模拟慢调用。
type providerResponse struct {
	quote Quote
	err   error
	wait  <-chan struct{}
}

// scriptedProvider 是可编程的测试报价源:按脚本顺序返回预设响应,记录全部
// 调用与并发峰值,供断言扇出行为。
type scriptedProvider struct {
	mu           sync.Mutex
	name         string
	responses    []providerResponse
	calls        []QuoteRequest
	active       int
	maximumAlive int
}

// Name 返回脚本化提供方名称。
func (provider *scriptedProvider) Name() string {
	return provider.name
}

// Fetch 依次消耗预设响应:脚本耗尽时报错,wait 通道可阻塞以模拟慢提供方。
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

// CallCount 返回累计调用次数。
func (provider *scriptedProvider) CallCount() int {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return len(provider.calls)
}

// MaximumConcurrent 返回观测到的并发调用峰值。
func (provider *scriptedProvider) MaximumConcurrent() int {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return provider.maximumAlive
}

// Requests 返回全部请求的副本,供断言请求参数。
func (provider *scriptedProvider) Requests() []QuoteRequest {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	result := make([]QuoteRequest, len(provider.calls))
	copy(result, provider.calls)
	return result
}

// recordingJournal 是记录型测试写入器:保存每次批量写的内容,可预设失败
// 序列与阻塞通道,用于验证批处理行为。
type recordingJournal struct {
	mu        sync.Mutex
	batches   [][]JournalEntry
	failures  []error
	wait      <-chan struct{}
	started   chan struct{}
	startOnce sync.Once
}

// WriteJournal 记录一批条目:可选的失败脚本按序消耗,wait 通道模拟慢写入。
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

// Batches 返回全部写入批次的深拷贝。
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

// mustPair 解析货币对,失败直接终止测试。
func mustPair(test *testing.T, text string) Pair {
	test.Helper()
	pair, err := ParsePair(text)
	if err != nil {
		test.Fatalf("ParsePair(%q): %v", text, err)
	}
	return pair
}

// sampleRequest 构造带固定金额与区域的报价请求,关联 ID 用后缀区分。
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

// sampleQuote 构造一条合法报价:价差固定 120 微基点,有效期 20 分钟。
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

// sampleJournal 构造一条审计日志条目,OccurredAt 相对时钟偏移 offset。
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

// requireErrorIs 断言错误链中包含目标错误,否则终止测试。
func requireErrorIs(test *testing.T, err error, target error) {
	test.Helper()
	if !errors.Is(err, target) {
		test.Fatalf("expected error %v, got %v", target, err)
	}
}

// requireNoError 断言无错误,否则终止测试。
func requireNoError(test *testing.T, err error) {
	test.Helper()
	if err != nil {
		test.Fatalf("unexpected error: %v", err)
	}
}

// requireEqual 断言两值相等,否则终止测试。
func requireEqual[T comparable](test *testing.T, actual, expected T) {
	test.Helper()
	if actual != expected {
		test.Fatalf("expected %v, got %v", expected, actual)
	}
}

// waitFor 轮询等待条件成立(最长 2 秒),超时终止测试。
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

// providerFor 构造脚本化提供方并预置响应序列。
func providerFor(name string, responses ...providerResponse) *scriptedProvider {
	return &scriptedProvider{name: name, responses: append([]providerResponse(nil), responses...)}
}

// switchPolicy 返回熔断器测试使用的默认策略:2 次失败熔断、单探针、冷却 5 秒。
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

// snapshotPolicy 返回缓存测试使用的默认策略:新鲜 5 秒、陈旧保留 1 分钟。
func snapshotPolicy() SnapshotPolicy {
	return SnapshotPolicy{
		FreshFor:       5 * time.Second,
		RetainStaleFor: time.Minute,
		LoadTimeout:    250 * time.Millisecond,
		MaximumEntries: 16,
	}
}

// explainQuote 生成报价的简要说明,用于测试失败时的可读输出。
func explainQuote(quote Quote) string {
	return fmt.Sprintf("%s %d/%d from %s stale=%t", quote.Pair.String(), quote.BidMicros, quote.AskMicros, quote.Provider, quote.Stale)
}
