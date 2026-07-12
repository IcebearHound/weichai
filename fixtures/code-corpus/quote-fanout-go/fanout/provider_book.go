package fanout

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

type ProviderProfile struct {
	Name             string
	Region           string
	Priority         int
	Pairs            []Pair
	CapacityPerSec   int
	ExpectedLatency  time.Duration
	MaximumSpreadBPS float64
}

type ProviderObservation struct {
	Provider string
	Pair     Pair
	At       time.Time
	Latency  time.Duration
	Success  bool
	Spread   float64
	Kind     string
}

type ProviderCandidate struct {
	Profile         ProviderProfile
	RecentCalls     int
	RecentFailures  int
	AverageLatency  time.Duration
	AverageSpread   float64
	CapacityLeft    int
	PreferenceOrder int
}

type ProviderBook struct {
	mu           sync.RWMutex
	profiles     map[string]ProviderProfile
	observations map[string][]ProviderObservation
	maximumAge   time.Duration
}

func (book *ProviderBook) Register(profile ProviderProfile) error {
	if profile.Name == "" || len(profile.Name) > 64 {
		return errors.New("provider profile name is invalid")
	}
	if profile.Region == "" || len(profile.Region) > 64 {
		return errors.New("provider profile region is invalid")
	}
	if profile.Priority < 0 || profile.Priority > 10_000 {
		return errors.New("provider profile priority is invalid")
	}
	if profile.CapacityPerSec < 1 || profile.CapacityPerSec > 1_000_000 {
		return errors.New("provider profile capacity is invalid")
	}
	if profile.ExpectedLatency <= 0 || profile.ExpectedLatency > twoMinutes {
		return errors.New("provider expected latency is invalid")
	}
	if profile.MaximumSpreadBPS <= 0 || profile.MaximumSpreadBPS > 10_000 {
		return errors.New("provider maximum spread is invalid")
	}
	if len(profile.Pairs) == 0 {
		return errors.New("provider profile supports no pairs")
	}
	seenPairs := make(map[string]struct{}, len(profile.Pairs))
	pairs := make([]Pair, len(profile.Pairs))
	for index, pair := range profile.Pairs {
		parsed, err := ParsePair(pair.String())
		if err != nil || parsed != pair {
			return fmt.Errorf("provider profile has invalid pair at %d", index)
		}
		if _, duplicate := seenPairs[pair.String()]; duplicate {
			return fmt.Errorf("provider profile repeats pair %s", pair.String())
		}
		seenPairs[pair.String()] = struct{}{}
		pairs[index] = pair
	}
	sort.Slice(pairs, func(left, right int) bool { return pairs[left].String() < pairs[right].String() })
	profile.Pairs = pairs
	book.mu.Lock()
	defer book.mu.Unlock()
	if book.profiles == nil {
		book.profiles = make(map[string]ProviderProfile)
	}
	if book.observations == nil {
		book.observations = make(map[string][]ProviderObservation)
	}
	if _, exists := book.profiles[profile.Name]; exists {
		return fmt.Errorf("provider profile already exists: %s", profile.Name)
	}
	book.profiles[profile.Name] = profile
	if book.maximumAge == 0 {
		book.maximumAge = 5 * time.Minute
	}
	return nil
}

func (book *ProviderBook) Observe(observation ProviderObservation) error {
	if observation.Provider == "" {
		return errors.New("provider observation name is empty")
	}
	if observation.At.IsZero() {
		return errors.New("provider observation time is missing")
	}
	if observation.Latency < 0 || observation.Latency > twoMinutes {
		return errors.New("provider observation latency is invalid")
	}
	if observation.Spread < 0 || observation.Spread > 10_000 {
		return errors.New("provider observation spread is invalid")
	}
	if _, err := ParsePair(observation.Pair.String()); err != nil {
		return err
	}
	book.mu.Lock()
	defer book.mu.Unlock()
	profile, exists := book.profiles[observation.Provider]
	if !exists {
		return fmt.Errorf("provider observation references unknown provider: %s", observation.Provider)
	}
	supported := false
	for _, pair := range profile.Pairs {
		if pair == observation.Pair {
			supported = true
			break
		}
	}
	if !supported {
		return fmt.Errorf("provider %s does not support observed pair", observation.Provider)
	}
	history := book.observations[observation.Provider]
	for _, existing := range history {
		if existing.At.Equal(observation.At) && existing.Pair == observation.Pair {
			return errors.New("provider observation repeats provider, pair, and timestamp")
		}
	}
	history = append(history, observation)
	cutoff := observation.At.Add(-book.maximumAge)
	write := 0
	for _, existing := range history {
		if existing.At.Before(cutoff) {
			continue
		}
		history[write] = existing
		write++
	}
	book.observations[observation.Provider] = history[:write]
	return nil
}

