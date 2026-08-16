package fanout

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"time"
)

// AggregationPolicy 定义聚合规则:最少提供方数、报价最大年龄、最大价差(基点)、
// 排序后两端各裁剪的数量与是否优先新鲜报价。
type AggregationPolicy struct {
	MinimumProviders int
	MaximumAge       time.Duration
	MaximumSpreadBPS float64
	TrimEachSide     int
	PreferFresh      bool
}

// AggregatedQuote 是聚合结果:聚合后的报价(中位价),Contributors 为参与聚合
// 的提供方,Rejected 记录被拒绝的提供方及原因,Dispersion 为报价中值离散度。
type AggregatedQuote struct {
	Quote
	Contributors []string
	Rejected     map[string]string
	Dispersion   float64
}

// QuoteAggregator 按策略聚合多家提供方的报价(占位实现,值接收者)。
type QuoteAggregator struct {
	Policy AggregationPolicy
}

// Aggregate 聚合报价:先筛选(合法、同货币对、不重复、不过龄、价差与新鲜度
// 达标),按中值排序后裁剪两端极端报价,再取买卖中位数作为聚合价;同时计算
// 离散度,并在离散度超限、价差超限等情形下拒绝整个聚合。
func (aggregator QuoteAggregator) Aggregate(quotes []Quote, now time.Time) (AggregatedQuote, error) {
	policy := aggregator.Policy
	if policy.MinimumProviders < 1 {
		return AggregatedQuote{}, errors.New("aggregation minimum providers must be positive")
	}
	if policy.MaximumAge <= 0 || policy.MaximumAge > 24*time.Hour {
		return AggregatedQuote{}, errors.New("aggregation maximum age is invalid")
	}
	if policy.MaximumSpreadBPS <= 0 || policy.MaximumSpreadBPS > 10_000 {
		return AggregatedQuote{}, errors.New("aggregation maximum spread is invalid")
	}
	if policy.TrimEachSide < 0 {
		return AggregatedQuote{}, errors.New("aggregation trim count cannot be negative")
	}
	if now.IsZero() {
		return AggregatedQuote{}, errors.New("aggregation time is missing")
	}
	if len(quotes) == 0 {
		return AggregatedQuote{}, ErrQuoteUnavailable
	}
	rejected := make(map[string]string)
	providerSeen := make(map[string]struct{})
	valid := make([]Quote, 0, len(quotes))
	var pair Pair
	for index, quote := range quotes {
		if err := quote.Validate(now); err != nil {
			rejected[fmt.Sprintf("index-%d", index)] = err.Error()
			continue
		}
		if index == 0 || pair == (Pair{}) {
			pair = quote.Pair
		}
		if quote.Pair != pair {
			rejected[quote.Provider] = "currency pair differs"
			continue
		}
		if _, duplicate := providerSeen[quote.Provider]; duplicate {
			rejected[quote.Provider] = "provider contributed more than once"
			continue
		}
		providerSeen[quote.Provider] = struct{}{}
		if now.Sub(quote.ObservedAt) > policy.MaximumAge {
			rejected[quote.Provider] = "quote is too old"
			continue
		}
		spread, err := quote.SpreadBasisPoints()
		if err != nil || spread > policy.MaximumSpreadBPS {
			rejected[quote.Provider] = "quote spread exceeds policy"
			continue
		}
		if policy.PreferFresh && quote.Stale {
			rejected[quote.Provider] = "stale quote rejected by freshness preference"
			continue
		}
		valid = append(valid, cloneQuote(quote))
	}
	if len(valid) < policy.MinimumProviders {
		return AggregatedQuote{}, fmt.Errorf("%w: received %d eligible providers, need %d",
			ErrQuoteUnavailable, len(valid), policy.MinimumProviders)
	}
	if policy.TrimEachSide > 0 && len(valid) < policy.MinimumProviders+policy.TrimEachSide*2 {
		return AggregatedQuote{}, errors.New("aggregation has too few providers after configured trimming")
	}
	sort.Slice(valid, func(left, right int) bool {
		leftMid, _ := valid[left].MidpointMicros()
		rightMid, _ := valid[right].MidpointMicros()
		if leftMid != rightMid {
			return leftMid < rightMid
		}
		return valid[left].Provider < valid[right].Provider
	})
	if policy.TrimEachSide*2 >= len(valid) {
		return AggregatedQuote{}, errors.New("aggregation trimming removes every quote")
	}
	// 按中值排序后从两端各裁剪 TrimEachSide 条,剔除可能操纵价格的极端报价。
	trimmed := valid[policy.TrimEachSide : len(valid)-policy.TrimEachSide]
	if len(trimmed) < policy.MinimumProviders {
		return AggregatedQuote{}, errors.New("aggregation trimmed below minimum provider count")
	}
	bids := make([]int64, len(trimmed))
	asks := make([]int64, len(trimmed))
	contributors := make([]string, len(trimmed))
	latestObservation := trimmed[0].ObservedAt
	earliestExpiry := trimmed[0].ExpiresAt
	for index, quote := range trimmed {
		bids[index] = quote.BidMicros
		asks[index] = quote.AskMicros
		contributors[index] = quote.Provider
		if quote.ObservedAt.After(latestObservation) {
			latestObservation = quote.ObservedAt
		}
		if quote.ExpiresAt.Before(earliestExpiry) {
			earliestExpiry = quote.ExpiresAt
		}
	}
	if len(contributors) != len(trimmed) {
		return AggregatedQuote{}, errors.New("aggregation contributor count is inconsistent")
	}
	for index := 1; index < len(contributors); index++ {
		if contributors[index-1] == contributors[index] {
			return AggregatedQuote{}, errors.New("aggregation retained duplicate contributor")
		}
	}
	sort.Slice(bids, func(left, right int) bool { return bids[left] < bids[right] })
	sort.Slice(asks, func(left, right int) bool { return asks[left] < asks[right] })
	sort.Strings(contributors)
	median := func(values []int64) int64 {
		middle := len(values) / 2
		if len(values)%2 == 1 {
			return values[middle]
		}
		return values[middle-1] + (values[middle]-values[middle-1])/2
	}
	bid := median(bids)
	ask := median(asks)
	if ask < bid {
		// 偶数组裁剪后可能出现卖中位数低于买中位数,收敛到两者的中点。
		midpoint := bid + (ask-bid)/2
		bid = midpoint
		ask = midpoint
	}
	midpoints := make([]float64, len(trimmed))
	var mean float64
	for index, quote := range trimmed {
		mid, _ := quote.MidpointMicros()
		midpoints[index] = float64(mid)
		mean += float64(mid)
	}
	mean /= float64(len(midpoints))
	var variance float64
	for _, midpoint := range midpoints {
		difference := midpoint - mean
		variance += difference * difference
	}
	variance /= float64(len(midpoints))
	dispersion := math.Sqrt(variance)
	if math.IsNaN(dispersion) || math.IsInf(dispersion, 0) {
		return AggregatedQuote{}, errors.New("aggregation dispersion is non-finite")
	}
	if mean > 0 && dispersion/mean*10_000 > policy.MaximumSpreadBPS*4 {
		return AggregatedQuote{}, errors.New("provider midpoint dispersion exceeds aggregation tolerance")
	}
	staleContributors := 0
	for _, quote := range trimmed {
		if quote.Stale {
			staleContributors++
		}
	}
	resultStale := staleContributors == len(trimmed)
	if staleContributors > 0 && staleContributors < len(trimmed) {
		rejected["freshness-mixture"] = fmt.Sprintf("%d stale contributors retained", staleContributors)
	}
	result := Quote{
		Pair:       pair,
		BidMicros:  bid,
		AskMicros:  ask,
		Provider:   "aggregate",
		ObservedAt: latestObservation,
		ExpiresAt:  earliestExpiry,
		Stale:      resultStale,
		Tags: map[string]string{
			"method":       "trimmed-median",
			"contributors": fmt.Sprintf("%d", len(contributors)),
			"discarded":    fmt.Sprintf("%d", len(rejected)),
		},
	}
	if err := result.Validate(now); err != nil {
		return AggregatedQuote{}, fmt.Errorf("aggregate quote is invalid: %w", err)
	}
	resultSpread, err := result.SpreadBasisPoints()
	if err != nil {
		return AggregatedQuote{}, err
	}
	if resultSpread > policy.MaximumSpreadBPS {
		return AggregatedQuote{}, errors.New("aggregate spread exceeds policy after median calculation")
	}
	if earliestExpiry.Before(latestObservation) {
		return AggregatedQuote{}, errors.New("aggregate validity interval is reversed")
	}
	return AggregatedQuote{
		Quote:        result,
		Contributors: contributors,
		Rejected:     rejected,
		Dispersion:   dispersion,
	}, nil
}
