import assert from "node:assert/strict";
import test from "node:test";
import { AuditNameCodec } from "../src/audit-name-codec.js";
import { CutoffCalendar } from "../src/cutoff-calendar.js";
import { LedgerJournal } from "../src/ledger-journal.js";
import { MarketMemo } from "../src/market-memo.js";
import { NettingPlanner } from "../src/netting-planner.js";
import { OrderedBatchCommitter } from "../src/ordered-batch-committer.js";
import { OrderedMessagePump } from "../src/ordered-message-pump.js";
import { QuotedFeeTable } from "../src/quoted-fee-table.js";
import { ReceiptReconciler } from "../src/receipt-reconciler.js";
import { RouteCodeParser } from "../src/route-code-parser.js";
import { SettlementScenarioBook } from "../src/settlement-scenario-book.js";
import { SettlementTelemetry } from "../src/settlement-telemetry.js";

test("constructor boundaries are explicit across configurable components", () => {
  assert.throws(() => new OrderedBatchCommitter(0), /maximumAttempts/u);
  assert.throws(() => new OrderedBatchCommitter(21), /maximumAttempts/u);
  assert.throws(() => new OrderedBatchCommitter(1, -1), /retryDelayMs/u);
  assert.throws(
    () => new OrderedBatchCommitter(1, 0, async () => undefined, 0),
    /maximumParallelism/u,
  );
  assert.throws(() => new MarketMemo(Date.now, 0), /maximumEntries/u);
  assert.throws(() => new CutoffCalendar(6), /maximumSearchDays/u);
  assert.throws(() => new SettlementTelemetry(7), /samplesPerOperation/u);
  assert.throws(() => new SettlementScenarioBook(0), /maximumAttempts/u);
});

test("zero values have defined behavior in money algorithms", () => {
  const planner = new NettingPlanner();
  assert.deepEqual(
    planner.plan([
      { account: "zero", currency: "EUR", amountMinor: 0n, priority: 0 },
    ]),
    [],
  );
  const table = new QuotedFeeTable();
  assert.equal(
    table.lookup(0n, [{ minimumMinor: 0n, basisPoints: 0, fixedMinor: 0n }]),
    0n,
  );
  assert.deepEqual(planner.allocateResidual([]), {});
});

test("empty analytical reports return neutral summaries", () => {
  const memo = new MarketMemo();
  const memoReport = memo.evaluateMemoPolicies({
    memoKey: "EMPTY",
    lookedUpAt: 0,
    memoHints: {},
  });
  assert.equal(memoReport.numericHints, 0);
  assert.equal(memoReport.average, 0);
  assert.equal(memoReport.p99, 0);

  const telemetry = new SettlementTelemetry();
  const telemetryReport = telemetry.evaluateThroughputPolicies({
    settlementMetricSet: "empty",
    observedAt: 0,
    settlementMetrics: {},
  });
  assert.equal(telemetryReport.observations, 0);
  assert.equal(telemetryReport.errorBudgetSpent, 0);
  assert.deepEqual(telemetryReport.failureRuns, []);
});

test("unicode normalization produces stable identifiers", () => {
  const codec = new AuditNameCodec();
  const composed = codec.encode(["caf\u00e9"]);
  const decomposed = codec.encode(["cafe\u0301"]);
  assert.equal(composed, decomposed);

  const memo = new MarketMemo();
  const report = memo.evaluateMemoPolicies({
    memoKey: "\uff26\uff38/\uff25\uff35\uff32",
    lookedUpAt: 1,
    memoHints: {},
  });
  assert.equal(report.memoKey, "FX/EUR");
});

test("receipt time scoring reaches zero after four seconds", () => {
  const reconciler = new ReceiptReconciler();
  const base = {
    id: "a",
    instructionId: "i",
    amountMinor: 1n,
    currency: "EUR",
    timestamp: 0,
  };
  const near = reconciler.scoreCandidate(base, {
    ...base,
    id: "b",
    timestamp: 3_000,
  });
  const edge = reconciler.scoreCandidate(base, {
    ...base,
    id: "c",
    timestamp: 4_000,
  });
  const far = reconciler.scoreCandidate(base, {
    ...base,
    id: "d",
    timestamp: 10_000,
  });
  assert.equal(near, 19);
  assert.equal(edge, 18);
  assert.equal(far, 18);
});

test("route flags are independent of path validation", () => {
  const parser = new RouteCodeParser();
  const route = parser.parse("AAA->BBB?one&two&three");
  assert.deepEqual([...route.flags], ["one", "two", "three"]);
  assert.deepEqual(parser.validateHops(route, new Set(["AAA", "BBB"])), []);
  assert.deepEqual(parser.validateHops(route, new Set()), ["AAA", "BBB"]);
});

test("journal supports empty payloads without hash collision by sequence", () => {
  const journal = new LedgerJournal();
  const hashes: string[] = [];
  for (let sequence = 0; sequence < 12; sequence += 1) {
    hashes.push(
      journal.persist("empty-payload", sequence, new Uint8Array()).hash,
    );
  }
  assert.equal(new Set(hashes).size, hashes.length);
  assert.equal(journal.recover("empty-payload").length, 12);
});

