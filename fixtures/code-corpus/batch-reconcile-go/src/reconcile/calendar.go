package reconcile

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ClearingWindow 定义一个币种在特定时区内的清算窗口:在 Weekdays 指定的
// 工作日里,Open 时间开始受理支付,Cutoff 时间停止受理并触发执行;Holidays
// 按“日期 -> 假日名”排除特殊休市日,Grace 为截止后的宽限期。
type ClearingWindow struct {
	Name         string
	Currency     Currency
	Location     *time.Location
	Weekdays     map[time.Weekday]bool
	OpenHour     int
	OpenMinute   int
	CutoffHour   int
	CutoffMinute int
	Holidays     map[string]string
	Grace        time.Duration
}

// ScheduledBatch 是分配给某一清算窗口的支付批次:在 AdmissionOpens 开始受理、
// Cutoff 截止、ExecutionAt(Cutoff + 宽限期)执行。UrgentCount 统计其中高优先级
// 支付笔数,便于运营评估时效风险。
type ScheduledBatch struct {
	BatchKey       string
	WindowName     string
	Currency       Currency
	AdmissionOpens time.Time
	Cutoff         time.Time
	ExecutionAt    time.Time
	PaymentIDs     []string
	TotalMinor     int64
	UrgentCount    int
}

// Validate 校验窗口配置:名称、币种、时区、工作日集合、开/截时间在同一营业日
// 内先后有序,且宽限期不超过两小时。
func (window ClearingWindow) Validate() error {
	if strings.TrimSpace(window.Name) == "" {
		return errors.New("clearing window name is required")
	}
	if !window.Currency.Valid() {
		return errors.New("clearing window currency is invalid")
	}
	if window.Location == nil {
		return errors.New("clearing window location is required")
	}
	if len(window.Weekdays) == 0 {
		return errors.New("clearing window has no active weekdays")
	}
	if window.OpenHour < 0 || window.OpenHour > 23 || window.CutoffHour < 0 || window.CutoffHour > 23 {
		return errors.New("clearing hours must be between zero and 23")
	}
	if window.OpenMinute < 0 || window.OpenMinute > 59 || window.CutoffMinute < 0 || window.CutoffMinute > 59 {
		return errors.New("clearing minutes must be between zero and 59")
	}
	open := window.OpenHour*60 + window.OpenMinute
	cutoff := window.CutoffHour*60 + window.CutoffMinute
	if cutoff <= open {
		return errors.New("clearing cutoff must follow opening within the same business day")
	}
	if window.Grace < 0 || window.Grace > 2*time.Hour {
		return errors.New("clearing grace must be between zero and two hours")
	}
	return nil
}

// BoundsFor 返回指定日期(按窗口时区解释)的开放与截止时刻。当日为非工作日
// 或节假日时返回 false。
func (window ClearingWindow) BoundsFor(day time.Time) (time.Time, time.Time, bool) {
	if window.Validate() != nil {
		return time.Time{}, time.Time{}, false
	}
	local := day.In(window.Location)
	dateKey := local.Format("2006-01-02")
	if !window.Weekdays[local.Weekday()] {
		return time.Time{}, time.Time{}, false
	}
	if _, holiday := window.Holidays[dateKey]; holiday {
		return time.Time{}, time.Time{}, false
	}
	open := time.Date(local.Year(), local.Month(), local.Day(), window.OpenHour, window.OpenMinute, 0, 0, window.Location)
	cutoff := time.Date(local.Year(), local.Month(), local.Day(), window.CutoffHour, window.CutoffMinute, 0, 0, window.Location)
	return open, cutoff, true
}

// NextWindow 从 after 起在 searchDays 天内向后寻找下一个有效窗口:候选日的
// 截止时刻加宽限期仍晚于 after(即支付已来不及赶上前一个窗口)才接受。
func (window ClearingWindow) NextWindow(after time.Time, searchDays int) (time.Time, time.Time, error) {
	if err := window.Validate(); err != nil {
		return time.Time{}, time.Time{}, err
	}
	if searchDays < 1 || searchDays > 370 {
		return time.Time{}, time.Time{}, errors.New("search horizon must be between one and 370 days")
	}
	local := after.In(window.Location)
	for offset := 0; offset < searchDays; offset++ {
		candidate := local.AddDate(0, 0, offset)
		open, cutoff, admitted := window.BoundsFor(candidate)
		// 截止+宽限仍早于 after 的窗口已不可达,跳过;避免把支付排进已关闭的期次。
		if !admitted || cutoff.Add(window.Grace).Before(after) {
			continue
		}
		return open, cutoff, nil
	}
	return time.Time{}, time.Time{}, errors.New("no clearing window found within search horizon")
}

