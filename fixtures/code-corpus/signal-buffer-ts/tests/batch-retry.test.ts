import assert from "node:assert/strict";
import test from "node:test";
import {
  OrderedBatchMap,
  RetryWheel,
  constructSettlementWaves,
  optimizeRetryBudget,
  type SettlementOutcome,
} from "../src/index.js";
import { EUR, USD, retry, settlement, settlementBook } from "./scenario-fixtures.js";

test("batch collection preserves input order despite completion order", async () => {
  const batch = new OrderedBatchMap();
  const intents = [
    settlement("slow", "a", 10),
    settlement("fast", "b", 20),
    settlement("medium", "c", 30),
  ];
  const delays: Record<string, number> = { slow: 20, fast: 1, medium: 8 };
  const outcomes = await batch.collect(intents, async (intent) => {
    await new Promise((resolve) => setTimeout(resolve, delays[intent.identity]));
    return `receipt-${intent.identity}`;
  }, 1);
  assert.deepEqual(outcomes.map((entry) => entry.identity), ["slow", "fast", "medium"]);
  assert.deepEqual(outcomes.map((entry) => entry.ordinal), [0, 1, 2]);
  assert.ok(outcomes.every((entry) => entry.status === "settled"));
});

test("duplicate identities share one receipt", async () => {
  const batch = new OrderedBatchMap();
  let calls = 0;
  const intentions = [
    settlement("same", "a", 100),
    settlement("same", "a", 100),
    settlement("other", "b", 50),
  ];
  const outcomes = await batch.collect(intentions, async (intent) => {
    calls += 1;
    return `receipt-${intent.identity}-${calls}`;
  }, 1);
  assert.equal(calls, 2);
  assert.equal(outcomes[0].receipt, outcomes[1].receipt);
  assert.notEqual(outcomes[0].receipt, outcomes[2].receipt);
});

test("completed identities are idempotent across batches", async () => {
  const batch = new OrderedBatchMap();
  const intent = settlement("durable-key");
  let receipts = 0;
  const first = await batch.collect([intent], async () => `receipt-${++receipts}`, 2);
  const second = await batch.collect([intent], async () => `receipt-${++receipts}`, 2);
  assert.equal(receipts, 1);
  assert.equal(first[0].receipt, "receipt-1");
  assert.equal(second[0].receipt, "receipt-1");
  assert.equal(second[0].attempts, 0);
});

test("transient worker failures retry only the affected item", async () => {
  const batch = new OrderedBatchMap();
  const calls = new Map<string, number>();
  const outcomes = await batch.collect([
    settlement("stable"),
    settlement("flaky"),
  ], async (intent, attempt) => {
    calls.set(intent.identity, (calls.get(intent.identity) ?? 0) + 1);
    if (intent.identity === "flaky" && attempt < 3) throw new Error(`temporary-${attempt}`);
    return `receipt-${intent.identity}`;
  }, 3);
  assert.equal(calls.get("stable"), 1);
  assert.equal(calls.get("flaky"), 3);
  assert.equal(outcomes[0].attempts, 1);
  assert.equal(outcomes[1].attempts, 3);
});

test("permanent worker failure is deferred with final reason", async () => {
  const batch = new OrderedBatchMap();
  const outcomes = await batch.collect([settlement("offline")], async (_intent, attempt) => {
    throw new Error(`failure-${attempt}`);
  }, 4);
  assert.equal(outcomes[0].status, "deferred");
  assert.equal(outcomes[0].attempts, 4);
  assert.equal(outcomes[0].reason, "failure-4");
  assert.equal(outcomes[0].receipt, undefined);
});

test("empty receipt is treated as a failed attempt", async () => {
  const batch = new OrderedBatchMap();
  const outcomes = await batch.collect([settlement("empty")], async () => "   ", 2);
  assert.equal(outcomes[0].status, "deferred");
  assert.match(outcomes[0].reason ?? "", /empty receipt/);
  assert.equal(outcomes[0].attempts, 2);
});

test("invalid amounts are rejected without calling the worker", async () => {
  const batch = new OrderedBatchMap();
  let called = false;
  const outcomes = await batch.collect([
    settlement("zero", "a", 0),
    settlement("negative", "b", -1),
    settlement("nan", "c", Number.NaN),
  ], async () => {
    called = true;
    return "impossible";
  }, 1);
  assert.equal(called, false);
  assert.ok(outcomes.every((entry) => entry.status === "rejected"));
  assert.deepEqual(outcomes.map((entry) => entry.attempts), [0, 0, 0]);
});

