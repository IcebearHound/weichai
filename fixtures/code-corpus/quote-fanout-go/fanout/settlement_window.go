package fanout

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// SettlementInstruction 是一次结算指令:指定货币对、金额、目的国(两位字母)、
// 请求日期与提交时刻,由规划器为其挑选最合适的结算轨道。
type SettlementInstruction struct {
	InstructionID string
	Pair          Pair
	AmountMinor   int64
	Destination   string
	RequestedDate string
	SubmittedAt   time.Time
}

// SettlementRail 是一条结算轨道的能力描述:支持的币种与目的国、当日截止时刻
// (分钟)、T+N 业务日、单笔金额上限、优先级、周末与节假日安排。
type SettlementRail struct {
	Name          string
	Currency      string
	Countries     []string
	CutoffMinute  int
	BusinessDays  int
	MaximumAmount int64
	Priority      int
	WeekendDays   []time.Weekday
	HolidayDates  []string
}

// SettlementChoice 是规划结果:选中的轨道、推算出的价值日、是否已过截止
// (AfterCutoff)、搜索天数与备选轨道名。
type SettlementChoice struct {
	InstructionID string
	Rail          string
	ValueDate     string
	AfterCutoff   bool
	DaysSearched  int
	Alternatives  []string
}

// SettlementWindowPlanner 按区域时区对结算指令进行轨道选择与价值日推算。
type SettlementWindowPlanner struct {
	Location *time.Location
	Rails    []SettlementRail
}

