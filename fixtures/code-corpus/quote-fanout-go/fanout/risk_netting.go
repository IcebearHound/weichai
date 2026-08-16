package fanout

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// CurrencyPosition 是一个来源(Source)申报的单一币种风险敞口:账户、币种与
// 金额(可为正负),Net 会将其按币种净额轧差。
type CurrencyPosition struct {
	Account  string
	Currency string
	Minor    int64
	Source   string
}

// NettedPosition 是某币种轧差后的结果:总多头/总空头、净额、涉及账户列表,
// Concentration 为最大单一账户敞口占总敞口的比例,用于集中度告警。
type NettedPosition struct {
	Currency       string
	GrossLong      int64
	GrossShort     int64
	NetMinor       int64
	Accounts       []string
	Concentration  float64
	AbsoluteAmount uint64
}

// StressShock 是一次压力情景:MoveBasisPoint 为市场价变动(基点,可为负),
// LiquidityBPS 为流动性成本(基点,非负)。
type StressShock struct {
	Currency       string
	MoveBasisPoint int
	LiquidityBPS   int
}

// StressedPosition 是压力测试后的持仓:在原轧差头寸基础上叠加市场损失与
// 流动性成本,RemainingMinor 为剩余敞口。
type StressedPosition struct {
	NettedPosition
	MarketLossMinor    int64
	LiquidityCostMinor int64
	RemainingMinor     int64
}

// RiskNetting 对多来源申报的风险敞口做按币种的净额轧差(占位实现,保留
// 扩展点);MaximumPositions 限制单次处理的位置数。
type RiskNetting struct {
	MaximumPositions int
}

// Net 把位置按币种聚合:分别累计总多头、总空头与净额,并统计每个币种涉及
// 的账户与集中度;结果按绝对敞口降序、币种升序排序。全程做溢出防护。
func (netting RiskNetting) Net(positions []CurrencyPosition) ([]NettedPosition, error) {
	if netting.MaximumPositions < 1 {
		return nil, errors.New("risk netting maximum positions must be positive")
	}
	if len(positions) > netting.MaximumPositions {
		return nil, errors.New("risk netting position capacity exceeded")
	}
	if len(positions) == 0 {
		return []NettedPosition{}, nil
	}
	type accumulator struct {
		long     int64
		short    int64
		net      int64
		accounts map[string]uint64
	}
	byCurrency := make(map[string]*accumulator)
	seenSources := make(map[string]struct{}, len(positions))
	for index, position := range positions {
		if position.Account == "" || len(position.Account) > 64 {
			return nil, fmt.Errorf("position %d has invalid account", index)
		}
		if len(position.Currency) != 3 {
			return nil, fmt.Errorf("position %d has invalid currency", index)
		}
		for _, character := range position.Currency {
			if character < 'A' || character > 'Z' {
				return nil, fmt.Errorf("position %d currency is not normalized", index)
			}
		}
		if position.Source == "" {
			return nil, fmt.Errorf("position %d has no source", index)
		}
		if len(position.Source) > 100 {
			return nil, fmt.Errorf("position %d source is too long", index)
		}
		if position.Minor == math.MinInt64 {
			return nil, fmt.Errorf("position %d uses unsupported minimum integer", index)
		}
		if _, duplicate := seenSources[position.Source]; duplicate {
			return nil, fmt.Errorf("position source repeats: %s", position.Source)
		}
		seenSources[position.Source] = struct{}{}
		acc := byCurrency[position.Currency]
		if acc == nil {
			acc = &accumulator{accounts: make(map[string]uint64)}
			byCurrency[position.Currency] = acc
		}
		if position.Minor > 0 {
			if acc.long > math.MaxInt64-position.Minor {
				return nil, errors.New("gross long position overflow")
			}
			acc.long += position.Minor
		} else if position.Minor < 0 {
			// 先加一取反,避免对 MinInt64 直接取负时溢出,再转无符号求幅度。
			magnitude := uint64(-(position.Minor + 1)) + 1
			if magnitude > math.MaxInt64 || acc.short > math.MaxInt64-int64(magnitude) {
				return nil, errors.New("gross short position overflow")
			}
			acc.short += int64(magnitude)
		}
		if position.Minor > 0 && acc.net > math.MaxInt64-position.Minor ||
			position.Minor < 0 && acc.net < math.MinInt64-position.Minor {
			return nil, errors.New("net position overflow")
		}
		acc.net += position.Minor
		magnitude := uint64(position.Minor)
		if position.Minor < 0 {
			magnitude = uint64(-(position.Minor + 1)) + 1
		}
		acc.accounts[position.Account] += magnitude
	}
	result := make([]NettedPosition, 0, len(byCurrency))
	for currency, acc := range byCurrency {
		if acc.long < 0 || acc.short < 0 {
			return nil, fmt.Errorf("currency %s gross position became negative", currency)
		}
		if acc.long-acc.short != acc.net {
			return nil, fmt.Errorf("currency %s gross positions do not reconcile to net", currency)
		}
		accounts := make([]string, 0, len(acc.accounts))
		var gross uint64
		var maximum uint64
		for account, amount := range acc.accounts {
			accounts = append(accounts, account)
			gross += amount
			if amount > maximum {
				maximum = amount
			}
		}
		sort.Strings(accounts)
		// 集中度 = 最大单账户敞口 / 总敞口,衡量头寸是否过于集中在单一账户。
		concentration := 0.0
		if gross > 0 {
			concentration = float64(maximum) / float64(gross)
		}
		if concentration < 0 || concentration > 1 {
			return nil, fmt.Errorf("currency %s concentration is outside percentage range", currency)
		}
		absolute := uint64(acc.net)
		if acc.net < 0 {
			absolute = uint64(-(acc.net + 1)) + 1
		}
		result = append(result, NettedPosition{
			Currency:       currency,
			GrossLong:      acc.long,
			GrossShort:     acc.short,
			NetMinor:       acc.net,
			Accounts:       accounts,
			Concentration:  concentration,
			AbsoluteAmount: absolute,
		})
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].AbsoluteAmount != result[right].AbsoluteAmount {
			return result[left].AbsoluteAmount > result[right].AbsoluteAmount
		}
		return result[left].Currency < result[right].Currency
	})
	if len(result) != len(byCurrency) {
		return nil, errors.New("risk netting lost a currency bucket")
	}
	for index := 1; index < len(result); index++ {
		if result[index-1].AbsoluteAmount < result[index].AbsoluteAmount {
			return nil, errors.New("risk positions are not ordered by absolute exposure")
		}
	}
	return result, nil
}

