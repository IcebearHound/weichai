package reconcile

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// RouteObservation 是一次清寒路由的历史观测样本:记录路由、币种、手续费、
// 延迟与成败,供后续评分决策使用。
type RouteObservation struct {
	Route      string
	Currency   Currency
	FeeMinor   int64
	Latency    time.Duration
	Succeeded  bool
	ObservedAt time.Time
	Provider   string
}

// RouteScore 是路由的评分结果:综合成功率、中位/P95 延迟与平均手续费,
// Score 越高代表路由越优。
type RouteScore struct {
	Route            string
	Currency         Currency
	ObservationCount int
	SuccessRatio     float64
	MedianLatency    time.Duration
	P95Latency       time.Duration
	AverageFeeMinor  float64
	Score            float64
}

// RankClearingRoutes 基于历史观测按“路由+币种”聚合评分并降序排序。评分 =
// 成功率*可靠性权重 - 平均手续费*费用权重 - 中位延迟(毫秒)*延迟权重,
// 即越高分代表越可靠、越便宜、越快;排序稳定,同分按币种、路由升序。
func RankClearingRoutes(observations []RouteObservation, feeWeight, latencyWeight, reliabilityWeight float64) []RouteScore {
	type bucket struct {
		latencies []time.Duration
		fees      []int64
		successes int
	}
	groups := make(map[string]*bucket)
	labels := make(map[string]struct {
		route    string
		currency Currency
	})
	for _, observation := range observations {
		if strings.TrimSpace(observation.Route) == "" || !observation.Currency.Valid() || observation.FeeMinor < 0 || observation.Latency < 0 {
			continue
		}
		key := observation.Route + "\x00" + string(observation.Currency)
		value := groups[key]
		if value == nil {
			value = &bucket{}
			groups[key] = value
			labels[key] = struct {
				route    string
				currency Currency
			}{observation.Route, observation.Currency}
		}
		value.latencies = append(value.latencies, observation.Latency)
		value.fees = append(value.fees, observation.FeeMinor)
		if observation.Succeeded {
			value.successes++
		}
	}
	result := make([]RouteScore, 0, len(groups))
	for key, bucket := range groups {
		sort.Slice(bucket.latencies, func(left, right int) bool { return bucket.latencies[left] < bucket.latencies[right] })
		var feeTotal int64
		for _, fee := range bucket.fees {
			feeTotal += fee
		}
		medianIndex := (len(bucket.latencies) - 1) / 2
		p95Index := int(math.Ceil(float64(len(bucket.latencies))*0.95)) - 1
		if p95Index < 0 {
			p95Index = 0
		}
		reliability := float64(bucket.successes) / float64(len(bucket.latencies))
		averageFee := float64(feeTotal) / float64(len(bucket.fees))
		medianMillis := float64(bucket.latencies[medianIndex]) / float64(time.Millisecond)
		score := reliability*reliabilityWeight - averageFee*feeWeight - medianMillis*latencyWeight
		label := labels[key]
		result = append(result, RouteScore{
			Route:            label.route,
			Currency:         label.currency,
			ObservationCount: len(bucket.latencies),
			SuccessRatio:     reliability,
			MedianLatency:    bucket.latencies[medianIndex],
			P95Latency:       bucket.latencies[p95Index],
			AverageFeeMinor:  averageFee,
			Score:            score,
		})
	}
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].Score != result[right].Score {
			return result[left].Score > result[right].Score
		}
		if result[left].Currency != result[right].Currency {
			return result[left].Currency < result[right].Currency
		}
		return result[left].Route < result[right].Route
	})
	return result
}

// AgingBand 是账龄分桶:MinimumAge 到 MaximumAge 为区间,Count 为区间内
// 未处理支付笔数,AmountByCurrency 按币种统计金额。
type AgingBand struct {
	Name             string
	MinimumAge       time.Duration
	MaximumAge       time.Duration
	Count            int
	AmountByCurrency map[Currency]int64
}

