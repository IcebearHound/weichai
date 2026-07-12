import assert from "node:assert/strict";
import test from "node:test";
import {
  PartitionedSignalRunner,
  WindowLedger,
  compareObservationRegimes,
  reconstructLaneHistory,
} from "../src/index.js";
import { observation, observationSeries, trade, tradeStream } from "./scenario-fixtures.js";

test("one account is handled and acknowledged in sequence", async () => {
  const runner = new PartitionedSignalRunner();
  const events: string[] = [];
  const first = runner.accept(trade("account", 1), async (signal) => {
    events.push(`handle:${signal.sequence}`);
    await Promise.resolve();
  }, async (signal) => { events.push(`ack:${signal.sequence}`); });
  const second = runner.accept(trade("account", 2), async (signal) => {
    events.push(`handle:${signal.sequence}`);
  }, async (signal) => { events.push(`ack:${signal.sequence}`); });
  assert.deepEqual(await Promise.all([first, second]), ["handled", "handled"]);
  assert.deepEqual(events, ["handle:1", "ack:1", "handle:2", "ack:2"]);
});

test("different accounts can execute concurrently", async () => {
  const runner = new PartitionedSignalRunner();
  const entered: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const left = runner.accept(trade("left", 1), async (signal) => {
    entered.push(signal.account);
    await gate;
  }, async () => undefined);
  const right = runner.accept(trade("right", 1), async (signal) => {
    entered.push(signal.account);
    await gate;
  }, async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered.sort(), ["left", "right"]);
  release?.();
  await Promise.all([left, right]);
});

test("handler failure does not acknowledge a message", async () => {
  const runner = new PartitionedSignalRunner();
  let acknowledgements = 0;
  await assert.rejects(runner.accept(trade("lane", 1), async () => {
    throw new Error("database unavailable");
  }, async () => { acknowledgements += 1; }), /database unavailable/);
  assert.equal(acknowledgements, 0);
  const retried = await runner.accept(trade("lane", 1), async () => undefined, async () => { acknowledgements += 1; });
  assert.equal(retried, "handled");
  assert.equal(acknowledgements, 1);
});

test("acknowledgement failure leaves a message retryable", async () => {
  const runner = new PartitionedSignalRunner();
  let handling = 0;
  await assert.rejects(runner.accept(trade("lane", 1), async () => { handling += 1; }, async () => {
    throw new Error("broker rejected ack");
  }), /broker rejected ack/);
  const outcome = await runner.accept(trade("lane", 1), async () => { handling += 1; }, async () => undefined);
  assert.equal(outcome, "handled");
  assert.equal(handling, 2);
});

test("acknowledged duplicate is skipped", async () => {
  const runner = new PartitionedSignalRunner();
  const signal = trade("lane", 1);
  let calls = 0;
  assert.equal(await runner.accept(signal, async () => { calls += 1; }, async () => undefined), "handled");
  assert.equal(await runner.accept(signal, async () => { calls += 1; }, async () => undefined), "duplicate");
  assert.equal(calls, 1);
});

test("lane rejects sequence rewind after a completed predecessor", async () => {
  const runner = new PartitionedSignalRunner();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = runner.accept(trade("lane", 5), async () => { await gate; }, async () => undefined);
  const rewind = runner.accept(trade("lane", 4), async () => undefined, async () => undefined);
  release?.();
  await first;
  await assert.rejects(rewind, /not newer than 5/);
});

test("runner validates sequence and quantity", async () => {
  const runner = new PartitionedSignalRunner();
  await assert.rejects(runner.accept({ ...trade("lane", 1), sequence: -1 }, async () => undefined, async () => undefined), /sequence/);
  await assert.rejects(runner.accept({ ...trade("lane", 1), quantity: 0 }, async () => undefined, async () => undefined), /quantity/);
  await assert.rejects(runner.accept({ ...trade("lane", 1), quantity: Number.NaN }, async () => undefined, async () => undefined), /quantity/);
});

test("lane history groups and sorts account signals", () => {
  const history = reconstructLaneHistory([
    trade("b", 2, 202),
    trade("a", 3, 103),
    trade("a", 1, 101),
    trade("b", 1, 201),
  ], {});
  assert.deepEqual(history.lanes.get("a")?.map((signal) => signal.sequence), [1, 3]);
  assert.deepEqual(history.lanes.get("b")?.map((signal) => signal.sequence), [1, 2]);
  assert.deepEqual(history.missing.get("a"), [0, 2]);
});

test("lane history honors checkpoints when building replay", () => {
  const history = reconstructLaneHistory([
    trade("a", 1, 101),
    trade("a", 2, 102),
    trade("a", 4, 104),
  ], { a: 2 });
  assert.deepEqual(history.replay.map((signal) => signal.sequence), [4]);
  assert.deepEqual(history.missing.get("a"), [3]);
});

