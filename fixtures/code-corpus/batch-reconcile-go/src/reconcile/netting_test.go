package reconcile

import (
	"strings"
	"testing"
	"time"
)

// TestCalculateNetPositionsBalancesCurrencyStreams 验证净头寸计算:账户按币种
// 分别记账、净额正确、同一币种全部账户净额之和为零,且时间跨度记录准确。
func TestCalculateNetPositionsBalancesCurrencyStreams(t *testing.T) {
	payments := []Payment{
		testPayment("net-1", "alpha", "beta", CurrencyUSD, 1_000, time.Minute),
		testPayment("net-2", "beta", "gamma", CurrencyUSD, 400, 2*time.Minute),
		testPayment("net-3", "gamma", "alpha", CurrencyUSD, 250, 3*time.Minute),
		testPayment("net-4", "alpha", "delta", CurrencyEUR, 700, 4*time.Minute),
		testPayment("net-5", "delta", "alpha", CurrencyEUR, 300, 5*time.Minute),
	}
	positions, err := CalculateNetPositions(payments)
	if err != nil {
		t.Fatalf("calculate positions: %v", err)
	}
	if len(positions) != 5 {
		t.Fatalf("position count %d, want 5: %+v", len(positions), positions)
	}
	lookup := make(map[string]NetPosition)
	for _, position := range positions {
		lookup[ledgerBalanceKey(position.Account, position.Currency)] = position
	}
	wants := map[string]int64{
		ledgerBalanceKey("alpha", CurrencyUSD): -750,
		ledgerBalanceKey("beta", CurrencyUSD):  600,
		ledgerBalanceKey("gamma", CurrencyUSD): 150,
		ledgerBalanceKey("alpha", CurrencyEUR): -400,
		ledgerBalanceKey("delta", CurrencyEUR): 400,
	}
	for key, want := range wants {
		if got := lookup[key].NetMinor; got != want {
			t.Errorf("%s net %d, want %d", key, got, want)
		}
	}
	for _, currency := range []Currency{CurrencyUSD, CurrencyEUR} {
		var sum int64
		for _, position := range positions {
			if position.Currency == currency {
				sum += position.NetMinor
			}
		}
		if sum != 0 {
			t.Errorf("currency %s positions sum to %d", currency, sum)
		}
	}
	alphaUSD := lookup[ledgerBalanceKey("alpha", CurrencyUSD)]
	if !alphaUSD.Earliest.Equal(testEpoch.Add(time.Minute)) || !alphaUSD.Latest.Equal(testEpoch.Add(3*time.Minute)) {
		t.Errorf("alpha observation bounds: %+v", alphaUSD)
	}
}

// TestCalculateNetPositionsRejectsInvalidPayment 验证非法支付(自转)使整个
// 计算失败,且错误信息能定位到具体支付下标。
func TestCalculateNetPositionsRejectsInvalidPayment(t *testing.T) {
	valid := testPayment("net-valid", "source", "target", CurrencyGBP, 100, 0)
	invalid := testPayment("net-invalid", "same", "same", CurrencyGBP, 200, time.Second)
	positions, err := CalculateNetPositions([]Payment{valid, invalid})
	if positions != nil {
		t.Errorf("invalid calculation returned positions: %+v", positions)
	}
	if err == nil || !strings.Contains(err.Error(), "payment 1") {
		t.Errorf("invalid payment error: %v", err)
	}
}

