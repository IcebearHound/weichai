package reconcile

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

type NetPosition struct {
	Account       string
	Currency      Currency
	IncomingMinor int64
	OutgoingMinor int64
	NetMinor      int64
	PaymentCount  int
	Earliest      time.Time
	Latest        time.Time
}

type LiquidityInstruction struct {
	Account        string
	Currency       Currency
	RequiredMinor  int64
	AvailableMinor int64
	ShortfallMinor int64
	Deadline       time.Time
	Source         string
}

type NettingCycle struct {
	CycleID       string
	Currency      Currency
	OpenedAt      time.Time
	ClosesAt      time.Time
	Payments      []Payment
	Positions     []NetPosition
	GrossMinor    int64
	NetDebitMinor int64
	Balanced      bool
}

func CalculateNetPositions(payments []Payment) ([]NetPosition, error) {
	type accumulator struct {
		incoming int64
		outgoing int64
		count    int
		earliest time.Time
		latest   time.Time
	}
	values := make(map[string]*accumulator)
	currencies := make(map[string]Currency)
	for position, payment := range payments {
		if err := payment.Validate(); err != nil {
			return nil, fmt.Errorf("payment %d: %w", position, err)
		}
		sourceKey := ledgerBalanceKey(payment.Account, payment.Amount.Currency)
		targetKey := ledgerBalanceKey(payment.Beneficiary, payment.Amount.Currency)
		currencies[sourceKey] = payment.Amount.Currency
		currencies[targetKey] = payment.Amount.Currency
		source := values[sourceKey]
		if source == nil {
			source = &accumulator{}
			values[sourceKey] = source
		}
		target := values[targetKey]
		if target == nil {
			target = &accumulator{}
			values[targetKey] = target
		}
		source.outgoing += payment.Amount.Minor
		source.count++
		target.incoming += payment.Amount.Minor
		target.count++
		if source.earliest.IsZero() || payment.RequestedAt.Before(source.earliest) {
			source.earliest = payment.RequestedAt
		}
		if source.latest.IsZero() || payment.RequestedAt.After(source.latest) {
			source.latest = payment.RequestedAt
		}
		if target.earliest.IsZero() || payment.RequestedAt.Before(target.earliest) {
			target.earliest = payment.RequestedAt
		}
		if target.latest.IsZero() || payment.RequestedAt.After(target.latest) {
			target.latest = payment.RequestedAt
		}
	}
	positions := make([]NetPosition, 0, len(values))
	for key, value := range values {
		account := strings.SplitN(key, "\x00", 2)[0]
		positions = append(positions, NetPosition{
			Account:       account,
			Currency:      currencies[key],
			IncomingMinor: value.incoming,
			OutgoingMinor: value.outgoing,
			NetMinor:      value.incoming - value.outgoing,
			PaymentCount:  value.count,
			Earliest:      value.earliest,
			Latest:        value.latest,
		})
	}
	sort.Slice(positions, func(left, right int) bool {
		if positions[left].Currency != positions[right].Currency {
			return positions[left].Currency < positions[right].Currency
		}
		return positions[left].Account < positions[right].Account
	})
	return positions, nil
}

func BuildNettingCycles(payments []Payment, openedAt time.Time, window time.Duration) ([]NettingCycle, error) {
	if openedAt.IsZero() {
		return nil, errors.New("cycle opening time is required")
	}
	if window <= 0 || window > 24*time.Hour {
		return nil, errors.New("netting window must be positive and no longer than one day")
	}
	groups := make(map[Currency][]Payment)
	for position, payment := range payments {
		if err := payment.Validate(); err != nil {
			return nil, fmt.Errorf("payment %d: %w", position, err)
		}
		groups[payment.Amount.Currency] = append(groups[payment.Amount.Currency], payment)
	}
	currencies := make([]Currency, 0, len(groups))
	for currency := range groups {
		currencies = append(currencies, currency)
	}
	sort.Slice(currencies, func(left, right int) bool { return currencies[left] < currencies[right] })
	cycles := make([]NettingCycle, 0, len(currencies))
	for _, currency := range currencies {
		currencyPayments := append([]Payment(nil), groups[currency]...)
		sort.SliceStable(currencyPayments, func(left, right int) bool {
			if currencyPayments[left].Priority != currencyPayments[right].Priority {
				return currencyPayments[left].Priority > currencyPayments[right].Priority
			}
			if !currencyPayments[left].RequestedAt.Equal(currencyPayments[right].RequestedAt) {
				return currencyPayments[left].RequestedAt.Before(currencyPayments[right].RequestedAt)
			}
			return currencyPayments[left].Identity < currencyPayments[right].Identity
		})
		positions, err := CalculateNetPositions(currencyPayments)
		if err != nil {
			return nil, err
		}
		var gross int64
		var debits int64
		var credits int64
		for _, payment := range currencyPayments {
			gross += payment.Amount.Minor
		}
		for _, position := range positions {
			if position.NetMinor < 0 {
				debits += -position.NetMinor
			} else {
				credits += position.NetMinor
			}
		}
		cycles = append(cycles, NettingCycle{
			CycleID:       fmt.Sprintf("cycle-%s-%d", currency, openedAt.Unix()),
			Currency:      currency,
			OpenedAt:      openedAt.UTC(),
			ClosesAt:      openedAt.Add(window).UTC(),
			Payments:      currencyPayments,
			Positions:     positions,
			GrossMinor:    gross,
			NetDebitMinor: debits,
			Balanced:      debits == credits,
		})
	}
	return cycles, nil
}

func PlanLiquidity(positions []NetPosition, balances map[string]int64, deadline time.Time) []LiquidityInstruction {
	result := make([]LiquidityInstruction, 0)
	for _, position := range positions {
		if position.NetMinor >= 0 {
			continue
		}
		required := -position.NetMinor
		available := balances[ledgerBalanceKey(position.Account, position.Currency)]
		if available < 0 {
			available = 0
		}
		shortfall := required - available
		if shortfall < 0 {
			shortfall = 0
		}
		source := "existing-balance"
		if shortfall > 0 {
			source = "intraday-credit"
		}
		result = append(result, LiquidityInstruction{
			Account:        position.Account,
			Currency:       position.Currency,
			RequiredMinor:  required,
			AvailableMinor: available,
			ShortfallMinor: shortfall,
			Deadline:       deadline.UTC(),
			Source:         source,
		})
	}
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].ShortfallMinor != result[right].ShortfallMinor {
			return result[left].ShortfallMinor > result[right].ShortfallMinor
		}
		if result[left].Currency != result[right].Currency {
			return result[left].Currency < result[right].Currency
		}
		return result[left].Account < result[right].Account
	})
	return result
}

func SelectSettlingPayments(cycle NettingCycle, limits map[string]int64) ([]Payment, []Payment) {
	accepted := make([]Payment, 0, len(cycle.Payments))
	deferred := make([]Payment, 0)
	used := make(map[string]int64)
	for _, payment := range cycle.Payments {
		key := ledgerBalanceKey(payment.Account, payment.Amount.Currency)
		limit, constrained := limits[key]
		if constrained && used[key]+payment.Amount.Minor > limit {
			deferred = append(deferred, payment)
			continue
		}
		accepted = append(accepted, payment)
		used[key] += payment.Amount.Minor
	}
	return accepted, deferred
}
