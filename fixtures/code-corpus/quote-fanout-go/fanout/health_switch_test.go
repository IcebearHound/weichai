package fanout

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHealthSwitchReturnsPrimaryQuoteWithoutTouchingBackup(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "EUR/USD")
	primaryQuote := sampleQuote(t, clock, "EUR/USD", "primary-bank", 1_085_000)
	backupQuote := sampleQuote(t, clock, "EUR/USD", "reserve-bank", 1_085_500)
	primary := providerFor("primary-bank", providerResponse{quote: primaryQuote})
	backup := providerFor("reserve-bank", providerResponse{quote: backupQuote})
	switcher, err := NewHealthSwitch(clock, switchPolicy(), []SourceRegistration{
		{Provider: backup, Priority: 20, Pairs: []Pair{pair}},
		{Provider: primary, Priority: 10, Pairs: []Pair{pair}},
	})
	requireNoError(t, err)
	result, err := switcher.Select(context.Background(), sampleRequest(t, clock, "EUR/USD", "primary"))
	requireNoError(t, err)
	requireEqual(t, result.Provider, "primary-bank")
	requireEqual(t, primary.CallCount(), 1)
	requireEqual(t, backup.CallCount(), 0)
	views := switcher.Snapshot()
	requireEqual(t, len(views), 2)
	requireEqual(t, views[0].Provider, "primary-bank")
	requireEqual(t, views[0].RequestCount, uint64(1))
	requireEqual(t, views[0].SuccessCount, uint64(1))
	requireEqual(t, views[0].Mode, SourceClosed)
	requireEqual(t, views[1].RequestCount, uint64(0))
}

func TestHealthSwitchFailsOverAndKeepsProviderFailureStateIndependent(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "GBP/USD")
	primary := providerFor(
		"primary-bank",
		providerResponse{err: errors.New("primary reset one")},
		providerResponse{err: errors.New("primary reset two")},
	)
	backup := providerFor(
		"reserve-bank",
		providerResponse{quote: sampleQuote(t, clock, "GBP/USD", "reserve-bank", 1_271_000)},
		providerResponse{quote: sampleQuote(t, clock, "GBP/USD", "reserve-bank", 1_271_100)},
		providerResponse{quote: sampleQuote(t, clock, "GBP/USD", "reserve-bank", 1_271_200)},
	)
	switcher, err := NewHealthSwitch(clock, switchPolicy(), []SourceRegistration{
		{Provider: primary, Priority: 1, Pairs: []Pair{pair}},
		{Provider: backup, Priority: 2, Pairs: []Pair{pair}},
	})
	requireNoError(t, err)
	for index := 0; index < 2; index++ {
		request := sampleRequest(t, clock, "GBP/USD", "failover-"+string(rune('a'+index)))
		quote, selectErr := switcher.Select(context.Background(), request)
		requireNoError(t, selectErr)
		requireEqual(t, quote.Provider, "reserve-bank")
	}
	views := switcher.Snapshot()
	var primaryView, backupView SourceView
	for _, view := range views {
		if view.Provider == "primary-bank" {
			primaryView = view
		}
		if view.Provider == "reserve-bank" {
			backupView = view
		}
	}
	requireEqual(t, primaryView.Mode, SourceOpen)
	requireEqual(t, primaryView.ConsecutiveFailures, 2)
	requireEqual(t, primaryView.WeightedFailures, 2)
	requireEqual(t, primaryView.SuccessCount, uint64(0))
	requireEqual(t, backupView.Mode, SourceClosed)
	requireEqual(t, backupView.ConsecutiveFailures, 0)
	requireEqual(t, backupView.WeightedFailures, 0)
	requireEqual(t, backupView.SuccessCount, uint64(2))
	quote, err := switcher.Select(context.Background(), sampleRequest(t, clock, "GBP/USD", "while-open"))
	requireNoError(t, err)
	requireEqual(t, quote.Provider, "reserve-bank")
	requireEqual(t, primary.CallCount(), 2)
	requireEqual(t, backup.CallCount(), 3)
}

