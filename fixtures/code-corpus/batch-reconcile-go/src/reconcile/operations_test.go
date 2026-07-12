package reconcile

import (
	"math"
	"strings"
	"testing"
	"time"
)

func TestRankClearingRoutesCombinesReliabilityFeeAndLatency(t *testing.T) {
	observations := []RouteObservation{
		{Route: "fast-expensive", Currency: CurrencyUSD, FeeMinor: 20, Latency: 10 * time.Millisecond, Succeeded: true, ObservedAt: testEpoch, Provider: "provider-a"},
		{Route: "fast-expensive", Currency: CurrencyUSD, FeeMinor: 22, Latency: 12 * time.Millisecond, Succeeded: true, ObservedAt: testEpoch.Add(time.Minute), Provider: "provider-a"},
		{Route: "fast-expensive", Currency: CurrencyUSD, FeeMinor: 18, Latency: 9 * time.Millisecond, Succeeded: true, ObservedAt: testEpoch.Add(2 * time.Minute), Provider: "provider-a"},
		{Route: "cheap-reliable", Currency: CurrencyUSD, FeeMinor: 4, Latency: 70 * time.Millisecond, Succeeded: true, ObservedAt: testEpoch, Provider: "provider-b"},
		{Route: "cheap-reliable", Currency: CurrencyUSD, FeeMinor: 5, Latency: 75 * time.Millisecond, Succeeded: true, ObservedAt: testEpoch.Add(time.Minute), Provider: "provider-b"},
		{Route: "cheap-reliable", Currency: CurrencyUSD, FeeMinor: 3, Latency: 65 * time.Millisecond, Succeeded: true, ObservedAt: testEpoch.Add(2 * time.Minute), Provider: "provider-b"},
		{Route: "unstable", Currency: CurrencyUSD, FeeMinor: 1, Latency: 5 * time.Millisecond, Succeeded: false, ObservedAt: testEpoch, Provider: "provider-c"},
		{Route: "unstable", Currency: CurrencyUSD, FeeMinor: 1, Latency: 6 * time.Millisecond, Succeeded: true, ObservedAt: testEpoch.Add(time.Minute), Provider: "provider-c"},
		{Route: "euro-main", Currency: CurrencyEUR, FeeMinor: 6, Latency: 40 * time.Millisecond, Succeeded: true, ObservedAt: testEpoch, Provider: "provider-d"},
	}
	feeFocused := RankClearingRoutes(observations, 1, 0.001, 100)
	if len(feeFocused) != 4 {
		t.Fatalf("route count %d, want 4", len(feeFocused))
	}
	if feeFocused[0].Route != "cheap-reliable" {
		t.Errorf("fee-focused winner: %+v", feeFocused[0])
	}
	var fast RouteScore
	for _, score := range feeFocused {
		if score.Route == "fast-expensive" {
			fast = score
		}
	}
	if fast.ObservationCount != 3 || fast.SuccessRatio != 1 || fast.MedianLatency != 10*time.Millisecond || fast.P95Latency != 12*time.Millisecond || fast.AverageFeeMinor != 20 {
		t.Errorf("fast route aggregate: %+v", fast)
	}
	latencyFocused := RankClearingRoutes(observations, 0.01, 1, 1_000)
	if latencyFocused[0].Route != "fast-expensive" {
		t.Errorf("latency-focused winner: %+v", latencyFocused[0])
	}
}

func TestRankClearingRoutesSkipsMalformedObservations(t *testing.T) {
	observations := []RouteObservation{
		{Route: "", Currency: CurrencyUSD, FeeMinor: 1, Latency: time.Millisecond, Succeeded: true},
		{Route: "bad-currency", Currency: "XYZ", FeeMinor: 1, Latency: time.Millisecond, Succeeded: true},
		{Route: "negative-fee", Currency: CurrencyUSD, FeeMinor: -1, Latency: time.Millisecond, Succeeded: true},
		{Route: "negative-latency", Currency: CurrencyUSD, FeeMinor: 1, Latency: -time.Millisecond, Succeeded: true},
		{Route: "valid", Currency: CurrencyCAD, FeeMinor: 7, Latency: 30 * time.Millisecond, Succeeded: false},
	}
	ranked := RankClearingRoutes(observations, 1, 1, 1)
	if len(ranked) != 1 || ranked[0].Route != "valid" || ranked[0].SuccessRatio != 0 {
		t.Errorf("ranked malformed set: %+v", ranked)
	}
}