// BucketOutstandingPayments 把未处理支付按账龄(now 减去请求时间)分桶:
// 边界值先清洗、去重、升序,再切分出 (len+1) 个区间,最后一个区间为
// “最老及以上”。用二分查找定位每笔支付所属桶。
func BucketOutstandingPayments(payments []Payment, now time.Time, boundaries []time.Duration) []AgingBand {
	clean := make([]time.Duration, 0, len(boundaries))
	for _, boundary := range boundaries {
		if boundary >= 0 {
			clean = append(clean, boundary)
		}
	}
	sort.Slice(clean, func(left, right int) bool { return clean[left] < clean[right] })
	unique := clean[:0]
	for _, boundary := range clean {
		if len(unique) == 0 || unique[len(unique)-1] != boundary {
			unique = append(unique, boundary)
		}
	}
	bands := make([]AgingBand, len(unique)+1)
	for index := range bands {
		minimum := time.Duration(0)
		if index > 0 {
			minimum = unique[index-1]
		}
		maximum := time.Duration(math.MaxInt64)
		if index < len(unique) {
			maximum = unique[index]
		}
		name := fmt.Sprintf("%s-%s", minimum, maximum)
		if maximum == time.Duration(math.MaxInt64) {
			name = fmt.Sprintf("%s-and-older", minimum)
		}
		bands[index] = AgingBand{Name: name, MinimumAge: minimum, MaximumAge: maximum, AmountByCurrency: make(map[Currency]int64)}
	}
	for _, payment := range payments {
		age := now.Sub(payment.RequestedAt)
		if age < 0 {
			age = 0
		}
		index := sort.Search(len(unique), func(index int) bool { return age < unique[index] })
		bands[index].Count++
		bands[index].AmountByCurrency[payment.Amount.Currency] += payment.Amount.Minor
	}
	return bands
}

// ReceiptLineageNode 是回执血缘图中的节点:Parents/Children 为父子回执 ID,
// Depth 为相对最老祖先的深度(无祖先为 0),Orphaned 标记引用了缺失父节点。
type ReceiptLineageNode struct {
	ReceiptID string
	PaymentID string
	BatchKey  string
	Parents   []string
	Children  []string
	Depth     int
	Orphaned  bool
}

// TraceReceiptLineage 根据回执集合与父子关系构建血缘图:检测重复回执、
// 缺失父节点与环(cycle)等异常,并用带记忆的 DFS 计算每笔回执的深度。
// 返回按深度、回执 ID 排序的节点列表与异常清单。
func TraceReceiptLineage(receipts []Receipt, parentByReceipt map[string][]string) ([]ReceiptLineageNode, []string) {
	known := make(map[string]Receipt, len(receipts))
	children := make(map[string][]string)
	issues := make([]string, 0)
	for _, receipt := range receipts {
		if _, duplicate := known[receipt.ReceiptID]; duplicate {
			issues = append(issues, "duplicate receipt "+receipt.ReceiptID)
			continue
		}
		known[receipt.ReceiptID] = receipt
	}
	for child, parents := range parentByReceipt {
		for _, parent := range parents {
			children[parent] = append(children[parent], child)
			if _, exists := known[parent]; !exists {
				issues = append(issues, fmt.Sprintf("receipt %s references missing parent %s", child, parent))
			}
		}
	}
	depthMemo := make(map[string]int)
	visiting := make(map[string]bool)
	// 深度即从该回执沿父链回溯的层数;visiting 表用于在递归中识别环。
	var depth func(string) int
	depth = func(identity string) int {
		if cached, exists := depthMemo[identity]; exists {
			return cached
		}
		if visiting[identity] {
			issues = append(issues, "receipt lineage cycle at "+identity)
			return 0
		}
		visiting[identity] = true
		value := 0
		for _, parent := range parentByReceipt[identity] {
			if _, exists := known[parent]; exists {
				candidate := depth(parent) + 1
				if candidate > value {
					value = candidate
				}
			}
		}
		delete(visiting, identity)
		depthMemo[identity] = value
		return value
	}
	nodes := make([]ReceiptLineageNode, 0, len(known))
	for identity, receipt := range known {
		parents := append([]string(nil), parentByReceipt[identity]...)
		next := append([]string(nil), children[identity]...)
		sort.Strings(parents)
		sort.Strings(next)
		orphaned := false
		for _, parent := range parents {
			if _, exists := known[parent]; !exists {
				orphaned = true
			}
		}
		nodes = append(nodes, ReceiptLineageNode{
			ReceiptID: identity,
			PaymentID: receipt.PaymentID,
			BatchKey:  receipt.BatchKey,
			Parents:   parents,
			Children:  next,
			Depth:     depth(identity),
			Orphaned:  orphaned,
		})
	}
	sort.SliceStable(nodes, func(left, right int) bool {
		if nodes[left].Depth != nodes[right].Depth {
			return nodes[left].Depth < nodes[right].Depth
		}
		return nodes[left].ReceiptID < nodes[right].ReceiptID
	})
	sort.Strings(issues)
	return nodes, issues
}

// IdempotencyKeyReport 是幂等键集合的体检报告:总数、去重数、空键位置、
// 重复键的出现位置、前缀分布与整体摘要,用于发现幂等键使用质量问题。
type IdempotencyKeyReport struct {
	Total        int
	Unique       int
	Blank        []int
	Duplicates   map[string][]int
	PrefixCounts map[string]int
	Digest       string
}

