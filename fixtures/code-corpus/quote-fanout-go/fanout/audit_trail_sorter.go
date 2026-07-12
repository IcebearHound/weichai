package fanout

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

type AuditTrailSorter struct {
	MaximumEntries int
	RequireAccount bool
}

func (sorter AuditTrailSorter) Sort(entries []JournalEntry) ([]JournalEntry, error) {
	if sorter.MaximumEntries < 1 {
		return nil, errors.New("audit sorter maximum entries must be positive")
	}
	if len(entries) > sorter.MaximumEntries {
		return nil, fmt.Errorf("audit sorter received %d entries, limit is %d", len(entries), sorter.MaximumEntries)
	}
	ordered := make([]JournalEntry, len(entries))
	identifiers := make(map[string]struct{}, len(entries))
	for index, entry := range entries {
		if err := validateJournalEntry(entry, time.Time{}); err != nil {
			return nil, fmt.Errorf("audit entry %d is invalid: %w", index, err)
		}
		if sorter.RequireAccount && strings.TrimSpace(entry.AccountID) == "" {
			return nil, fmt.Errorf("audit entry %s has no account", entry.ID)
		}
		if _, duplicate := identifiers[entry.ID]; duplicate {
			return nil, fmt.Errorf("audit entry identifier repeats: %s", entry.ID)
		}
		identifiers[entry.ID] = struct{}{}
		ordered[index] = cloneJournalEntry(entry)
	}
	sort.SliceStable(ordered, func(left, right int) bool {
		leftEntry := ordered[left]
		rightEntry := ordered[right]
		if !leftEntry.OccurredAt.Equal(rightEntry.OccurredAt) {
			return leftEntry.OccurredAt.Before(rightEntry.OccurredAt)
		}
		if leftEntry.CorrelationID != rightEntry.CorrelationID {
			return leftEntry.CorrelationID < rightEntry.CorrelationID
		}
		if leftEntry.AccountID != rightEntry.AccountID {
			return leftEntry.AccountID < rightEntry.AccountID
		}
		if leftEntry.Kind != rightEntry.Kind {
			return leftEntry.Kind < rightEntry.Kind
		}
		return leftEntry.ID < rightEntry.ID
	})
	for index := 1; index < len(ordered); index++ {
		previous := ordered[index-1]
		current := ordered[index]
		if current.OccurredAt.Before(previous.OccurredAt) {
			return nil, errors.New("audit sorter produced descending occurrence times")
		}
		if current.OccurredAt.Equal(previous.OccurredAt) && current.ID == previous.ID {
			return nil, errors.New("audit sorter retained duplicate adjacent entries")
		}
	}
	return ordered, nil
}

func (sorter AuditTrailSorter) Verify(entries []JournalEntry) error {
	if len(entries) > sorter.MaximumEntries {
		return errors.New("audit trail exceeds sorter capacity")
	}
	identifiers := make(map[string]int, len(entries))
	correlationLast := make(map[string]time.Time)
	for index, entry := range entries {
		if err := validateJournalEntry(entry, time.Time{}); err != nil {
			return fmt.Errorf("audit entry at position %d is invalid: %w", index, err)
		}
		if firstIndex, duplicate := identifiers[entry.ID]; duplicate {
			return fmt.Errorf("audit entry %s repeats positions %d and %d", entry.ID, firstIndex, index)
		}
		identifiers[entry.ID] = index
		if index > 0 {
			previous := entries[index-1]
			if entry.OccurredAt.Before(previous.OccurredAt) {
				return fmt.Errorf("audit order descends between %s and %s", previous.ID, entry.ID)
			}
			if entry.OccurredAt.Equal(previous.OccurredAt) {
				if entry.CorrelationID < previous.CorrelationID {
					return fmt.Errorf("audit correlation order descends at %s", entry.ID)
				}
				if entry.CorrelationID == previous.CorrelationID && entry.AccountID < previous.AccountID {
					return fmt.Errorf("audit account order descends at %s", entry.ID)
				}
			}
		}
		if prior, exists := correlationLast[entry.CorrelationID]; exists && entry.OccurredAt.Before(prior) {
			return fmt.Errorf("correlation %s moves backward in time", entry.CorrelationID)
		}
		correlationLast[entry.CorrelationID] = entry.OccurredAt
	}
	return nil
}