func TestBucketOutstandingPaymentsUsesSortedUniqueBoundaries(t *testing.T) {
	payments := []Payment{
		testPayment("age-new", "s1", "t1", CurrencyUSD, 100, -10*time.Minute),
		testPayment("age-hour", "s2", "t2", CurrencyEUR, 200, -time.Hour),
		testPayment("age-day", "s3", "t3", CurrencyUSD, 300, -24*time.Hour),
		testPayment("age-week", "s4", "t4", CurrencyGBP, 400, -7*24*time.Hour),
		testPayment("age-future", "s5", "t5", CurrencyUSD, 500, time.Hour),
	}
	bands := BucketOutstandingPayments(payments, testEpoch, []time.Duration{48 * time.Hour, time.Hour, 24 * time.Hour, time.Hour, -time.Minute})
	if len(bands) != 4 {
		t.Fatalf("band count %d, want 4: %+v", len(bands), bands)
	}
	if bands[0].Count != 2 || bands[0].AmountByCurrency[CurrencyUSD] != 600 {
		t.Errorf("fresh band: %+v", bands[0])
	}
	if bands[1].Count != 1 || bands[1].AmountByCurrency[CurrencyEUR] != 200 {
		t.Errorf("hour band: %+v", bands[1])
	}
	if bands[2].Count != 1 || bands[2].AmountByCurrency[CurrencyUSD] != 300 {
		t.Errorf("day band: %+v", bands[2])
	}
	if bands[3].Count != 1 || !strings.Contains(bands[3].Name, "older") {
		t.Errorf("old band: %+v", bands[3])
	}
}

func TestTraceReceiptLineageOrdersDepthAndFindsOrphans(t *testing.T) {
	root := storedReceipt("lineage-root", "lineage-batch", 0)
	childA := storedReceipt("lineage-a", "lineage-batch", time.Second)
	childB := storedReceipt("lineage-b", "lineage-batch", 2*time.Second)
	grandchild := storedReceipt("lineage-grand", "lineage-batch", 3*time.Second)
	orphan := storedReceipt("lineage-orphan", "lineage-batch", 4*time.Second)
	parents := map[string][]string{
		childA.ReceiptID:     {root.ReceiptID},
		childB.ReceiptID:     {root.ReceiptID},
		grandchild.ReceiptID: {childA.ReceiptID, childB.ReceiptID},
		orphan.ReceiptID:     {"missing-receipt"},
	}
	nodes, issues := TraceReceiptLineage([]Receipt{grandchild, childB, root, orphan, childA}, parents)
	if len(nodes) != 5 {
		t.Fatalf("node count %d", len(nodes))
	}
	byID := make(map[string]ReceiptLineageNode)
	for _, node := range nodes {
		byID[node.ReceiptID] = node
	}
	if byID[root.ReceiptID].Depth != 0 || byID[childA.ReceiptID].Depth != 1 || byID[grandchild.ReceiptID].Depth != 2 {
		t.Errorf("depths: %+v", byID)
	}
	if strings.Join(byID[root.ReceiptID].Children, ",") != childA.ReceiptID+","+childB.ReceiptID {
		t.Errorf("root children: %+v", byID[root.ReceiptID].Children)
	}
	if !byID[orphan.ReceiptID].Orphaned {
		t.Error("missing parent should mark orphan")
	}
	if len(issues) != 1 || !strings.Contains(issues[0], "missing parent") {
		t.Errorf("lineage issues: %+v", issues)
	}
}

func TestTraceReceiptLineageReportsDuplicateAndCycle(t *testing.T) {
	first := storedReceipt("cycle-a", "cycle-batch", 0)
	second := storedReceipt("cycle-b", "cycle-batch", time.Second)
	parents := map[string][]string{
		first.ReceiptID:  {second.ReceiptID},
		second.ReceiptID: {first.ReceiptID},
	}
	nodes, issues := TraceReceiptLineage([]Receipt{first, second, first}, parents)
	if len(nodes) != 2 {
		t.Errorf("cycle nodes: %+v", nodes)
	}
	joined := strings.Join(issues, "|")
	if !strings.Contains(joined, "duplicate") || !strings.Contains(joined, "cycle") {
		t.Errorf("cycle issues: %+v", issues)
	}
}

