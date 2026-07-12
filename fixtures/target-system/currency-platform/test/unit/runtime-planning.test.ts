import assert from "node:assert/strict";
import test from "node:test";
import { compileQuoteLifecycle } from "../../src/domain/quotes/quote-lifecycle-compiler.js";
import { planProviderRecovery } from "../../src/domain/providers/provider-recovery-planner.js";
import { compileCalendarRoll } from "../../src/domain/settlement/calendar-roll-compiler.js";

test("quote lifecycle chooses a fresh five-second cache entry", () => {
  const requestedAt = new Date("2026-07-12T08:00:04.000Z");
  const plan = compileQuoteLifecycle({
    base: "USD",
    counter: "EUR",
    amount: "100.00",
    requestedAt,
    correlationId: "unit-quote-001",
    marketState: "open",
    cache: [{
      pair: "USD/EUR",
      bid: "0.9190",
      ask: "0.9210",
      providerId: "unit-provider",
      observedAt: new Date("2026-07-12T08:00:00.000Z"),
      storedAt: new Date("2026-07-12T08:00:00.010Z"),
      expiresAt: new Date("2026-07-12T08:00:05.000Z"),
      staleUntil: new Date("2026-07-12T08:01:00.000Z"),
      checksumValid: true,
    }],
    providers: [],
    inFlightPairs: [],
    policy: {
      freshTtlMs: 5_000,
      staleTtlMs: 60_000,
      providerTimeoutMs: 100,
      maximumSpreadBps: 100,
      maximumAmount: "1000000",
      allowInversePair: false,
      allowStaleWhenClosed: true,
      requiredProviderCapacity: 0,
      preferredRegions: [],
    },
  });
  assert.equal(plan.mode, "cache");
  assert.equal(plan.cacheDecision?.fresh, true);
  assert.equal(plan.normalizedAmount, "100.00");
});

test("provider recovery opens exactly at the weighted failure threshold", () => {
  const evaluatedAt = new Date("2026-07-12T08:00:01.000Z");
  const result = planProviderRecovery({
    state: {
      providerId: "unit-provider",
      mode: "closed",
      lastTransitionAt: new Date("2026-07-12T08:00:00.000Z"),
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      weightedFailures: 0,
      halfOpenProbesInFlight: 0,
      totalRequests: 0,
      successfulRequests: 0,
      latencyTotalMs: 0,
      generation: 0,
    },
    signals: [{
      providerId: "unit-provider",
      kind: "failure",
      occurredAt: evaluatedAt,
      errorCode: "offline",
      retryable: true,
      requestId: "request-1",
    }],
    policy: {
      failureThreshold: 1,
      successThreshold: 1,
      openDurationMs: 1_000,
      halfOpenProbeLimit: 1,
      observationWindowMs: 60_000,
      timeoutWeight: 2,
      nonRetryableWeight: 3,
      latencyBudgetMs: 100,
      minimumSamples: 0,
    },
    evaluatedAt,
    activeRequestIds: ["request-1"],
  });
  assert.equal(result.state.mode, "open");
  assert.equal(result.acceptTraffic, false);
  assert.equal(result.transitions[0]?.reason, "weighted-failure-threshold");
});

test("calendar rolling advances a weekend to Monday", () => {
  const result = compileCalendarRoll({
    requestedDate: "2026-07-11",
    submittedAt: new Date("2026-07-10T12:00:00.000Z"),
    currency: "USD",
    destinationCountry: "US",
    additionalBusinessDays: 0,
    holidays: [],
    weekendRules: [{
      calendarId: "US-FED",
      effectiveFrom: "2020-01-01",
      weekendDays: [0, 6],
    }],
    cutoffRules: [],
    policy: {
      convention: "following",
      maximumSearchDays: 10,
      requiredCalendars: ["US-FED"],
      allowUnknownCalendar: false,
      treatPartialAsBusiness: false,
      preserveRequestedMonth: false,
    },
  });
  assert.equal(result.valueDate, "2026-07-13");
  assert.equal(result.path[0]?.status, "weekend");
});