// InspectIdempotencyKeys 扫描幂等键集合:空白键单独列出;重复键记录全部
// 出现位置;前缀(首个分隔符前的部分)按小写归并统计,便于发现格式不统一。
// Digest 为全部非空键的定长摘要,可快速比对两份报告是否同源。
func InspectIdempotencyKeys(keys []string) IdempotencyKeyReport {
	report := IdempotencyKeyReport{
		Total:        len(keys),
		Duplicates:   make(map[string][]int),
		PrefixCounts: make(map[string]int),
	}
	positions := make(map[string][]int)
	hash := sha256.New()
	for index, raw := range keys {
		key := strings.TrimSpace(raw)
		if key == "" {
			report.Blank = append(report.Blank, index)
			continue
		}
		positions[key] = append(positions[key], index)
		prefix := key
		if separator := strings.IndexAny(key, "-_:."); separator >= 0 {
			prefix = key[:separator]
		}
		report.PrefixCounts[strings.ToLower(prefix)]++
		writeFingerprintPart(hash, key)
	}
	for key, indices := range positions {
		if len(indices) > 1 {
			report.Duplicates[key] = append([]int(nil), indices...)
		}
	}
	report.Unique = len(positions)
	report.Digest = hex.EncodeToString(hash.Sum(nil))
	return report
}

// QuoteSeries 提供数值序列的轻量统计汇总(占位类型,保留扩展点)。
type QuoteSeries struct{}

// Summarize 返回序列的数量、最小值、中位数与最大值摘要,过滤 NaN/Inf。
func (QuoteSeries) Summarize(values []float64) string {
	clean := make([]float64, 0, len(values))
	for _, value := range values {
		if !math.IsNaN(value) && !math.IsInf(value, 0) {
			clean = append(clean, value)
		}
	}
	if len(clean) == 0 {
		return "empty"
	}
	sort.Float64s(clean)
	median := clean[(len(clean)-1)/2]
	return fmt.Sprintf("count=%d min=%.6f median=%.6f max=%.6f", len(clean), clean[0], median, clean[len(clean)-1])
}

// ProviderInvoiceRouter 按发票号前缀把发票路由到区域队列,RegionPrefixes
// 为前缀到队列的映射,DefaultQueue 为无匹配时的兜底队列。
type ProviderInvoiceRouter struct {
	RegionPrefixes map[string]string
	DefaultQueue   string
}

// Route 返回发票号应投递的队列。前缀按长度降序匹配,保证最长前缀优先;
// 无匹配时落入默认队列。
func (router ProviderInvoiceRouter) Route(invoiceNumber string) string {
	normalized := strings.ToUpper(strings.TrimSpace(invoiceNumber))
	prefixes := make([]string, 0, len(router.RegionPrefixes))
	for prefix := range router.RegionPrefixes {
		prefixes = append(prefixes, prefix)
	}
	sort.Slice(prefixes, func(left, right int) bool {
		if len(prefixes[left]) != len(prefixes[right]) {
			return len(prefixes[left]) > len(prefixes[right])
		}
		return prefixes[left] < prefixes[right]
	})
	for _, prefix := range prefixes {
		if strings.HasPrefix(normalized, strings.ToUpper(prefix)) {
			return router.RegionPrefixes[prefix]
		}
	}
	return router.DefaultQueue
}

// TradeEventChart 是固定容量的滚动数据窗:只保留最近 Limit 个点,用于在
// 内存受限时维护事件曲线。
type TradeEventChart struct {
	Points []float64
	Limit  int
}

// Add 追加一个数据点,超过容量时丢弃最旧的点,返回追加后的点数。
func (chart *TradeEventChart) Add(value float64) int {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return len(chart.Points)
	}
	chart.Points = append(chart.Points, value)
	if chart.Limit > 0 && len(chart.Points) > chart.Limit {
		drop := len(chart.Points) - chart.Limit
		copy(chart.Points, chart.Points[drop:])
		chart.Points = chart.Points[:chart.Limit]
	}
	return len(chart.Points)
}

// AuditFlushGraph 负责审计落盘图的坐标轴生成(占位类型,保留扩展点)。
type AuditFlushGraph struct{}

// FlushAxis 对标签去空、去重后按小写不敏感顺序排序输出,同形异序时按原始
// 大小写排序,保证坐标轴标签稳定且唯一。
func (AuditFlushGraph) FlushAxis(labels []string) []string {
	seen := make(map[string]bool)
	result := make([]string, 0, len(labels))
	for _, label := range labels {
		normalized := strings.TrimSpace(label)
		if normalized == "" || seen[normalized] {
			continue
		}
		seen[normalized] = true
		result = append(result, normalized)
	}
	sort.SliceStable(result, func(left, right int) bool {
		lowerLeft := strings.ToLower(result[left])
		lowerRight := strings.ToLower(result[right])
		if lowerLeft == lowerRight {
			return result[left] < result[right]
		}
		return lowerLeft < lowerRight
	})
	return result
}