// TestBuildNettingCyclesGroupsAndPrioritizes 验证周期按币种分组并按币种排序、
// 批内按优先级/时间/身份排序、总额与净付缺口汇总正确,且收付平衡。
func TestBuildNettingCyclesGroupsAndPrioritizes(t *testing.T) {
	payments := []Payment{
		testPayment("usd-late", "u1", "u2", CurrencyUSD, 500, 5*time.Minute),
		testPayment("eur-mid", "e1", "e2", CurrencyEUR, 300, 3*time.Minute),
		testPayment("usd-urgent", "u3", "u4", CurrencyUSD, 700, 4*time.Minute),
		testPayment("eur-early", "e3", "e4", CurrencyEUR, 200, time.Minute),
		testPayment("usd-early", "u5", "u6", CurrencyUSD, 600, 2*time.Minute),
	}
	payments[2].Priority = 9
	payments[0].Priority = 2
	payments[4].Priority = 2
	cycles, err := BuildNettingCycles(payments, testEpoch, 45*time.Minute)
	if err != nil {
		t.Fatalf("build cycles: %v", err)
	}
	if len(cycles) != 2 || cycles[0].Currency != CurrencyEUR || cycles[1].Currency != CurrencyUSD {
		t.Fatalf("cycle order: %+v", cycles)
	}
	usd := cycles[1]
	if usd.GrossMinor != 1_800 || !usd.Balanced || usd.NetDebitMinor != 1_800 {
		t.Errorf("USD cycle totals: %+v", usd)
	}
	if usd.Payments[0].Identity != "usd-urgent" || usd.Payments[1].Identity != "usd-early" || usd.Payments[2].Identity != "usd-late" {
		t.Errorf("USD priority order: %+v", usd.Payments)
	}
	if !usd.ClosesAt.Equal(testEpoch.Add(45 * time.Minute)) {
		t.Errorf("cycle cutoff %s", usd.ClosesAt)
	}
}

// TestBuildNettingCyclesValidatesWindowAndOpening 验证缺失开启时间、窗口时长为
// 零/负/超过一天时都被拒绝。
func TestBuildNettingCyclesValidatesWindowAndOpening(t *testing.T) {
	payment := testPayment("cycle-valid", "source", "target", CurrencyUSD, 100, 0)
	tests := []struct {
		name   string
		open   time.Time
		window time.Duration
	}{
		{"missing opening", time.Time{}, time.Hour},
		{"zero window", testEpoch, 0},
		{"negative window", testEpoch, -time.Minute},
		{"too long", testEpoch, 25 * time.Hour},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := BuildNettingCycles([]Payment{payment}, test.open, test.window); err == nil {
				t.Error("expected cycle validation failure")
			}
		})
	}
}

// TestLiquidityPlanSortsShortfallsBeforeCoveredAccounts 验证流动性计划:缺口大
// 的账户排前、余额充足的账户缺口为零并标记为现有余额来源、截止时间透传。
func TestLiquidityPlanSortsShortfallsBeforeCoveredAccounts(t *testing.T) {
	positions := []NetPosition{
		{Account: "covered", Currency: CurrencyUSD, NetMinor: -1_000},
		{Account: "large-gap", Currency: CurrencyEUR, NetMinor: -5_000},
		{Account: "small-gap", Currency: CurrencyUSD, NetMinor: -2_000},
		{Account: "receiver", Currency: CurrencyUSD, NetMinor: 8_000},
		{Account: "exact", Currency: CurrencyGBP, NetMinor: -900},
	}
	balances := map[string]int64{
		ledgerBalanceKey("covered", CurrencyUSD):   1_500,
		ledgerBalanceKey("large-gap", CurrencyEUR): 500,
		ledgerBalanceKey("small-gap", CurrencyUSD): 1_700,
		ledgerBalanceKey("exact", CurrencyGBP):     900,
	}
	deadline := testEpoch.Add(time.Hour)
	plan := PlanLiquidity(positions, balances, deadline)
	if len(plan) != 4 {
		t.Fatalf("instruction count %d, want 4", len(plan))
	}
	if plan[0].Account != "large-gap" || plan[0].ShortfallMinor != 4_500 || plan[0].Source != "intraday-credit" {
		t.Errorf("largest shortfall: %+v", plan[0])
	}
	if plan[1].Account != "small-gap" || plan[1].ShortfallMinor != 300 {
		t.Errorf("small shortfall: %+v", plan[1])
	}
	if plan[2].ShortfallMinor != 0 || plan[3].ShortfallMinor != 0 {
		t.Errorf("covered accounts have shortfalls: %+v", plan)
	}
	for _, instruction := range plan {
		if !instruction.Deadline.Equal(deadline) {
			t.Errorf("deadline not propagated: %+v", instruction)
		}
	}
}