test("batch collection validates retry count", async () => {
  const batch = new OrderedBatchMap();
  await assert.rejects(batch.collect([], async () => "r", 0), RangeError);
  await assert.rejects(batch.collect([], async () => "r", 1.5), RangeError);
});

test("replay plan contains deferred entries in priority order", () => {
  const batch = new OrderedBatchMap();
  const intents = [
    settlement("low", "a", 10, USD, "2026-07-13", 1),
    settlement("done", "b", 10, USD, "2026-07-13", 100),
    settlement("high", "c", 10, USD, "2026-07-13", 90),
  ];
  const outcomes: readonly SettlementOutcome[] = [
    { identity: "low", ordinal: 0, status: "deferred", attempts: 2 },
    { identity: "done", ordinal: 1, status: "settled", receipt: "r", attempts: 1 },
    { identity: "high", ordinal: 2, status: "deferred", attempts: 2 },
  ];
  assert.deepEqual(batch.replayPlan(outcomes, intents).map((intent) => intent.identity), ["high", "low"]);
});

test("settlement waves isolate the same account", () => {
  const intents = [
    settlement("a1", "account-a", 10),
    settlement("a2", "account-a", 20),
    settlement("b1", "account-b", 30),
  ];
  const plan = constructSettlementWaves(intents, {}, {}, new Set());
  const positions = plan.waves.map((wave) => wave.map((intent) => intent.identity));
  assert.ok(positions.some((wave) => wave.includes("a1")));
  assert.ok(positions.some((wave) => wave.includes("a2")));
  assert.equal(positions.some((wave) => wave.includes("a1") && wave.includes("a2")), false);
});

test("blocked value dates are rejected before planning", () => {
  const blocked = settlement("blocked", "a", 10, USD, "2026-07-15");
  const open = settlement("open", "b", 10, USD, "2026-07-16");
  const plan = constructSettlementWaves([blocked, open], {}, {}, new Set(["2026-07-15"]));
  assert.equal(plan.rejected.get("blocked"), "blocked value date");
  assert.equal(plan.rejected.has("open"), false);
  assert.deepEqual(plan.waves.flat().map((intent) => intent.identity), ["open"]);
});

test("account and currency limits produce distinct rejection reasons", () => {
  const intents = [
    settlement("account-cap", "small", 110, USD),
    settlement("currency-cap", "large", 90, EUR),
  ];
  const plan = constructSettlementWaves(
    intents,
    { small: 100, large: 1_000 },
    { USD: 1_000, EUR: 80 },
    new Set(),
  );
  assert.equal(plan.rejected.get("account-cap"), "account capacity exceeded");
  assert.equal(plan.rejected.get("currency-cap"), "currency capacity exceeded");
});

test("critical accounts approach their configured cap", () => {
  const plan = constructSettlementWaves([
    settlement("near", "account-a", 850),
    settlement("far", "account-b", 100),
  ], { "account-a": 1_000, "account-b": 1_000 }, {}, new Set());
  assert.deepEqual(plan.criticalAccounts, ["account-a"]);
});

test("wave exposures equal the assigned settlement amounts", () => {
  const plan = constructSettlementWaves(settlementBook, {}, {}, new Set());
  for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex += 1) {
    const computed: Record<string, number> = {};
    for (const intent of plan.waves[waveIndex]) {
      computed[intent.currency] = (computed[intent.currency] ?? 0) + intent.amount;
    }
    assert.deepEqual(plan.exposureByWave[waveIndex] ?? {}, computed);
  }
});

test("retry wheel rounds schedules into quantum slots", () => {
  const wheel = new RetryWheel();
  wheel.schedule(retry("a", "acct-a", 1_199, 2), 100);
  wheel.schedule(retry("b", "acct-b", 1_201, 3), 100);
  const forecast = wheel.forecast(1_000);
  assert.equal(forecast[0].dueInMs, 100);
  assert.equal(forecast[1].dueInMs, 200);
  assert.equal(forecast.reduce((sum, row) => sum + row.count, 0), 2);
});