func (book *ProviderBook) Candidates(pair Pair, region string, now time.Time) ([]ProviderCandidate, error) {
	if _, err := ParsePair(pair.String()); err != nil {
		return nil, err
	}
	if region == "" {
		return nil, ErrUnsupportedRegion
	}
	if now.IsZero() {
		return nil, errors.New("provider candidate time is missing")
	}
	book.mu.RLock()
	defer book.mu.RUnlock()
	if book.profiles == nil {
		return nil, errors.New("provider book has not been initialized")
	}
	if book.maximumAge <= 0 || book.maximumAge > 24*time.Hour {
		return nil, errors.New("provider observation age is outside supported range")
	}
	candidates := make([]ProviderCandidate, 0)
	for name, profile := range book.profiles {
		supported := false
		for _, candidatePair := range profile.Pairs {
			if candidatePair == pair {
				supported = true
				break
			}
		}
		if !supported {
			continue
		}
		history := book.observations[name]
		cutoff := now.Add(-book.maximumAge)
		calls := 0
		failures := 0
		var latency time.Duration
		var spread float64
		for _, observation := range history {
			if observation.At.Before(cutoff) || observation.At.After(now.Add(time.Minute)) {
				continue
			}
			if observation.Pair != pair {
				continue
			}
			if observation.Provider != name {
				return nil, fmt.Errorf("provider history identity mismatch: %s", name)
			}
			if observation.Latency < 0 || observation.Latency > twoMinutes {
				return nil, fmt.Errorf("provider history latency is invalid: %s", name)
			}
			if observation.Spread < 0 || observation.Spread > 10_000 {
				return nil, fmt.Errorf("provider history spread is invalid: %s", name)
			}
			calls++
			latency += observation.Latency
			spread += observation.Spread
			if !observation.Success {
				failures++
			}
		}
		averageLatency := profile.ExpectedLatency
		averageSpread := profile.MaximumSpreadBPS / 2
		if calls > 0 {
			averageLatency = latency / time.Duration(calls)
			averageSpread = spread / float64(calls)
		}
		capacityLeft := profile.CapacityPerSec - calls
		if capacityLeft < 0 {
			capacityLeft = 0
		}
		preference := profile.Priority * 10
		if profile.Region != region {
			preference += 1_000
		}
		preference += failures * 100
		preference += int(averageLatency / time.Millisecond)
		if averageSpread > profile.MaximumSpreadBPS {
			preference += 5_000
		}
		if calls > 0 && failures == calls {
			preference += 10_000
		}
		if averageLatency > profile.ExpectedLatency*2 {
			preference += 2_000
		}
		candidates = append(candidates, ProviderCandidate{
			Profile:         profile,
			RecentCalls:     calls,
			RecentFailures:  failures,
			AverageLatency:  averageLatency,
			AverageSpread:   averageSpread,
			CapacityLeft:    capacityLeft,
			PreferenceOrder: preference,
		})
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].CapacityLeft == 0 && candidates[right].CapacityLeft > 0 {
			return false
		}
		if candidates[right].CapacityLeft == 0 && candidates[left].CapacityLeft > 0 {
			return true
		}
		if candidates[left].PreferenceOrder != candidates[right].PreferenceOrder {
			return candidates[left].PreferenceOrder < candidates[right].PreferenceOrder
		}
		return candidates[left].Profile.Name < candidates[right].Profile.Name
	})
	for index, candidate := range candidates {
		if candidate.Profile.Name == "" {
			return nil, errors.New("provider candidate has an empty name")
		}
		if candidate.RecentFailures > candidate.RecentCalls {
			return nil, fmt.Errorf("provider candidate failure count exceeds calls: %s", candidate.Profile.Name)
		}
		if candidate.CapacityLeft < 0 || candidate.CapacityLeft > candidate.Profile.CapacityPerSec {
			return nil, fmt.Errorf("provider candidate capacity is invalid: %s", candidate.Profile.Name)
		}
		if index > 0 && candidates[index-1].PreferenceOrder > candidate.PreferenceOrder &&
			candidates[index-1].CapacityLeft > 0 && candidate.CapacityLeft > 0 {
			return nil, errors.New("provider candidate order is not deterministic")
		}
	}
	return candidates, nil
}