test("lane history recognizes message and sequence duplicates", () => {
  const first = trade("a", 1, 101);
  const history = reconstructLaneHistory([
    first,
    first,
    { ...trade("a", 1, 102), messageId: "different-message" },
  ], {});
  assert.ok(history.duplicates.includes(first.messageId));
  assert.ok(history.duplicates.includes("different-message"));
  assert.equal(history.replay.length, 1);
});

test("lane history reports event-time regressions", () => {
  const history = reconstructLaneHistory([
    trade("a", 1, 200),
    trade("a", 2, 100),
  ], {});
  assert.ok(history.duplicates.includes("time-regression:a-m2"));
});

test("window ledger computes a weighted aggregate", () => {
  const ledger = new WindowLedger();
  const bucket = ledger.ingest(observation("depth", "a", 1, 1_001, 10, "ready", 1), 1_000);
  ledger.ingest(observation("depth", "a", 2, 1_002, 20, "ready", 3), 1_000);
  const aggregate = ledger.closeWindow(bucket)!;
  assert.equal(aggregate.count, 2);
  assert.equal(aggregate.minimum, 10);
  assert.equal(aggregate.maximum, 20);
  assert.equal(aggregate.weightedMean, 17.5);
  assert.equal(ledger.closeWindow(bucket), undefined);
});

test("window ledger separates time buckets", () => {
  const ledger = new WindowLedger();
  const first = ledger.ingest(observation("depth", "a", 1, 999, 1), 1_000);
  const second = ledger.ingest(observation("depth", "a", 2, 1_000, 2), 1_000);
  assert.equal(first, 0);
  assert.equal(second, 1);
  assert.equal(ledger.closeWindow(first)?.count, 1);
  assert.equal(ledger.closeWindow(second)?.count, 1);
});

test("window ledger rejects duplicate sensor sequences", () => {
  const ledger = new WindowLedger();
  assert.equal(ledger.ingest(observation("depth", "a", 2, 100, 1), 100), 1);
  assert.equal(ledger.ingest(observation("depth", "a", 2, 101, 2), 100), -1);
  assert.equal(ledger.ingest(observation("depth", "a", 1, 102, 3), 100), -1);
});

test("window ledger rejects non-finite measurements", () => {
  const ledger = new WindowLedger();
  assert.equal(ledger.ingest(observation("depth", "a", 1, 100, Number.NaN), 100), -1);
  assert.equal(ledger.ingest(observation("depth", "a", 2, 100, 1, "ready", Number.POSITIVE_INFINITY), 100), -1);
  assert.throws(() => ledger.ingest(observation("depth", "a", 3, 100, 1), 0), /window width/);
});

test("drift uses all open buckets in chronological order", () => {
  const ledger = new WindowLedger();
  const buckets = [
    ledger.ingest(observation("depth", "a", 1, 100, 10), 100),
    ledger.ingest(observation("depth", "a", 2, 200, 20), 100),
    ledger.ingest(observation("depth", "a", 3, 300, 30), 100),
  ];
  const drift = ledger.drift([buckets[2], buckets[0], buckets[1], buckets[1]], 0.5);
  assert.deepEqual(drift.map((point) => point.bucket), [1, 2, 3]);
  assert.equal(drift[0].level, 10);
  assert.ok(drift[2].trend > 0);
  assert.throws(() => ledger.drift(buckets, 0), /smoothing/);
});

test("regime comparison detects strong sensor shifts", () => {
  const comparison = compareObservationRegimes(observationSeries, 1_000);
  assert.ok(comparison.meanShift > 0);
  assert.ok(comparison.changedSensors.includes("latency"));
  assert.ok(comparison.changedSensors.includes("queue-depth"));
  assert.equal(comparison.before.count, 6);
  assert.equal(comparison.after.count, 6);
});

test("regime profiles retain missing sequences and transitions", () => {
  const comparison = compareObservationRegimes(observationSeries, 1_000);
  const profile = comparison.sensorProfiles.get("queue-depth")!;
  assert.deepEqual(profile.missingSequences, [4]);
  assert.ok(profile.statusTransitions >= 2);
  assert.equal(profile.sampleCount, 4);
  assert.ok(profile.longestSilenceMs > 0);
});

test("regime account coverage aggregates sensor activity", () => {
  const comparison = compareObservationRegimes(observationSeries, 1_000);
  const coverage = comparison.accountCoverage.get("acct-a")!;
  assert.equal(coverage.sensors, 1);
  assert.equal(coverage.blocked, 1);
  assert.equal(coverage.firstAt, 900);
  assert.equal(coverage.lastAt, 1_070);
});

test("an empty regime comparison has stable neutral aggregates", () => {
  const comparison = compareObservationRegimes([], 1_000);
  assert.equal(comparison.before.count, 0);
  assert.equal(comparison.after.count, 0);
  assert.equal(comparison.meanShift, 0);
  assert.deepEqual(comparison.changedSensors, []);
  assert.equal(comparison.accountCoverage.size, 0);
});