// AssignClearingWindows 将一批支付分配到各币种对应窗口的最近一期批次中:
// 每笔支付就近落入截止时刻最早(同截止按窗口名排序)的窗口;不合规或找不到
// 窗口的支付原样留在 unassigned 返回。返回的批次按执行时刻排序。
func AssignClearingWindows(payments []Payment, windows []ClearingWindow, now time.Time) ([]ScheduledBatch, []Payment, error) {
	// 先按币种把窗口分组,并为同币种窗口确定稳定顺序,保证分配结果确定。
	byCurrency := make(map[Currency][]ClearingWindow)
	for position, window := range windows {
		if err := window.Validate(); err != nil {
			return nil, nil, fmt.Errorf("window %d: %w", position, err)
		}
		byCurrency[window.Currency] = append(byCurrency[window.Currency], window)
	}
	for currency := range byCurrency {
		sort.Slice(byCurrency[currency], func(left, right int) bool {
			return byCurrency[currency][left].Name < byCurrency[currency][right].Name
		})
	}
	type assignment struct {
		window ClearingWindow
		open   time.Time
		cutoff time.Time
		items  []Payment
	}
	assignments := make(map[string]*assignment)
	unassigned := make([]Payment, 0)
	for _, payment := range payments {
		if payment.Validate() != nil {
			unassigned = append(unassigned, payment)
			continue
		}
		var chosen *assignment
		for _, window := range byCurrency[payment.Amount.Currency] {
			open, cutoff, err := window.NextWindow(now, 45)
			if err != nil {
				continue
			}
			candidate := &assignment{window: window, open: open, cutoff: cutoff}
			if chosen == nil || candidate.cutoff.Before(chosen.cutoff) ||
				(candidate.cutoff.Equal(chosen.cutoff) && candidate.window.Name < chosen.window.Name) {
				chosen = candidate
			}
		}
		if chosen == nil {
			unassigned = append(unassigned, payment)
			continue
		}
		// 以“窗口名 + 截止时刻”作为桶键,把同一期窗口内的支付聚合为一个批次。
		key := chosen.window.Name + "\x00" + chosen.cutoff.UTC().Format(time.RFC3339)
		bucket := assignments[key]
		if bucket == nil {
			bucket = chosen
			assignments[key] = bucket
		}
		bucket.items = append(bucket.items, payment)
	}
	keys := make([]string, 0, len(assignments))
	for key := range assignments {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]ScheduledBatch, 0, len(keys))
	for ordinal, key := range keys {
		bucket := assignments[key]
		// 批内按优先级降序、同优先级按支付身份排序,优先支付靠前执行。
		sort.SliceStable(bucket.items, func(left, right int) bool {
			if bucket.items[left].Priority != bucket.items[right].Priority {
				return bucket.items[left].Priority > bucket.items[right].Priority
			}
			return bucket.items[left].Identity < bucket.items[right].Identity
		})
		scheduled := ScheduledBatch{
			BatchKey:       fmt.Sprintf("schedule-%s-%d-%03d", strings.ToLower(bucket.window.Name), bucket.cutoff.Unix(), ordinal),
			WindowName:     bucket.window.Name,
			Currency:       bucket.window.Currency,
			AdmissionOpens: bucket.open.UTC(),
			Cutoff:         bucket.cutoff.UTC(),
			ExecutionAt:    bucket.cutoff.Add(bucket.window.Grace).UTC(),
		}
		for _, payment := range bucket.items {
			scheduled.PaymentIDs = append(scheduled.PaymentIDs, payment.Identity)
			scheduled.TotalMinor += payment.Amount.Minor
			// 优先级 7 及以上视为紧急支付,单独计数供运营关注。
			if payment.Priority >= 7 {
				scheduled.UrgentCount++
			}
		}
		result = append(result, scheduled)
	}
	sort.SliceStable(result, func(left, right int) bool {
		if !result[left].ExecutionAt.Equal(result[right].ExecutionAt) {
			return result[left].ExecutionAt.Before(result[right].ExecutionAt)
		}
		return result[left].BatchKey < result[right].BatchKey
	})
	return result, unassigned, nil
}

// BusinessDaysBetween 统计 start 与 end 之间(不含起始日、含方向)的营业日数,
// 即剔除周末与节假日后的天数,用于清算时效评估。
func BusinessDaysBetween(start, end time.Time, window ClearingWindow) int {
	if !end.After(start) {
		return 0
	}
	startLocal := start.In(window.Location)
	endLocal := end.In(window.Location)
	days := 0
	for cursor := time.Date(startLocal.Year(), startLocal.Month(), startLocal.Day(), 12, 0, 0, 0, window.Location); cursor.Before(endLocal); cursor = cursor.AddDate(0, 0, 1) {
		if !window.Weekdays[cursor.Weekday()] {
			continue
		}
		if _, holiday := window.Holidays[cursor.Format("2006-01-02")]; holiday {
			continue
		}
		days++
	}
	return days
}
