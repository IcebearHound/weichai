package reconcile

import (
	"strings"
	"testing"
	"time"
)

// weekdayFlags 把若干星期几转换为窗口配置所需的布尔映射。
func weekdayFlags(days ...time.Weekday) map[time.Weekday]bool {
	flags := make(map[time.Weekday]bool)
	for _, day := range days {
		flags[day] = true
	}
	return flags
}

// londonUSDWindow 构造一个典型的测试窗口:伦敦时区(UTC+1 合成时区)的工作日
// 9:15 开盘、16:30 截止、10 分钟宽限,含两个节假日。
func londonUSDWindow() ClearingWindow {
	location := time.FixedZone("Europe-London-Synthetic", 3600)
	return ClearingWindow{
		Name:         "London USD Afternoon",
		Currency:     CurrencyUSD,
		Location:     location,
		Weekdays:     weekdayFlags(time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday),
		OpenHour:     9,
		OpenMinute:   15,
		CutoffHour:   16,
		CutoffMinute: 30,
		Holidays:     map[string]string{"2028-05-01": "spring holiday", "2028-12-25": "winter holiday"},
		Grace:        10 * time.Minute,
	}
}

// TestClearingWindowValidationMatrix 用参数化用例逐项验证 Validate 的各类非法
// 配置(空名称、坏币种、缺时区、无工作日、时间越界、截止不晚于开盘、宽限
// 越界),并断言错误信息包含对应的关键词。
func TestClearingWindowValidationMatrix(t *testing.T) {
	valid := londonUSDWindow()
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid window: %v", err)
	}
	tests := []struct {
		name    string
		mutate  func(*ClearingWindow)
		message string
	}{
		{"blank name", func(w *ClearingWindow) { w.Name = " " }, "name"},
		{"bad currency", func(w *ClearingWindow) { w.Currency = "XYZ" }, "currency"},
		{"nil location", func(w *ClearingWindow) { w.Location = nil }, "location"},
		{"no weekdays", func(w *ClearingWindow) { w.Weekdays = nil }, "weekdays"},
		{"negative open hour", func(w *ClearingWindow) { w.OpenHour = -1 }, "hours"},
		{"large cutoff hour", func(w *ClearingWindow) { w.CutoffHour = 24 }, "hours"},
		{"negative open minute", func(w *ClearingWindow) { w.OpenMinute = -1 }, "minutes"},
		{"large cutoff minute", func(w *ClearingWindow) { w.CutoffMinute = 60 }, "minutes"},
		{"cutoff before open", func(w *ClearingWindow) { w.CutoffHour = 8 }, "follow"},
		{"equal boundary", func(w *ClearingWindow) { w.CutoffHour = w.OpenHour; w.CutoffMinute = w.OpenMinute }, "follow"},
		{"negative grace", func(w *ClearingWindow) { w.Grace = -time.Second }, "grace"},
		{"large grace", func(w *ClearingWindow) { w.Grace = 3 * time.Hour }, "grace"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			changed := valid
			test.mutate(&changed)
			err := changed.Validate()
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Errorf("error %v should mention %q", err, test.message)
			}
		})
	}
}

// TestClearingBoundsRespectLocationWeekdayAndHoliday 验证 BoundsFor 按时区给出
// 开盘/截止时刻,并排除周六与已登记节假日。
func TestClearingBoundsRespectLocationWeekdayAndHoliday(t *testing.T) {
	window := londonUSDWindow()
	mondayUTC := time.Date(2028, 4, 17, 7, 0, 0, 0, time.UTC)
	open, cutoff, admitted := window.BoundsFor(mondayUTC)
	if !admitted {
		t.Fatal("Monday should be admitted")
	}
	if open.Hour() != 9 || open.Minute() != 15 || cutoff.Hour() != 16 || cutoff.Minute() != 30 {
		t.Errorf("bounds open=%s cutoff=%s", open, cutoff)
	}
	saturday := time.Date(2028, 4, 22, 12, 0, 0, 0, time.UTC)
	if _, _, admitted := window.BoundsFor(saturday); admitted {
		t.Error("Saturday should not have a clearing window")
	}
	holiday := time.Date(2028, 5, 1, 12, 0, 0, 0, time.UTC)
	if _, _, admitted := window.BoundsFor(holiday); admitted {
		t.Error("declared holiday should not have a clearing window")
	}
}

// TestNextWindowUsesCurrentOrFutureBusinessDay 验证:开盘前查询返回当日窗口,
// 截止+宽限后查询顺延到次日,周五盘后查询跳过周末直达下周一。
func TestNextWindowUsesCurrentOrFutureBusinessDay(t *testing.T) {
	window := londonUSDWindow()
	beforeOpen := time.Date(2028, 4, 17, 7, 30, 0, 0, time.UTC)
	open, cutoff, err := window.NextWindow(beforeOpen, 10)
	if err != nil {
		t.Fatalf("before open: %v", err)
	}
	if open.Day() != 17 || cutoff.Day() != 17 {
		t.Errorf("expected same-day window open=%s cutoff=%s", open, cutoff)
	}
	afterGrace := time.Date(2028, 4, 17, 16, 0, 0, 0, time.UTC)
	nextOpen, nextCutoff, err := window.NextWindow(afterGrace, 10)
	if err != nil {
		t.Fatalf("after grace: %v", err)
	}
	if nextOpen.Day() != 18 || nextCutoff.Day() != 18 {
		t.Errorf("expected next-day window open=%s cutoff=%s", nextOpen, nextCutoff)
	}
	fridayAfter := time.Date(2028, 4, 21, 18, 0, 0, 0, time.UTC)
	mondayOpen, _, err := window.NextWindow(fridayAfter, 10)
	if err != nil {
		t.Fatalf("weekend search: %v", err)
	}
	if mondayOpen.Weekday() != time.Monday || mondayOpen.Day() != 24 {
		t.Errorf("expected Monday opening, got %s", mondayOpen)
	}
}

