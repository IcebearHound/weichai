package reconcile

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

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
		if !admitted || cutoff.Add(window.Grace).Before(after) {
			continue
		}
		return open, cutoff, nil
	}
	return time.Time{}, time.Time{}, errors.New("no clearing window found within search horizon")
}

func AssignClearingWindows(payments []Payment, windows []ClearingWindow, now time.Time) ([]ScheduledBatch, []Payment, error) {
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
