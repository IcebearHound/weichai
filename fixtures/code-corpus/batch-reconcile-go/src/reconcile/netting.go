package reconcile

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// NetPosition 是净额轧差周期内,某一账户在某一币种下的轧差结果:IncomingMinor
// 为该账户收到的全部金额,OutgoingMinor 为支出金额,NetMinor 为两者之差
// (正为净收、负为净付);Earliest/Latest 记录相关支付的时间跨度。
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

// LiquidityInstruction 是针对净付账户的流动性安排:先动用现有余额
// (AvailableMinor),不足部分(ShortfallMinor)申请日内授信,并给出最晚到账
// 时限 Deadline,Source 标记资金来源于“现有余额”还是“日内授信”。
type LiquidityInstruction struct {
	Account        string
	Currency       Currency
	RequiredMinor  int64
	AvailableMinor int64
	ShortfallMinor int64
	Deadline       time.Time
	Source         string
}

// NettingCycle 是一次净额轧差周期:在 OpenedAt 开启、ClosesAt 关闭,纳入该
// 周期内的支付与轧差后的账户头寸。GrossMinor 为周期内支付总额,NetDebitMinor
// 为所有净付账户的合计缺口,Balanced 表示轧差后收付平衡(可净额清算)。
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

// CalculateNetPositions 对一批支付按“账户 + 币种”聚合,计算出每个账户的
// 收付金额、净额、支付笔数及最早/最晚时间。同一账户在多个币种下分别
// 记账,返回结果按币种、账户排序以保证确定性。
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

// BuildNettingCycles 把一批支付按币种分成多个轧差周期(周期时长为 window):
// 每周期内按优先级、请求时间排序后计算净头寸,并汇总总额与净付缺口;
// Balanced 反映该币种周期内收付是否恰好平衡。
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

// PlanLiquidity 为所有净付账户生成流动性计划:按净付额从大到小排序(缺口
// 越大的账户越优先安排资金),现有余额不足的部分记为需授信补足的缺口。
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

// SelectSettlingPayments 在账户限额(limits,按“账户+币种”键)约束下挑选
// 本期可以清算的支付:未超限额的支付接受执行,一旦累计金额超过限额则
// 剩余支付顺延到下一周期。
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