func TestHealthSwitchAllowsExactlyOneConcurrentHalfOpenProbe(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "USD/JPY")
	probeRelease := make(chan struct{})
	primary := providerFor(
		"tokyo-primary",
		providerResponse{err: errors.New("first outage")},
		providerResponse{err: errors.New("second outage")},
		providerResponse{quote: sampleQuote(t, clock, "USD/JPY", "tokyo-primary", 149_200_000), wait: probeRelease},
	)
	backup := providerFor(
		"osaka-reserve",
		providerResponse{quote: sampleQuote(t, clock, "USD/JPY", "osaka-reserve", 149_250_000)},
		providerResponse{quote: sampleQuote(t, clock, "USD/JPY", "osaka-reserve", 149_260_000)},
		providerResponse{quote: sampleQuote(t, clock, "USD/JPY", "osaka-reserve", 149_270_000)},
	)
	switcher, err := NewHealthSwitch(clock, switchPolicy(), []SourceRegistration{
		{Provider: primary, Priority: 1, Pairs: []Pair{pair}},
		{Provider: backup, Priority: 2, Pairs: []Pair{pair}},
	})
	requireNoError(t, err)
	for index := 0; index < 2; index++ {
		_, err = switcher.Select(context.Background(), sampleRequest(t, clock, "USD/JPY", "open-primary"))
		requireNoError(t, err)
	}
	clock.Advance(6 * time.Second)
	firstResult := make(chan Quote, 1)
	firstError := make(chan error, 1)
	go func() {
		quote, selectErr := switcher.Select(context.Background(), sampleRequest(t, clock, "USD/JPY", "probe-one"))
		firstResult <- quote
		firstError <- selectErr
	}()
	waitFor(t, "primary half-open probe to start", func() bool {
		views := switcher.Snapshot()
		for _, view := range views {
			if view.Provider == "tokyo-primary" {
				return view.Mode == SourceHalfOpen && view.ProbeInFlight
			}
		}
		return false
	})
	second, err := switcher.Select(context.Background(), sampleRequest(t, clock, "USD/JPY", "probe-two"))
	requireNoError(t, err)
	requireEqual(t, second.Provider, "osaka-reserve")
	requireEqual(t, primary.CallCount(), 3)
	close(probeRelease)
	first := <-firstResult
	requireNoError(t, <-firstError)
	requireEqual(t, first.Provider, "tokyo-primary")
	requireEqual(t, primary.MaximumConcurrent(), 1)
	var recovered SourceView
	for _, view := range switcher.Snapshot() {
		if view.Provider == "tokyo-primary" {
			recovered = view
		}
	}
	requireEqual(t, recovered.Mode, SourceClosed)
	if recovered.ProbeInFlight {
		t.Fatal("successful recovery left probe marker set")
	}
	requireEqual(t, recovered.WeightedFailures, 0)
	requireEqual(t, recovered.ConsecutiveFailures, 0)
}

func TestHealthSwitchFailedProbeReopensOnlyThatProvider(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "AUD/USD")
	primary := providerFor(
		"sydney-primary",
		providerResponse{err: errors.New("outage one")},
		providerResponse{err: errors.New("outage two")},
		providerResponse{err: errors.New("probe rejected")},
	)
	backup := providerFor(
		"melbourne-reserve",
		providerResponse{quote: sampleQuote(t, clock, "AUD/USD", "melbourne-reserve", 657_000)},
		providerResponse{quote: sampleQuote(t, clock, "AUD/USD", "melbourne-reserve", 657_100)},
		providerResponse{quote: sampleQuote(t, clock, "AUD/USD", "melbourne-reserve", 657_200)},
	)
	switcher, err := NewHealthSwitch(clock, switchPolicy(), []SourceRegistration{
		{Provider: primary, Priority: 1, Pairs: []Pair{pair}},
		{Provider: backup, Priority: 2, Pairs: []Pair{pair}},
	})
	requireNoError(t, err)
	for index := 0; index < 2; index++ {
		_, err = switcher.Select(context.Background(), sampleRequest(t, clock, "AUD/USD", "outage"))
		requireNoError(t, err)
	}
	clock.Advance(5 * time.Second)
	quote, err := switcher.Select(context.Background(), sampleRequest(t, clock, "AUD/USD", "probe-failure"))
	requireNoError(t, err)
	requireEqual(t, quote.Provider, "melbourne-reserve")
	var primaryView, backupView SourceView
	for _, view := range switcher.Snapshot() {
		if view.Provider == "sydney-primary" {
			primaryView = view
		} else {
			backupView = view
		}
	}
	requireEqual(t, primaryView.Mode, SourceOpen)
	if primaryView.OpenedAt != clock.Now() {
		t.Fatalf("probe failure should restart cooldown at %v, got %v", clock.Now(), primaryView.OpenedAt)
	}
	requireEqual(t, backupView.Mode, SourceClosed)
	requireEqual(t, backupView.SuccessCount, uint64(3))
}

