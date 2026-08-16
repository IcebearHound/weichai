package fanout

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

// TestPairParsingAndQuoteArithmetic 验证货币对解析/序列化/反装,以及报价的
// 中值与价差计算,含交叉价的拒绝。
func TestPairParsingAndQuoteArithmetic(t *testing.T) {
	pair := mustPair(t, "eur/usd")
	requireEqual(t, pair, Pair{Base: "EUR", Counter: "USD"})
	requireEqual(t, pair.String(), "EUR/USD")
	requireEqual(t, pair.Inverse(), Pair{Base: "USD", Counter: "EUR"})
	invalid := []string{"", "EURUSD", "EU/USD", "EUR-USD", "EUR/EUR", "XXX/USD", "12A/USD", "EUR/ZZZ"}
	for _, text := range invalid {
		if _, err := ParsePair(text); err == nil {
			t.Errorf("invalid pair %q was accepted", text)
		}
	}
	clock := newManualClock()
	quote := sampleQuote(t, clock, "EUR/USD", "arithmetic-feed", 1_080_000)
	midpoint, err := quote.MidpointMicros()
	requireNoError(t, err)
	requireEqual(t, midpoint, int64(1_080_060))
	spread, err := quote.SpreadBasisPoints()
	requireNoError(t, err)
	if spread <= 1 || spread >= 2 {
		t.Fatalf("unexpected spread basis points: %f", spread)
	}
	quote.AskMicros = quote.BidMicros - 1
	if _, err := quote.MidpointMicros(); err == nil {
		t.Fatal("crossed quote should not have midpoint")
	}
}

// TestCanonicalAmountUsesCurrencyScaleWithoutFloatingPoint 验证金额文本到整数
// 最小单位的解析:补零、去前导零、负数与非法表示(科学计数、千分位等)拒绝。
func TestCanonicalAmountUsesCurrencyScaleWithoutFloatingPoint(t *testing.T) {
	cases := []struct {
		text       string
		minorUnits int
		expected   int64
	}{
		{text: "17", minorUnits: 2, expected: 1_700},
		{text: "17.4", minorUnits: 2, expected: 1_740},
		{text: "0.01", minorUnits: 2, expected: 1},
		{text: "-903.125", minorUnits: 3, expected: -903_125},
		{text: " 0007.50 ", minorUnits: 2, expected: 750},
		{text: "0", minorUnits: 0, expected: 0},
	}
	for _, candidate := range cases {
		actual, err := CanonicalAmount(candidate.text, candidate.minorUnits)
		requireNoError(t, err)
		requireEqual(t, actual, candidate.expected)
	}
	invalid := []string{"", "+1.00", "1e3", "1.001", "--1", "1,000", ".50", "4_000"}
	for _, text := range invalid {
		if _, err := CanonicalAmount(text, 2); err == nil {
			t.Errorf("invalid amount %q was accepted", text)
		}
	}
	if _, err := CanonicalAmount("1", 9); err == nil {
		t.Fatal("unsupported minor-unit precision was accepted")
	}
}

