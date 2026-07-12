package fanout

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"time"
)

type AggregationPolicy struct {
	MinimumProviders int
	MaximumAge       time.Duration
	MaximumSpreadBPS float64
	TrimEachSide     int
	PreferFresh      bool
}

type AggregatedQuote struct {
	Quote
	Contributors []string
	Rejected     map[string]string
	Dispersion   float64
}

type QuoteAggregator struct {
	Policy AggregationPolicy
}

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