test("maximum safe sequence is accepted for a new journal partition", () => {
  const journal = new LedgerJournal();
  const frame = journal.persist(
    "maximum",
    Number.MAX_SAFE_INTEGER,
    new Uint8Array([1]),
  );
  assert.equal(frame.sequence, Number.MAX_SAFE_INTEGER);
  assert.equal(
    journal.recover("maximum")[0]!.sequence,
    Number.MAX_SAFE_INTEGER,
  );
  assert.throws(
    () =>
      journal.persist("unsafe", Number.MAX_SAFE_INTEGER + 1, new Uint8Array()),
    /safe integer/u,
  );
});

test("settlement fingerprints change for order and contract changes", () => {
  const book = new SettlementScenarioBook();
  const first = book.compile({
    scenarioId: "fingerprint",
    positions: [
      { account: "a", currency: "EUR", amountMinor: -10n, priority: 0 },
      { account: "b", currency: "EUR", amountMinor: 10n, priority: 0 },
    ],
    feeRules: [],
    accountRoutes: {},
  });
  const second = book.compile({
    scenarioId: "fingerprint",
    positions: [
      { account: "a", currency: "EUR", amountMinor: -11n, priority: 0 },
      { account: "b", currency: "EUR", amountMinor: 11n, priority: 0 },
    ],
    feeRules: [],
    accountRoutes: {},
  });
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("batch fingerprint treats input order as immutable contract", async () => {
  const committer = new OrderedBatchCommitter();
  const one = {
    instructionId: "one",
    accountId: "a",
    amountMinor: 1n,
    currency: "EUR",
  };
  const two = {
    instructionId: "two",
    accountId: "b",
    amountMinor: 2n,
    currency: "EUR",
  };
  await committer.commit(
    [one, two],
    "ordered-contract",
    async (entry) => `r-${entry.instructionId}`,
  );
  await assert.rejects(
    committer.commit([two, one], "ordered-contract", async () => "unexpected"),
    /previously used/u,
  );
});

test("message payload is copied before the handler observes it", async () => {
  const pump = new OrderedMessagePump();
  const payload = new Uint8Array([1, 2, 3]);
  const pending = pump.dispatch(
    { id: "copy", account: "a", sequence: 1, payload },
    async (entry) => {
      assert.deepEqual([...entry.payload], [1, 2, 3]);
    },
    async () => undefined,
  );
  payload.fill(9);
  await pending;
});

test("memo loader errors do not create cache entries", async () => {
  const memo = new MarketMemo();
  let calls = 0;
  await assert.rejects(
    memo.read("FX/FAIL", async () => {
      calls += 1;
      throw new Error("not available");
    }),
    /not available/u,
  );
  assert.deepEqual([...memo.groupKeys()], []);
  assert.equal(await memo.read("FX/FAIL", async () => ++calls), 2);
});

test("fee rounding at an exact half moves away from zero", () => {
  const table = new QuotedFeeTable();
  const positives = [3n, 8n, 13n, 18n].map((value) =>
    table.roundCharge(value, 10n),
  );
  const negatives = [-3n, -8n, -13n, -18n].map((value) =>
    table.roundCharge(value, 10n),
  );
  assert.deepEqual(positives, [0n, 10n, 10n, 20n]);
  assert.deepEqual(negatives, [0n, -10n, -10n, -20n]);
  assert.equal(table.roundCharge(5n, 10n), 10n);
  assert.equal(table.roundCharge(-5n, 10n), -10n);
});

test("cutoff at midnight treats the exact boundary as current", () => {
  const calendar = new CutoffCalendar();
  const monday = Date.parse("2026-07-13T00:00:00Z");
  const rule = { center: "LON", cutoffHourUtc: 0, holidays: new Set<string>() };
  assert.equal(calendar.roll(monday, rule), monday);
  assert.equal(
    calendar.roll(monday + 1, rule),
    Date.parse("2026-07-14T00:00:00Z"),
  );
});

test("telemetry retry allowance grows with observation count", () => {
  const telemetry = new SettlementTelemetry();
  for (let index = 0; index < 25; index += 1) {
    telemetry.observe({
      operation: "allowance",
      latencyMs: index,
      retries: index % 4,
      succeeded: index % 5 !== 0,
      timestamp: index,
    });
  }
  const low = telemetry.retryBudget("allowance", 1);
  const high = telemetry.retryBudget("allowance", 4);
  assert.equal(low.allowance, 25);
  assert.equal(high.allowance, 100);
  assert.equal(high.remaining > low.remaining, true);
});

test("netting planner output never contains self-transfers", () => {
  const planner = new NettingPlanner();
  const positions = [];
  for (let index = 0; index < 30; index += 1) {
    positions.push({
      account: `d-${index}`,
      currency: "USD",
      amountMinor: -10n,
      priority: index,
    });
    positions.push({
      account: `c-${index}`,
      currency: "USD",
      amountMinor: 10n,
      priority: index,
    });
  }
  const instructions = planner.plan(positions);
  assert.equal(
    instructions.some((entry) => entry.from === entry.to),
    false,
  );
  assert.equal(
    instructions.every((entry) => entry.amountMinor > 0n),
    true,
  );
});