func TestHealthSwitchWeightsPermanentProviderFailures(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "EUR/CHF")
	permanent := ProviderFailure{
		Provider:  "alpine-primary",
		Kind:      "authorization",
		Retryable: false,
		Cause:     errors.New("credentials rejected"),
	}
	primary := providerFor("alpine-primary", providerResponse{err: permanent})
	backup := providerFor("alpine-reserve", providerResponse{quote: sampleQuote(t, clock, "EUR/CHF", "alpine-reserve", 941_000)})
	switcher, err := NewHealthSwitch(clock, switchPolicy(), []SourceRegistration{
		{Provider: primary, Priority: 1, Pairs: []Pair{pair}},
		{Provider: backup, Priority: 2, Pairs: []Pair{pair}},
	})
	requireNoError(t, err)
	quote, err := switcher.Select(context.Background(), sampleRequest(t, clock, "EUR/CHF", "permanent"))
	requireNoError(t, err)
	requireEqual(t, quote.Provider, "alpine-reserve")
	for _, view := range switcher.Snapshot() {
		if view.Provider == "alpine-primary" {
			requireEqual(t, view.Mode, SourceOpen)
			requireEqual(t, view.WeightedFailures, 2)
			if !strings.Contains(view.LastError, "credentials rejected") {
				t.Fatalf("last error did not retain cause: %s", view.LastError)
			}
		}
	}
}

func TestHealthSwitchTimesOutProviderAndTriesReserve(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "NZD/USD")
	never := make(chan struct{})
	primary := providerFor("slow-feed", providerResponse{wait: never})
	backup := providerFor("fast-feed", providerResponse{quote: sampleQuote(t, clock, "NZD/USD", "fast-feed", 612_000)})
	policy := switchPolicy()
	policy.RequestTimeout = 12 * time.Millisecond
	switcher, err := NewHealthSwitch(clock, policy, []SourceRegistration{
		{Provider: primary, Priority: 1, Pairs: []Pair{pair}},
		{Provider: backup, Priority: 2, Pairs: []Pair{pair}},
	})
	requireNoError(t, err)
	quote, err := switcher.Select(context.Background(), sampleRequest(t, clock, "NZD/USD", "timeout"))
	requireNoError(t, err)
	requireEqual(t, quote.Provider, "fast-feed")
	requireEqual(t, primary.CallCount(), 1)
	requireEqual(t, backup.CallCount(), 1)
}

func TestHealthSwitchReturnsJoinedFailuresWhenEveryProviderFails(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "CAD/JPY")
	primary := providerFor("canada-feed", providerResponse{err: errors.New("network unreachable")})
	backup := providerFor("japan-feed", providerResponse{err: errors.New("market paused")})
	switcher, err := NewHealthSwitch(clock, switchPolicy(), []SourceRegistration{
		{Provider: primary, Priority: 1, Pairs: []Pair{pair}},
		{Provider: backup, Priority: 2, Pairs: []Pair{pair}},
	})
	requireNoError(t, err)
	_, err = switcher.Select(context.Background(), sampleRequest(t, clock, "CAD/JPY", "all-fail"))
	requireErrorIs(t, err, ErrQuoteUnavailable)
	message := err.Error()
	for _, expected := range []string{"canada-feed", "network unreachable", "japan-feed", "market paused"} {
		if !strings.Contains(message, expected) {
			t.Fatalf("joined failure lacks %q: %s", expected, message)
		}
	}
}

func TestHealthSwitchRejectsUnsupportedPairAndHonorsReset(t *testing.T) {
	clock := newManualClock()
	euroDollar := mustPair(t, "EUR/USD")
	provider := providerFor("single-feed", providerResponse{err: errors.New("one failure")})
	switcher, err := NewHealthSwitch(clock, switchPolicy(), []SourceRegistration{
		{Provider: provider, Priority: 1, Pairs: []Pair{euroDollar}},
	})
	requireNoError(t, err)
	_, err = switcher.Select(context.Background(), sampleRequest(t, clock, "GBP/USD", "unsupported"))
	requireErrorIs(t, err, ErrQuoteUnavailable)
	_, err = switcher.Select(context.Background(), sampleRequest(t, clock, "EUR/USD", "failure"))
	requireErrorIs(t, err, ErrQuoteUnavailable)
	if !switcher.Reset("single-feed") {
		t.Fatal("registered provider should reset")
	}
	if switcher.Reset("missing-feed") {
		t.Fatal("unknown provider should not reset")
	}
	view := switcher.Snapshot()[0]
	requireEqual(t, view.Mode, SourceClosed)
	requireEqual(t, view.ConsecutiveFailures, 0)
	requireEqual(t, view.WeightedFailures, 0)
	requireEqual(t, view.LastError, "")
}