test("retry wheel replaces an identity with a stronger attempt", () => {
  const wheel = new RetryWheel();
  assert.equal(wheel.schedule(retry("same", "a", 1_000, 2, 1), 100), true);
  assert.equal(wheel.schedule(retry("same", "a", 1_100, 2, 1), 100), false);
  assert.equal(wheel.schedule(retry("same", "a", 900, 2, 2), 100), true);
  assert.equal(wheel.forecast(0).reduce((sum, row) => sum + row.count, 0), 1);
});

test("retry wheel leaves future work scheduled", () => {
  const wheel = new RetryWheel();
  wheel.schedule(retry("due", "a", 1_000, 2), 100);
  wheel.schedule(retry("future", "b", 2_000, 2), 100);
  assert.deepEqual(wheel.takeDue(1_100, 10).map((ticket) => ticket.identity), ["due"]);
  assert.deepEqual(wheel.forecast(1_100).map((row) => row.dueInMs), [900]);
});

test("retry wheel respects the overall budget", () => {
  const wheel = new RetryWheel();
  wheel.schedule(retry("a", "one", 1_000, 4), 100);
  wheel.schedule(retry("b", "two", 1_000, 4), 100);
  wheel.schedule(retry("c", "three", 1_000, 4), 100);
  const selected = wheel.takeDue(1_000, 8);
  assert.ok(selected.reduce((sum, ticket) => sum + ticket.cost, 0) <= 8);
  assert.equal(selected.length, 2);
  assert.equal(wheel.forecast(1_000).reduce((sum, row) => sum + row.count, 0), 1);
});

test("retry wheel validates schedule and budget inputs", () => {
  const wheel = new RetryWheel();
  assert.throws(() => wheel.schedule(retry("a", "a", 1, 1), 0), /quantum/);
  assert.throws(() => wheel.schedule(retry("a", "a", -1, 1), 10), /due time/);
  assert.throws(() => wheel.schedule(retry("a", "a", 1, 1, 0), 10), /attempt/);
  assert.throws(() => wheel.takeDue(1, -1), /budget/);
});

test("retry optimization selects value within account quotas", () => {
  const tickets = [
    retry("a1", "a", 900, 4, 4, 1_100),
    retry("a2", "a", 900, 4, 1, 2_000),
    retry("b1", "b", 900, 4, 3, 1_200),
    retry("c1", "c", 900, 4, 2, 1_500),
  ];
  const plan = optimizeRetryBudget(tickets, 12, { a: 0.5, b: 0.5, c: 0.5 }, 1_000);
  assert.ok(plan.spent <= 12);
  assert.ok((plan.accountAllocation.get("a")?.spent ?? 0) <= 6);
  assert.ok(plan.selected.some((ticket) => ticket.identity === "a1"));
  assert.equal(plan.selected.length + plan.deferred.length, tickets.length);
});

test("retry optimization records invalid and duplicate tickets", () => {
  const plan = optimizeRetryBudget([
    retry("", "a", 1, 1),
    retry("dup", "a", 1, 1),
    retry("dup", "a", 2, 1),
    retry("negative", "a", 1, -1),
    retry("deadline", "a", 100, 1, 1, 50),
  ], 10, {}, 0);
  assert.equal(plan.rejected.get(""), "identity is empty");
  assert.equal(plan.rejected.get("dup"), "duplicate retry identity");
  assert.equal(plan.rejected.get("negative"), "cost must be positive");
  assert.equal(plan.rejected.get("deadline"), "deadline precedes due time");
});

test("dispatch order serializes tickets within an account", () => {
  const plan = optimizeRetryBudget([
    retry("first", "same", 1_000, 2, 2, 1_100),
    retry("second", "same", 1_000, 3, 1, 1_200),
  ], 10, { same: 1 }, 1_000);
  assert.equal(plan.dispatchOrder.length, 2);
  assert.ok(plan.dispatchOrder[1].startAt >= plan.dispatchOrder[0].finishAt);
  assert.equal(plan.dispatchOrder[0].identity, "first");
});

test("retry optimization reports expired work", () => {
  const plan = optimizeRetryBudget([
    retry("expired", "a", 100, 2, 3, 200),
    retry("live", "b", 100, 2, 1, 2_000),
  ], 10, {}, 1_000);
  assert.deepEqual(plan.expired, ["expired"]);
  assert.ok(plan.value > 0);
});
