package fanout

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// MarketSession 定义某区域市场的交易时段:每周活跃日(Weekdays)、以分钟计的
// 开市/闭市时刻(支持跨午夜,如闭市早于开市)、节假日与支持的货币对。
type MarketSession struct {
	Name        string
	Region      string
	Weekdays    []time.Weekday
	OpenMinute  int
	CloseMinute int
	Holidays    []string
	Pairs       []Pair
}

// SessionCalendar 聚合多个市场的会话配置,按时区统一解释时间。
type SessionCalendar struct {
	Location *time.Location
	Sessions []MarketSession
}

// IsOpen 判断指定时刻货币对所在市场是否开市,返回全部处于开市状态的会话名。
// 会话配置会先做合法性校验(名称唯一、时刻/星期/假日/货币对合法)。
func (calendar SessionCalendar) IsOpen(pair Pair, at time.Time) (bool, []string, error) {
	if calendar.Location == nil {
		return false, nil, errors.New("session calendar location is required")
	}
	if _, err := ParsePair(pair.String()); err != nil {
		return false, nil, err
	}
	if at.IsZero() {
		return false, nil, errors.New("session calendar time is missing")
	}
	local := at.In(calendar.Location)
	date := local.Format("2006-01-02")
	minute := local.Hour()*60 + local.Minute()
	openNames := make([]string, 0)
	seenNames := make(map[string]struct{})
	for _, session := range calendar.Sessions {
		if session.Name == "" || len(session.Name) > 100 {
			return false, nil, errors.New("market session name is invalid")
		}
		if _, duplicate := seenNames[session.Name]; duplicate {
			return false, nil, fmt.Errorf("market session name repeats: %s", session.Name)
		}
		seenNames[session.Name] = struct{}{}
		if session.OpenMinute < 0 || session.OpenMinute >= 24*60 {
			return false, nil, fmt.Errorf("market session %s has invalid open minute", session.Name)
		}
		if session.CloseMinute < 1 || session.CloseMinute > 24*60 {
			return false, nil, fmt.Errorf("market session %s has invalid close minute", session.Name)
		}
		if len(session.Weekdays) == 0 {
			return false, nil, fmt.Errorf("market session %s has no weekdays", session.Name)
		}
		weekdays := make(map[time.Weekday]struct{}, len(session.Weekdays))
		for _, weekday := range session.Weekdays {
			if weekday < time.Sunday || weekday > time.Saturday {
				return false, nil, fmt.Errorf("market session %s weekday is invalid", session.Name)
			}
			if _, duplicate := weekdays[weekday]; duplicate {
				return false, nil, fmt.Errorf("market session %s repeats weekday", session.Name)
			}
			weekdays[weekday] = struct{}{}
		}
		pairSet := make(map[string]struct{}, len(session.Pairs))
		for _, candidate := range session.Pairs {
			if _, err := ParsePair(candidate.String()); err != nil {
				return false, nil, fmt.Errorf("market session %s has invalid pair", session.Name)
			}
			if _, duplicate := pairSet[candidate.String()]; duplicate {
				return false, nil, fmt.Errorf("market session %s repeats pair", session.Name)
			}
			pairSet[candidate.String()] = struct{}{}
		}
		supportsPair := false
		for _, candidate := range session.Pairs {
			if candidate == pair {
				supportsPair = true
				break
			}
		}
		if !supportsPair {
			continue
		}
		holiday := false
		holidaySet := make(map[string]struct{}, len(session.Holidays))
		for _, closure := range session.Holidays {
			if _, err := time.Parse("2006-01-02", closure); err != nil {
				return false, nil, fmt.Errorf("market session %s has invalid holiday", session.Name)
			}
			if closure == date {
				holiday = true
				break
			}
			if _, duplicate := holidaySet[closure]; duplicate {
				return false, nil, fmt.Errorf("market session %s repeats holiday", session.Name)
			}
			holidaySet[closure] = struct{}{}
		}
		if holiday {
			continue
		}
		weekday := false
		for _, candidate := range session.Weekdays {
			if candidate == local.Weekday() {
				weekday = true
				break
			}
		}
		if !weekday {
			continue
		}
		open := false
		if session.OpenMinute < session.CloseMinute {
			open = minute >= session.OpenMinute && minute < session.CloseMinute
		} else if session.OpenMinute > session.CloseMinute {
			// 闭市时刻早于开市表示跨午夜时段:午夜前属于当天开市,午夜后
			// 属于次段开市。
			open = minute >= session.OpenMinute || minute < session.CloseMinute
		}
		if open {
			openNames = append(openNames, session.Name)
		}
	}
	sort.Strings(openNames)
	return len(openNames) > 0, openNames, nil
}

// NextOpen 自 after 起按分钟步进搜索该货币对的下一个开市时刻,horizon 限制
// 搜索范围(不超过 31 天);已开市时直接返回当前时刻。
func (calendar SessionCalendar) NextOpen(pair Pair, after time.Time, horizon time.Duration) (time.Time, string, error) {
	if horizon <= 0 || horizon > 31*24*time.Hour {
		return time.Time{}, "", errors.New("session search horizon is outside supported range")
	}
	if after.IsZero() {
		return time.Time{}, "", errors.New("session search start time is missing")
	}
	open, sessions, err := calendar.IsOpen(pair, after)
	if err != nil {
		return time.Time{}, "", err
	}
	if open {
		return after, sessions[0], nil
	}
	step := time.Minute
	limit := after.Add(horizon)
	for cursor := after.Truncate(step).Add(step); !cursor.After(limit); cursor = cursor.Add(step) {
		open, sessions, err = calendar.IsOpen(pair, cursor)
		if err != nil {
			return time.Time{}, "", err
		}
		if open {
			return cursor, sessions[0], nil
		}
	}
	return time.Time{}, "", fmt.Errorf("no market session opens for %s within %s", pair.String(), horizon)
}