// TestSelectSettlingPaymentsRespectsPerAccountLimits 验证限额约束:账户累计金额
// 超过限额后剩余支付被顺延,限额按“账户+币种”分别生效。
func TestSelectSettlingPaymentsRespectsPerAccountLimits(t *testing.T) {
	cycle := NettingCycle{Currency: CurrencyUSD, Payments: []Payment{
		testPayment("select-a", "account-a", "target-1", CurrencyUSD, 400, 0),
		testPayment("select-b", "account-b", "target-2", CurrencyUSD, 800, time.Second),
		testPayment("select-c", "account-a", "target-3", CurrencyUSD, 700, 2*time.Second),
		testPayment("select-d", "account-a", "target-4", CurrencyUSD, 100, 3*time.Second),
		testPayment("select-e", "account-b", "target-5", CurrencyUSD, 300, 4*time.Second),
	}}
	limits := map[string]int64{
		ledgerBalanceKey("account-a", CurrencyUSD): 600,
		ledgerBalanceKey("account-b", CurrencyUSD): 900,
	}
	accepted, deferred := SelectSettlingPayments(cycle, limits)
	if len(accepted) != 3 || accepted[0].Identity != "select-a" || accepted[1].Identity != "select-b" || accepted[2].Identity != "select-d" {
		t.Errorf("accepted: %+v", accepted)
	}
	if len(deferred) != 2 || deferred[0].Identity != "select-c" || deferred[1].Identity != "select-e" {
		t.Errorf("deferred: %+v", deferred)
	}
}

// TestSelectSettlingPaymentsTreatsMissingLimitAsUnconstrained 验证未配置限额的
// 账户不受约束,全部支付都被接受。
func TestSelectSettlingPaymentsTreatsMissingLimitAsUnconstrained(t *testing.T) {
	cycle := NettingCycle{Payments: []Payment{
		testPayment("free-a", "unconstrained", "target-a", CurrencyCAD, 10_000, 0),
		testPayment("free-b", "unconstrained", "target-b", CurrencyCAD, 20_000, time.Second),
	}}
	accepted, deferred := SelectSettlingPayments(cycle, nil)
	if len(accepted) != 2 || len(deferred) != 0 {
		t.Errorf("accepted=%+v deferred=%+v", accepted, deferred)
	}
}

// TestNetPositionsRecordIncomingAndOutgoingCounts 验证收付金额与支付笔数的统计:
// 收付相抵的账户净额为零,同时出现在收付两方的账户计数正确。
func TestNetPositionsRecordIncomingAndOutgoingCounts(t *testing.T) {
	payments := []Payment{
		testPayment("count-1", "hub", "leaf-a", CurrencyCHF, 111, 0),
		testPayment("count-2", "hub", "leaf-b", CurrencyCHF, 222, time.Second),
		testPayment("count-3", "leaf-a", "hub", CurrencyCHF, 333, 2*time.Second),
	}
	positions, err := CalculateNetPositions(payments)
	if err != nil {
		t.Fatalf("calculate: %v", err)
	}
	byAccount := make(map[string]NetPosition)
	for _, position := range positions {
		byAccount[position.Account] = position
	}
	hub := byAccount["hub"]
	if hub.IncomingMinor != 333 || hub.OutgoingMinor != 333 || hub.NetMinor != 0 || hub.PaymentCount != 3 {
		t.Errorf("hub position: %+v", hub)
	}
	leafA := byAccount["leaf-a"]
	if leafA.IncomingMinor != 111 || leafA.OutgoingMinor != 333 || leafA.PaymentCount != 2 {
		t.Errorf("leaf-a position: %+v", leafA)
	}
}