func TestHealthSwitchValidatesPolicyAndRegistrations(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "EUR/USD")
	provider := providerFor("feed")
	valid := switchPolicy()
	cases := []struct {
		name          string
		policy        SwitchPolicy
		registrations []SourceRegistration
	}{
		{name: "zero failure limit", policy: SwitchPolicy{RecoverySuccesses: 1, OpenFor: time.Second, RequestTimeout: time.Second, MaximumProbeCalls: 1, NonRetryableWeight: 1}, registrations: []SourceRegistration{{Provider: provider, Pairs: []Pair{pair}}}},
		{name: "zero recovery", policy: SwitchPolicy{FailureLimit: 1, OpenFor: time.Second, RequestTimeout: time.Second, MaximumProbeCalls: 1, NonRetryableWeight: 1}, registrations: []SourceRegistration{{Provider: provider, Pairs: []Pair{pair}}}},
		{name: "no cooldown", policy: SwitchPolicy{FailureLimit: 1, RecoverySuccesses: 1, RequestTimeout: time.Second, MaximumProbeCalls: 1, NonRetryableWeight: 1}, registrations: []SourceRegistration{{Provider: provider, Pairs: []Pair{pair}}}},
		{name: "no timeout", policy: SwitchPolicy{FailureLimit: 1, RecoverySuccesses: 1, OpenFor: time.Second, MaximumProbeCalls: 1, NonRetryableWeight: 1}, registrations: []SourceRegistration{{Provider: provider, Pairs: []Pair{pair}}}},
		{name: "multiple probes", policy: SwitchPolicy{FailureLimit: 1, RecoverySuccesses: 1, OpenFor: time.Second, RequestTimeout: time.Second, MaximumProbeCalls: 2, NonRetryableWeight: 1}, registrations: []SourceRegistration{{Provider: provider, Pairs: []Pair{pair}}}},
		{name: "no registrations", policy: valid, registrations: nil},
		{name: "provider missing", policy: valid, registrations: []SourceRegistration{{Priority: 1, Pairs: []Pair{pair}}}},
		{name: "pairs missing", policy: valid, registrations: []SourceRegistration{{Provider: provider, Priority: 1}}},
		{name: "priority invalid", policy: valid, registrations: []SourceRegistration{{Provider: provider, Priority: -1, Pairs: []Pair{pair}}}},
	}
	for _, candidate := range cases {
		t.Run(candidate.name, func(t *testing.T) {
			if _, err := NewHealthSwitch(clock, candidate.policy, candidate.registrations); err == nil {
				t.Fatal("expected constructor validation error")
			}
		})
	}
	duplicateOne := providerFor("duplicate")
	duplicateTwo := providerFor("duplicate")
	_, err := NewHealthSwitch(clock, valid, []SourceRegistration{
		{Provider: duplicateOne, Priority: 1, Pairs: []Pair{pair}},
		{Provider: duplicateTwo, Priority: 2, Pairs: []Pair{pair}},
	})
	if err == nil {
		t.Fatal("duplicate provider names should be rejected")
	}
	otherPair := mustPair(t, "GBP/USD")
	_, err = NewHealthSwitch(clock, valid, []SourceRegistration{
		{Provider: providerFor("euro"), Priority: 1, Pairs: []Pair{pair}},
		{Provider: providerFor("sterling"), Priority: 2, Pairs: []Pair{otherPair}},
	})
	if err == nil {
		t.Fatal("multi-provider switch without overlapping fallback should be rejected")
	}
}

func TestHealthSwitchSerializesSnapshotReadsDuringConcurrentCalls(t *testing.T) {
	clock := newManualClock()
	pair := mustPair(t, "EUR/GBP")
	release := make(chan struct{})
	primary := providerFor("london-feed", providerResponse{quote: sampleQuote(t, clock, "EUR/GBP", "london-feed", 856_000), wait: release})
	switcher, err := NewHealthSwitch(clock, switchPolicy(), []SourceRegistration{{Provider: primary, Pairs: []Pair{pair}}})
	requireNoError(t, err)
	finished := make(chan error, 1)
	go func() {
		_, selectErr := switcher.Select(context.Background(), sampleRequest(t, clock, "EUR/GBP", "snapshot-race"))
		finished <- selectErr
	}()
	waitFor(t, "provider request to begin", func() bool { return primary.CallCount() == 1 })
	const readers = 30
	var group sync.WaitGroup
	group.Add(readers)
	for index := 0; index < readers; index++ {
		go func() {
			defer group.Done()
			views := switcher.Snapshot()
			if len(views) != 1 || views[0].Provider != "london-feed" {
				t.Errorf("unexpected concurrent snapshot: %#v", views)
			}
		}()
	}
	group.Wait()
	close(release)
	requireNoError(t, <-finished)
}