// TestProviderBookRanksHealthyLocalCapacityFirst 验证候选排序:健康本地提供方
// 优于故障跨区域提供方,重复注册与未知观测被拒绝。
func TestProviderBookRanksHealthyLocalCapacityFirst(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "EUR/USD")
	book := &ProviderBook{}
	requireNoError(t, book.Register(ProviderProfile{
		Name: "local-fast", Region: "eu-west", Priority: 2, Pairs: []Pair{pair},
		CapacityPerSec: 10, ExpectedLatency: 8 * time.Millisecond, MaximumSpreadBPS: 5,
	}))
	requireNoError(t, book.Register(ProviderProfile{
		Name: "remote-slow", Region: "us-east", Priority: 1, Pairs: []Pair{pair},
		CapacityPerSec: 20, ExpectedLatency: 30 * time.Millisecond, MaximumSpreadBPS: 8,
	}))
	requireNoError(t, book.Observe(ProviderObservation{
		Provider: "local-fast", Pair: pair, At: clock.Now(), Latency: 7 * time.Millisecond,
		Success: true, Spread: 1.8, Kind: "quote",
	}))
	requireNoError(t, book.Observe(ProviderObservation{
		Provider: "remote-slow", Pair: pair, At: clock.Now(), Latency: 90 * time.Millisecond,
		Success: false, Spread: 7.5, Kind: "timeout",
	}))
	candidates, err := book.Candidates(pair, "eu-west", clock.Now())
	requireNoError(t, err)
	requireEqual(t, len(candidates), 2)
	requireEqual(t, candidates[0].Profile.Name, "local-fast")
	requireEqual(t, candidates[0].RecentCalls, 1)
	requireEqual(t, candidates[0].RecentFailures, 0)
	requireEqual(t, candidates[0].CapacityLeft, 9)
	requireEqual(t, candidates[1].RecentFailures, 1)
	if candidates[1].PreferenceOrder <= candidates[0].PreferenceOrder {
		t.Fatal("unhealthy remote provider should receive a larger preference score")
	}
	if err := book.Register(ProviderProfile{Name: "local-fast"}); err == nil {
		t.Fatal("duplicate provider profile should be rejected")
	}
	if err := book.Observe(ProviderObservation{Provider: "unknown", Pair: pair, At: clock.Now()}); err == nil {
		t.Fatal("unknown provider observation should be rejected")
	}
}

// TestQuoteAggregatorTrimsOutliersAndReportsContributors 验证聚合裁剪两端极端
// 报价后取中位数,贡献者列表与离散度正确,陈旧报价按策略被拒。
func TestQuoteAggregatorTrimsOutliersAndReportsContributors(t *testing.T) {
	clock := newManualClock()
	quotes := []Quote{
		sampleQuote(t, clock, "EUR/USD", "very-low", 1_070_000),
		sampleQuote(t, clock, "EUR/USD", "bank-a", 1_080_000),
		sampleQuote(t, clock, "EUR/USD", "bank-b", 1_080_100),
		sampleQuote(t, clock, "EUR/USD", "bank-c", 1_080_200),
		sampleQuote(t, clock, "EUR/USD", "very-high", 1_090_000),
	}
	aggregator := QuoteAggregator{Policy: AggregationPolicy{
		MinimumProviders: 3,
		MaximumAge:       time.Minute,
		MaximumSpreadBPS: 20,
		TrimEachSide:     1,
		PreferFresh:      true,
	}}
	result, err := aggregator.Aggregate(quotes, clock.Now())
	requireNoError(t, err)
	requireEqual(t, result.Provider, "aggregate")
	requireEqual(t, result.BidMicros, int64(1_080_100))
	requireEqual(t, result.AskMicros, int64(1_080_220))
	requireEqual(t, len(result.Contributors), 3)
	requireEqual(t, strings.Join(result.Contributors, ","), "bank-a,bank-b,bank-c")
	if result.Dispersion <= 0 {
		t.Fatal("non-identical contributor prices should have dispersion")
	}
	quotes[1].Stale = true
	_, err = aggregator.Aggregate(quotes[1:4], clock.Now())
	requireErrorIs(t, err, ErrQuoteUnavailable)
}