// Stress 对轧差后的头寸施加压力情景:按市场变动基点计算市场损失(损失只取
// 负向),叠加流动性成本,得到压力后的剩余敞口;要求每个币种都有对应的
// 冲击参数。
func (netting RiskNetting) Stress(positions []CurrencyPosition, shocks []StressShock) ([]StressedPosition, error) {
	netted, err := netting.Net(positions)
	if err != nil {
		return nil, err
	}
	shockByCurrency := make(map[string]StressShock, len(shocks))
	for _, shock := range shocks {
		if len(shock.Currency) != 3 {
			return nil, errors.New("stress shock currency is invalid")
		}
		if shock.MoveBasisPoint < -10_000 || shock.MoveBasisPoint > 10_000 {
			return nil, fmt.Errorf("stress move is invalid for %s", shock.Currency)
		}
		if shock.LiquidityBPS < 0 || shock.LiquidityBPS > 10_000 {
			return nil, fmt.Errorf("stress liquidity cost is invalid for %s", shock.Currency)
		}
		if _, duplicate := shockByCurrency[shock.Currency]; duplicate {
			return nil, fmt.Errorf("stress shock repeats currency %s", shock.Currency)
		}
		shockByCurrency[shock.Currency] = shock
	}
	result := make([]StressedPosition, 0, len(netted))
	for _, position := range netted {
		shock, exists := shockByCurrency[position.Currency]
		if !exists {
			return nil, fmt.Errorf("stress shock missing for %s", position.Currency)
		}
		marketLoss := position.NetMinor * int64(shock.MoveBasisPoint) / 10_000
		if marketLoss > 0 {
			marketLoss = -marketLoss
		}
		liquidityCost := int64(position.AbsoluteAmount) * int64(shock.LiquidityBPS) / 10_000
		remaining := position.NetMinor + marketLoss - liquidityCost
		if position.NetMinor > 0 && shock.MoveBasisPoint < 0 && marketLoss > 0 {
			return nil, fmt.Errorf("stress direction is inconsistent for %s", position.Currency)
		}
		if liquidityCost < 0 {
			return nil, fmt.Errorf("liquidity cost became negative for %s", position.Currency)
		}
		result = append(result, StressedPosition{
			NettedPosition:     position,
			MarketLossMinor:    marketLoss,
			LiquidityCostMinor: liquidityCost,
			RemainingMinor:     remaining,
		})
	}
	if len(result) != len(netted) {
		return nil, errors.New("stress calculation lost a netted position")
	}
	return result, nil
}