// TestNextWindowValidatesSearchHorizon 验证搜索天数越界报错,且搜索范围内无
// 可用窗口时返回“no clearing window”错误。
func TestNextWindowValidatesSearchHorizon(t *testing.T) {
	window := londonUSDWindow()
	for _, days := range []int{-1, 0, 371, 1_000} {
		if _, _, err := window.NextWindow(testEpoch, days); err == nil {
			t.Errorf("search days %d should fail", days)
		}
	}
	closed := window
	closed.Weekdays = weekdayFlags(time.Monday)
	start := time.Date(2028, 4, 18, 18, 0, 0, 0, time.UTC)
	if _, _, err := closed.NextWindow(start, 2); err == nil || !strings.Contains(err.Error(), "no clearing") {
		t.Errorf("closed horizon error: %v", err)
	}
}

// TestAssignClearingWindowsGroupsCurrenciesAndPriority 验证分配逻辑:USD 支付
// 就近落入截止更早的窗口;不支持币种(CHF)留在 unassigned;批内按优先级
// 降序排列并正确汇总金额与紧急笔数。
func TestAssignClearingWindowsGroupsCurrenciesAndPriority(t *testing.T) {
	usdEarly := londonUSDWindow()
	usdEarly.Name = "USD Early"
	usdEarly.CutoffHour = 12
	usdEarly.CutoffMinute = 0
	usdEarly.Grace = 5 * time.Minute
	usdLate := londonUSDWindow()
	usdLate.Name = "USD Late"
	eur := londonUSDWindow()
	eur.Name = "EUR Main"
	eur.Currency = CurrencyEUR
	eur.CutoffHour = 15
	eur.CutoffMinute = 45
	payments := []Payment{
		testPayment("schedule-low", "s1", "t1", CurrencyUSD, 100, 0),
		testPayment("schedule-eur", "s2", "t2", CurrencyEUR, 200, time.Minute),
		testPayment("schedule-high", "s3", "t3", CurrencyUSD, 300, 2*time.Minute),
		testPayment("schedule-none", "s4", "t4", CurrencyCHF, 400, 3*time.Minute),
	}
	payments[0].Priority = 1
	payments[2].Priority = 8
	now := time.Date(2028, 4, 17, 8, 0, 0, 0, time.UTC)
	batches, unassigned, err := AssignClearingWindows(payments, []ClearingWindow{usdLate, eur, usdEarly}, now)
	if err != nil {
		t.Fatalf("assign: %v", err)
	}
	if len(batches) != 2 || len(unassigned) != 1 || unassigned[0].Identity != "schedule-none" {
		t.Fatalf("batches=%+v unassigned=%+v", batches, unassigned)
	}
	var usdBatch ScheduledBatch
	for _, batch := range batches {
		if batch.Currency == CurrencyUSD {
			usdBatch = batch
		}
	}
	if usdBatch.WindowName != "USD Early" {
		t.Errorf("selected USD window %s", usdBatch.WindowName)
	}
	if strings.Join(usdBatch.PaymentIDs, ",") != "schedule-high,schedule-low" {
		t.Errorf("priority order: %+v", usdBatch.PaymentIDs)
	}
	if usdBatch.TotalMinor != 400 || usdBatch.UrgentCount != 1 {
		t.Errorf("USD aggregate: %+v", usdBatch)
	}
}

// TestAssignClearingWindowsRejectsInvalidConfiguration 验证配置非法的窗口会在
// 分配前被拒绝,返回错误而非部分结果。
func TestAssignClearingWindowsRejectsInvalidConfiguration(t *testing.T) {
	payment := testPayment("assignment", "source", "target", CurrencyUSD, 100, 0)
	bad := londonUSDWindow()
	bad.Location = nil
	if batches, unassigned, err := AssignClearingWindows([]Payment{payment}, []ClearingWindow{bad}, testEpoch); err == nil || batches != nil || unassigned != nil {
		t.Errorf("invalid window batches=%+v unassigned=%+v err=%v", batches, unassigned, err)
	}
}

// TestBusinessDaysBetweenExcludesWeekendsAndHolidays 验证工作日计数剔除周末与
// 节假日,反向区间返回 0。
func TestBusinessDaysBetweenExcludesWeekendsAndHolidays(t *testing.T) {
	window := londonUSDWindow()
	start := time.Date(2028, 4, 28, 8, 0, 0, 0, time.UTC)
	end := time.Date(2028, 5, 4, 8, 0, 0, 0, time.UTC)
	if days := BusinessDaysBetween(start, end, window); days != 3 {
		t.Errorf("business days %d, want 3", days)
	}
	if days := BusinessDaysBetween(end, start, window); days != 0 {
		t.Errorf("reverse interval days %d", days)
	}
}