// TestRiskNettingReconcilesGrossAndStressValues 验证轧差的毛额/净额汇总与压力
// 测试的损失/流动性成本计算,重复来源被拒绝。
func TestRiskNettingReconcilesGrossAndStressValues(t *testing.T) {
	netting := RiskNetting{MaximumPositions: 20}
	positions := []CurrencyPosition{
		{Account: "alpha", Currency: "USD", Minor: 1_000_000, Source: "trade-1"},
		{Account: "beta", Currency: "USD", Minor: -350_000, Source: "trade-2"},
		{Account: "alpha", Currency: "EUR", Minor: -200_000, Source: "trade-3"},
		{Account: "gamma", Currency: "EUR", Minor: 50_000, Source: "trade-4"},
	}
	result, err := netting.Net(positions)
	requireNoError(t, err)
	requireEqual(t, len(result), 2)
	requireEqual(t, result[0].Currency, "USD")
	requireEqual(t, result[0].GrossLong, int64(1_000_000))
	requireEqual(t, result[0].GrossShort, int64(350_000))
	requireEqual(t, result[0].NetMinor, int64(650_000))
	requireEqual(t, result[0].AbsoluteAmount, uint64(650_000))
	stressed, err := netting.Stress(positions, []StressShock{
		{Currency: "USD", MoveBasisPoint: -500, LiquidityBPS: 20},
		{Currency: "EUR", MoveBasisPoint: 350, LiquidityBPS: 35},
	})
	requireNoError(t, err)
	requireEqual(t, len(stressed), 2)
	for _, position := range stressed {
		if position.LiquidityCostMinor < 0 {
			t.Fatal("liquidity cost must be non-negative")
		}
		requireEqual(t, position.RemainingMinor, position.NetMinor+position.MarketLossMinor-position.LiquidityCostMinor)
	}
	_, err = netting.Net(append(positions, positions[0]))
	if err == nil || !strings.Contains(err.Error(), "source repeats") {
		t.Fatalf("duplicate source should fail, got %v", err)
	}
}

// TestSessionCalendarHandlesWeekdaysHolidaysAndOvernightWindows 验证交易日历:
// 工作日窗口、跨午夜时段、节假日闭市与 NextOpen 顺延搜索。
func TestSessionCalendarHandlesWeekdaysHolidaysAndOvernightWindows(t *testing.T) {
	pair := mustPair(t, "EUR/USD")
	location := time.FixedZone("market", 2*60*60)
	calendar := SessionCalendar{Location: location, Sessions: []MarketSession{
		{
			Name: "weekday-day", Region: "eu", Weekdays: []time.Weekday{time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday},
			OpenMinute: 8 * 60, CloseMinute: 17 * 60, Holidays: []string{"2026-01-15"}, Pairs: []Pair{pair},
		},
		{
			Name: "overnight", Region: "global", Weekdays: []time.Weekday{time.Wednesday},
			OpenMinute: 22 * 60, CloseMinute: 2 * 60, Pairs: []Pair{pair},
		},
	}}
	wednesdayMorning := time.Date(2026, 1, 14, 9, 0, 0, 0, location)
	open, names, err := calendar.IsOpen(pair, wednesdayMorning)
	requireNoError(t, err)
	if !open || len(names) != 1 || names[0] != "weekday-day" {
		t.Fatalf("unexpected open sessions: %t %v", open, names)
	}
	wednesdayNight := time.Date(2026, 1, 14, 23, 0, 0, 0, location)
	open, names, err = calendar.IsOpen(pair, wednesdayNight)
	requireNoError(t, err)
	if !open || names[0] != "overnight" {
		t.Fatalf("overnight session should be open: %t %v", open, names)
	}
	holiday := time.Date(2026, 1, 15, 9, 0, 0, 0, location)
	open, _, err = calendar.IsOpen(pair, holiday)
	requireNoError(t, err)
	if open {
		t.Fatal("holiday closure should override weekday window")
	}
	next, session, err := calendar.NextOpen(pair, holiday, 48*time.Hour)
	requireNoError(t, err)
	requireEqual(t, session, "weekday-day")
	requireEqual(t, next.In(location).Format("2006-01-02 15:04"), "2026-01-16 08:00")
}