func TestInspectIdempotencyKeysReportsPositionsPrefixesAndDigest(t *testing.T) {
	keys := []string{
		"pay-eu-0001",
		"pay-us-0002",
		"invoice:0003",
		" pay-eu-0001 ",
		"",
		"   ",
		"batch_0004",
		"PAY-apac-0005",
		"batch_0004",
	}
	report := InspectIdempotencyKeys(keys)
	if report.Total != 9 || report.Unique != 5 {
		t.Errorf("key totals: %+v", report)
	}
	if strings.Join([]string{string(rune('0' + report.Blank[0])), string(rune('0' + report.Blank[1]))}, "") != "45" {
		t.Errorf("blank positions: %+v", report.Blank)
	}
	if positions := report.Duplicates["pay-eu-0001"]; len(positions) != 2 || positions[0] != 0 || positions[1] != 3 {
		t.Errorf("pay duplicate positions: %+v", positions)
	}
	if positions := report.Duplicates["batch_0004"]; len(positions) != 2 || positions[0] != 6 || positions[1] != 8 {
		t.Errorf("batch duplicate positions: %+v", positions)
	}
	if report.PrefixCounts["pay"] != 4 || report.PrefixCounts["invoice"] != 1 || report.PrefixCounts["batch"] != 2 || report.PrefixCounts["pay"]+report.PrefixCounts["invoice"]+report.PrefixCounts["batch"] != 7 {
		t.Errorf("prefix counts: %+v", report.PrefixCounts)
	}
	if len(report.Digest) != 64 {
		t.Errorf("digest length %d", len(report.Digest))
	}
	if InspectIdempotencyKeys(keys).Digest != report.Digest {
		t.Error("key digest should be deterministic")
	}
}

func TestQuoteSeriesSummarizeIgnoresNonFiniteValues(t *testing.T) {
	series := QuoteSeries{}
	if got := series.Summarize(nil); got != "empty" {
		t.Errorf("empty summary %q", got)
	}
	if got := series.Summarize([]float64{math.NaN(), math.Inf(1), math.Inf(-1)}); got != "empty" {
		t.Errorf("non-finite summary %q", got)
	}
	got := series.Summarize([]float64{1.4, 0.9, 1.1, math.NaN(), 2.2})
	if got != "count=4 min=0.900000 median=1.100000 max=2.200000" {
		t.Errorf("summary %q", got)
	}
}

func TestProviderInvoiceRouterUsesLongestMatchingPrefix(t *testing.T) {
	router := ProviderInvoiceRouter{
		RegionPrefixes: map[string]string{
			"EU-":    "europe-general",
			"EU-DE-": "germany-special",
			"APAC-":  "asia-pacific",
		},
		DefaultQueue: "global-default",
	}
	tests := map[string]string{
		" eu-de-7788 ": "germany-special",
		"EU-FR-1000":   "europe-general",
		"apac-9000":    "asia-pacific",
		"US-1234":      "global-default",
		"":             "global-default",
	}
	for invoice, want := range tests {
		if got := router.Route(invoice); got != want {
			t.Errorf("invoice %q routed %q, want %q", invoice, got, want)
		}
	}
}

func TestTradeEventChartMaintainsRollingFiniteWindow(t *testing.T) {
	chart := TradeEventChart{Limit: 3}
	if chart.Add(1.1) != 1 || chart.Add(2.2) != 2 || chart.Add(3.3) != 3 {
		t.Errorf("initial chart: %+v", chart.Points)
	}
	if count := chart.Add(math.NaN()); count != 3 {
		t.Errorf("NaN count %d", count)
	}
	chart.Add(4.4)
	chart.Add(math.Inf(1))
	chart.Add(5.5)
	wants := []float64{3.3, 4.4, 5.5}
	if len(chart.Points) != len(wants) {
		t.Fatalf("chart points: %+v", chart.Points)
	}
	for index, want := range wants {
		if chart.Points[index] != want {
			t.Errorf("point %d %.1f, want %.1f", index, chart.Points[index], want)
		}
	}
}

func TestAuditFlushGraphNormalizesUniqueLabels(t *testing.T) {
	graph := AuditFlushGraph{}
	labels := []string{" zulu ", "Alpha", "alpha", "", "Beta", "Beta", "delta", "  "}
	flushed := graph.FlushAxis(labels)
	if strings.Join(flushed, ",") != "Alpha,alpha,Beta,delta,zulu" {
		t.Errorf("flushed labels: %+v", flushed)
	}
	if len(labels) != 8 || labels[0] != " zulu " {
		t.Error("flush axis mutated input")
	}
}