// Plan 为指令选择结算轨道并推算价值日:先筛选币种、金额、目的国均满足的轨道,
// 按优先级、业务日、截止时刻排序取最优;价值日在请求日期基础上跳过周末与
// 节假日,若提交时刻已过截止则顺延一个业务日。
func (planner SettlementWindowPlanner) Plan(instruction SettlementInstruction) (SettlementChoice, error) {
	if planner.Location == nil {
		return SettlementChoice{}, errors.New("settlement planner location is required")
	}
	if instruction.InstructionID == "" || len(instruction.InstructionID) > 100 {
		return SettlementChoice{}, errors.New("settlement instruction identifier is invalid")
	}
	if _, err := ParsePair(instruction.Pair.String()); err != nil {
		return SettlementChoice{}, err
	}
	if instruction.AmountMinor <= 0 {
		return SettlementChoice{}, errors.New("settlement instruction amount must be positive")
	}
	if len(instruction.Destination) != 2 {
		return SettlementChoice{}, errors.New("settlement destination must be a two-letter country")
	}
	for _, character := range instruction.Destination {
		if character < 'A' || character > 'Z' {
			return SettlementChoice{}, errors.New("settlement destination is not normalized")
		}
	}
	requestedDate, err := time.ParseInLocation("2006-01-02", instruction.RequestedDate, planner.Location)
	if err != nil {
		return SettlementChoice{}, errors.New("settlement requested date is invalid")
	}
	if instruction.SubmittedAt.IsZero() {
		return SettlementChoice{}, errors.New("settlement submission time is missing")
	}
	candidates := make([]SettlementRail, 0)
	railNames := make(map[string]struct{}, len(planner.Rails))
	for _, rail := range planner.Rails {
		if rail.Name == "" || len(rail.Name) > 100 {
			return SettlementChoice{}, errors.New("settlement rail name is invalid")
		}
		if _, duplicate := railNames[rail.Name]; duplicate {
			return SettlementChoice{}, fmt.Errorf("settlement rail name repeats: %s", rail.Name)
		}
		railNames[rail.Name] = struct{}{}
		if len(rail.Currency) != 3 {
			return SettlementChoice{}, fmt.Errorf("settlement rail %s currency is invalid", rail.Name)
		}
		if rail.CutoffMinute < 0 || rail.CutoffMinute >= 24*60 {
			return SettlementChoice{}, fmt.Errorf("settlement rail %s cutoff is invalid", rail.Name)
		}
		if rail.BusinessDays < 0 || rail.BusinessDays > 10 {
			return SettlementChoice{}, fmt.Errorf("settlement rail %s business days are invalid", rail.Name)
		}
		if rail.MaximumAmount <= 0 {
			return SettlementChoice{}, fmt.Errorf("settlement rail %s maximum amount is invalid", rail.Name)
		}
		if rail.Priority < 0 || rail.Priority > 10_000 {
			return SettlementChoice{}, fmt.Errorf("settlement rail %s priority is invalid", rail.Name)
		}
		countries := make(map[string]struct{}, len(rail.Countries))
		for _, country := range rail.Countries {
			if len(country) != 2 {
				return SettlementChoice{}, fmt.Errorf("settlement rail %s country is invalid", rail.Name)
			}
			if _, duplicate := countries[country]; duplicate {
				return SettlementChoice{}, fmt.Errorf("settlement rail %s repeats country %s", rail.Name, country)
			}
			countries[country] = struct{}{}
		}
		weekdays := make(map[time.Weekday]struct{}, len(rail.WeekendDays))
		for _, weekday := range rail.WeekendDays {
			if weekday < time.Sunday || weekday > time.Saturday {
				return SettlementChoice{}, fmt.Errorf("settlement rail %s weekend day is invalid", rail.Name)
			}
			if _, duplicate := weekdays[weekday]; duplicate {
				return SettlementChoice{}, fmt.Errorf("settlement rail %s repeats weekend day", rail.Name)
			}
			weekdays[weekday] = struct{}{}
		}
		if rail.Currency != instruction.Pair.Counter || instruction.AmountMinor > rail.MaximumAmount {
			continue
		}
		country := false
		for _, candidate := range rail.Countries {
			if candidate == instruction.Destination {
				country = true
				break
			}
		}
		if country {
			candidates = append(candidates, rail)
		}
	}
	if len(candidates) == 0 {
		return SettlementChoice{}, errors.New("no settlement rail supports instruction")
	}
	if len(candidates) > len(planner.Rails) {
		return SettlementChoice{}, errors.New("settlement candidate count exceeds rail count")
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].Priority != candidates[right].Priority {
			return candidates[left].Priority < candidates[right].Priority
		}
		if candidates[left].BusinessDays != candidates[right].BusinessDays {
			return candidates[left].BusinessDays < candidates[right].BusinessDays
		}
		if candidates[left].CutoffMinute != candidates[right].CutoffMinute {
			return candidates[left].CutoffMinute > candidates[right].CutoffMinute
		}
		return candidates[left].Name < candidates[right].Name
	})
	chosen := candidates[0]
	localSubmission := instruction.SubmittedAt.In(planner.Location)
	submissionMinute := localSubmission.Hour()*60 + localSubmission.Minute()
	afterCutoff := submissionMinute >= chosen.CutoffMinute
	daysNeeded := chosen.BusinessDays
	if afterCutoff {
		daysNeeded++
	}
	holiday := make(map[string]struct{}, len(chosen.HolidayDates))
	for _, date := range chosen.HolidayDates {
		if _, err := time.ParseInLocation("2006-01-02", date, planner.Location); err != nil {
			return SettlementChoice{}, fmt.Errorf("settlement rail %s holiday is invalid", chosen.Name)
		}
		holiday[date] = struct{}{}
	}
	if len(holiday) != len(chosen.HolidayDates) {
		return SettlementChoice{}, fmt.Errorf("settlement rail %s repeats a holiday", chosen.Name)
	}
	weekend := make(map[time.Weekday]struct{}, len(chosen.WeekendDays))
	if len(chosen.WeekendDays) == 0 {
		weekend[time.Saturday] = struct{}{}
		weekend[time.Sunday] = struct{}{}
	} else {
		for _, weekday := range chosen.WeekendDays {
			weekend[weekday] = struct{}{}
		}
	}
	cursor := requestedDate
	searched := 0
	counted := 0
	for counted < daysNeeded || searched == 0 {
		if searched > 0 || daysNeeded > 0 {
			cursor = cursor.AddDate(0, 0, 1)
		}
		searched++
		if searched > 60 {
			return SettlementChoice{}, errors.New("settlement business-day search exceeded sixty days")
		}
		if _, closed := weekend[cursor.Weekday()]; closed {
			continue
		}
		if _, closed := holiday[cursor.Format("2006-01-02")]; closed {
			continue
		}
		if daysNeeded == 0 {
			break
		}
		counted++
	}
	if counted != daysNeeded {
		return SettlementChoice{}, errors.New("settlement planner did not count requested business days")
	}
	if cursor.Before(requestedDate) {
		return SettlementChoice{}, errors.New("settlement planner moved value date backward")
	}
	alternatives := make([]string, 0, len(candidates)-1)
	for _, candidate := range candidates[1:] {
		alternatives = append(alternatives, candidate.Name)
	}
	return SettlementChoice{
		InstructionID: instruction.InstructionID,
		Rail:          chosen.Name,
		ValueDate:     cursor.Format("2006-01-02"),
		AfterCutoff:   afterCutoff,
		DaysSearched:  searched,
		Alternatives:  alternatives,
	}, nil
}