// TestSettlementPlannerAppliesCutoffWeekendAndHoliday 验证结算规划:截止后顺延、
// 跳过周末与节假日推算价值日,不支持的币种/目的国报错。
func TestSettlementPlannerAppliesCutoffWeekendAndHoliday(t *testing.T) {
	location := time.FixedZone("settlement", 60*60)
	planner := SettlementWindowPlanner{Location: location, Rails: []SettlementRail{
		{
			Name: "instant-euro", Currency: "EUR", Countries: []string{"DE", "FR"}, CutoffMinute: 16 * 60,
			BusinessDays: 1, MaximumAmount: 10_000_000, Priority: 1,
			WeekendDays: []time.Weekday{time.Saturday, time.Sunday}, HolidayDates: []string{"2026-01-19"},
		},
		{
			Name: "reserve-euro", Currency: "EUR", Countries: []string{"DE"}, CutoffMinute: 18 * 60,
			BusinessDays: 2, MaximumAmount: 20_000_000, Priority: 2,
		},
	}}
	instruction := SettlementInstruction{
		InstructionID: "settlement-44", Pair: mustPair(t, "USD/EUR"), AmountMinor: 2_500_000,
		Destination: "DE", RequestedDate: "2026-01-16",
		SubmittedAt: time.Date(2026, 1, 16, 16, 30, 0, 0, location),
	}
	choice, err := planner.Plan(instruction)
	requireNoError(t, err)
	requireEqual(t, choice.Rail, "instant-euro")
	if !choice.AfterCutoff {
		t.Fatal("submission after rail cutoff should be marked")
	}
	requireEqual(t, choice.ValueDate, "2026-01-21")
	requireEqual(t, strings.Join(choice.Alternatives, ","), "reserve-euro")
	instruction.Destination = "US"
	if _, err := planner.Plan(instruction); err == nil {
		t.Fatal("unsupported destination should fail")
	}
}

// TestQuotePathEncoderRoundTripsCanonicalRoutingPath 验证路由路径编码往返一致,
// 未知查询参数破坏规范性时解码失败。
func TestQuotePathEncoderRoundTripsCanonicalRoutingPath(t *testing.T) {
	encoder := QuotePathEncoder{Prefix: "quotes", MaximumHops: 5}
	path := QuotePath{
		Pair: mustPair(t, "GBP/USD"), Provider: "london-feed", Region: "eu-west",
		Hops: []string{"edge", "risk", "pricing"}, Revision: 19, Encrypted: true,
	}
	encoded, err := encoder.Encode(path)
	requireNoError(t, err)
	decoded, err := encoder.Decode(encoded)
	requireNoError(t, err)
	requireEqual(t, decoded.Pair, path.Pair)
	requireEqual(t, decoded.Provider, path.Provider)
	requireEqual(t, decoded.Region, path.Region)
	requireEqual(t, decoded.Revision, path.Revision)
	requireEqual(t, decoded.Encrypted, path.Encrypted)
	requireEqual(t, strings.Join(decoded.Hops, ","), strings.Join(path.Hops, ","))
	if _, err := encoder.Decode(encoded + "&unknown=value"); err == nil {
		t.Fatal("unknown query parameter should fail canonical decode")
	}
}

// TestCircuitDrawingIsDeterministicAndParseable 验证熔断拓扑渲染/解析往返一致
// 且按优先级排序,畸形行被拒绝。
func TestCircuitDrawingIsDeterministicAndParseable(t *testing.T) {
	drawing := CircuitDrawing{MaximumNodes: 10}
	nodes := []CircuitNode{
		{Name: "reserve", Mode: SourceOpen, Priority: 20, Pairs: []Pair{mustPair(t, "GBP/USD")}},
		{Name: "primary", Mode: SourceClosed, Priority: 10, Pairs: []Pair{mustPair(t, "EUR/USD"), mustPair(t, "GBP/USD")}},
	}
	text, err := drawing.Render(nodes)
	requireNoError(t, err)
	if strings.Index(text, "primary") > strings.Index(text, "reserve") {
		t.Fatal("drawing did not order nodes by priority")
	}
	parsed, err := drawing.Parse(text)
	requireNoError(t, err)
	requireEqual(t, len(parsed), 2)
	requireEqual(t, parsed[0].Name, "primary")
	requireEqual(t, parsed[1].Mode, SourceOpen)
	if _, err := drawing.Parse("header\nline\nnot|enough|columns"); err == nil {
		t.Fatal("malformed drawing row should fail")
	}
}

// TestMessageDigestDetectsEnvelopeAndPayloadChanges 验证摘要格式与校验,载荷
// 变更被检出,密钥过短被拒绝。
func TestMessageDigestDetectsEnvelopeAndPayloadChanges(t *testing.T) {
	digest := MessageDigest{Namespace: "trade-events", Key: []byte("0123456789abcdef0123456789abcdef")}
	message := DigestMessage{
		MessageID: "message-17", AccountID: "account-4", Sequence: 8,
		Headers: map[string]string{"Content-Type": "application/json", "Region": "eu-west"},
		Payload: []byte(`{"amount":12500,"currency":"EUR"}`),
	}
	sum, err := digest.Sum(message)
	requireNoError(t, err)
	if !strings.HasPrefix(sum, "trade-events:") || len(sum) != len("trade-events:")+64 {
		t.Fatalf("unexpected digest representation: %s", sum)
	}
	requireNoError(t, digest.Verify(message, sum))
	message.Payload[0] = '['
	if err := digest.Verify(message, sum); err == nil {
		t.Fatal("payload mutation should change digest")
	}
	if _, err := (MessageDigest{Namespace: "bad", Key: []byte("short")}).Sum(message); err == nil {
		t.Fatal("short digest key should fail")
	}
}

// TestAuditSorterOrdersAndVerifiesEntries 验证审计排序与校验:乱序无法通过
// Verify,重复 ID 被 Sort 拒绝。
func TestAuditSorterOrdersAndVerifiesEntries(t *testing.T) {
	clock := newManualClock()
	sorter := AuditTrailSorter{MaximumEntries: 20, RequireAccount: true}
	entries := []JournalEntry{
		sampleJournal(clock, "third", 3*time.Second),
		sampleJournal(clock, "first", time.Second),
		sampleJournal(clock, "second", 2*time.Second),
	}
	ordered, err := sorter.Sort(entries)
	requireNoError(t, err)
	requireEqual(t, ordered[0].ID, "first")
	requireEqual(t, ordered[1].ID, "second")
	requireEqual(t, ordered[2].ID, "third")
	requireNoError(t, sorter.Verify(ordered))
	if err := sorter.Verify(entries); err == nil {
		t.Fatal("unsorted audit trail should not verify")
	}
	entries = append(entries, entries[0])
	if _, err := sorter.Sort(entries); err == nil {
		t.Fatal("duplicate audit identifier should fail")
	}
}

// TestBatchWindowSizerBalancesLimits 验证批窗口在条数/字节/内存/延迟约束内
// 取值,非有限写入频率被拒绝。
func TestBatchWindowSizerBalancesLimits(t *testing.T) {
	input := BatchWindowInput{
		PendingRecords: 700, AverageRecordBytes: 400, WriterBytesPerSec: 200_000,
		WriterCallsPerSec: 10, OldestRecordAge: 200 * time.Millisecond, MaximumLatency: 2 * time.Second,
		MaximumBatchRecords: 250, MaximumBatchBytes: 80_000, MemoryBudgetBytes: 200_000,
	}
	window, err := (BatchWindowSizer{}).Size(input)
	requireNoError(t, err)
	if window.Records < 1 || window.Records > input.MaximumBatchRecords {
		t.Fatalf("batch records outside limits: %#v", window)
	}
	requireEqual(t, window.Bytes, window.Records*input.AverageRecordBytes)
	minimum, maximum, err := (BatchWindowSizer{}).Bounds(input)
	requireNoError(t, err)
	if minimum < 1 || maximum != window.Records || minimum > maximum {
		t.Fatalf("unexpected batch bounds: %d..%d for %#v", minimum, maximum, window)
	}
	input.WriterCallsPerSec = math.NaN()
	if _, err := (BatchWindowSizer{}).Size(input); err == nil {
		t.Fatal("non-finite writer rate should fail")
	}
}

// TestProviderFailureSupportsErrorsIsAndMetadata 验证 ProviderFailure 的错误链
// 与展示文本包含提供方、原因与类别。
func TestProviderFailureSupportsErrorsIsAndMetadata(t *testing.T) {
	cause := errors.New("socket closed")
	failure := ProviderFailure{Provider: "test-feed", Kind: "transport", Retryable: true, Cause: cause}
	if !errors.Is(failure, cause) {
		t.Fatal("provider failure should unwrap cause")
	}
	for _, fragment := range []string{"test-feed", "socket closed", "transport"} {
		if !strings.Contains(failure.Error(), fragment) {
			t.Fatalf("provider failure lacks %q: %s", fragment, failure.Error())
		}
	}
}
