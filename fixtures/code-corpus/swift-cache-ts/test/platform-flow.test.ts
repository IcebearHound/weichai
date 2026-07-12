import assert from "node:assert/strict";
import test from "node:test";
import { BufferedAppender } from "../src/buffered-appender.js";
import { CacheTelemetry } from "../src/cache-telemetry.js";
import { CoalescingWindow } from "../src/coalescing-window.js";
import { CrossRateGraph } from "../src/cross-rate-graph.js";
import { FailureGauge } from "../src/failure-gauge.js";
import { QuoteJournal } from "../src/quote-journal.js";
import { QuoteValidator } from "../src/quote-validator.js";
import { SettlementDateTable } from "../src/settlement-date-table.js";
import { SpreadCurve } from "../src/spread-curve.js";
import { TradeEventLabel } from "../src/trade-event-label.js";

test("validated quote bursts are cached under the canonical pair", async () => {
  let observedAt = 1_000;
  const validator = new QuoteValidator();
  const cache = new CoalescingWindow<string, number>(
    5_000,
    () => observedAt,
    100,
  );
  const pair = validator.normalizePair("eur", "usd");
  let providerCalls = 0;
  const requestQuote = async () => {
    providerCalls += 1;
    const quote = {
      base: "EUR",
      counter: "USD",
      price: 1.0875,
      timestamp: observedAt,
      precision: 4,
    };
    assert.deepEqual(validator.validate(quote, observedAt), []);
    await Promise.resolve();
    return quote.price;
  };

  const prices = await Promise.all(
    Array.from({ length: 20 }, () => cache.resolve(pair, requestQuote)),
  );
  assert.equal(new Set(prices).size, 1);
  assert.equal(prices[0], 1.0875);
  assert.equal(providerCalls, 1);

  observedAt += 4_999;
  assert.equal(await cache.resolve(pair, requestQuote), 1.0875);
  assert.equal(providerCalls, 1);
});

test("a stale provider fallback can still be journaled exactly once", async () => {
  let now = 10;
  const cache = new CoalescingWindow<string, string>(1, () => now, 50);
  const journal = new QuoteJournal();
  await cache.resolve("GBP/USD", async () => "1.2650");
  now = 20;
  const price = await cache.resolve("GBP/USD", async () => {
    throw new Error("upstream unavailable");
  });

  const frame = journal.append(0, new TextEncoder().encode(price));
  const repeated = journal.append(0, new TextEncoder().encode(price));
  assert.deepEqual(repeated, frame);
  assert.equal(cache.diagnostics()[0]?.totalFailures, 1);
  assert.deepEqual(
    journal.recoverFrames([frame]).map((entry) => entry.sequence),
    [0],
  );
});

test("spread interpolation feeds a deterministic cross-rate route", () => {
  const curve = new SpreadCurve();
  const spreadBps = curve.interpolate(
    [
      { tenorDays: 1, spreadBps: 5, confidence: 1 },
      { tenorDays: 30, spreadBps: 20, confidence: 0.8 },
    ],
    7,
  );
  const proportionalCost = spreadBps / 10_000;
  const graph = new CrossRateGraph();
  const route = graph.findPath(
    [
      { from: "EUR", to: "USD", rate: 1.08, cost: proportionalCost },
      { from: "USD", to: "JPY", rate: 150, cost: proportionalCost },
      { from: "EUR", to: "JPY", rate: 160, cost: 0.02 },
    ],
    "EUR",
    "JPY",
  );

  assert.deepEqual(route?.currencies, ["EUR", "USD", "JPY"]);
  assert.ok((route?.effectiveRate ?? 0) > 160);
  assert.ok(proportionalCost > 0 && proportionalCost < 0.01);
});

test("settlement dates become stable human-readable event labels", () => {
  const dates = new SettlementDateTable();
  const labels = new TradeEventLabel();
  const friday = Date.parse("2026-07-10T00:00:00Z") / 86_400_000;
  const window = dates.rollWindow(friday, 3, []);
  assert.deepEqual(window, [friday, friday + 3, friday + 4]);

  const rendered = window.map((epochDay, sequence) =>
    labels.format({
      category: "settlement scheduled",
      account: "account-7",
      sequence,
      attributes: { epochDay: String(epochDay) },
    }),
  );
  assert.equal(rendered.length, 3);
  assert.equal(
    rendered.every((label) => label.startsWith("settlement-scheduled:")),
    true,
  );
  assert.equal(new Set(rendered).size, 3);
});

test("provider health and cache telemetry expose the same failure ratio", () => {
  const observations = [true, true, false, true, false];
  const gauge = new FailureGauge();
  const ranks = gauge.rank(
    observations.map((succeeded, index) => ({
      provider: "primary",
      succeeded,
      latencyMs: 10 + index,
      observedAt: index,
    })),
  );
  const telemetry = new CacheTelemetry();
  const budget = telemetry.failureBudget(
    observations.map((succeeded, index) => ({
      name: "provider.outcome",
      value: succeeded ? 1 : -1,
      timestamp: index,
      labels: { provider: "primary" },
    })),
    0.5,
  );

  assert.equal(ranks[0]!.sampleCount, observations.length);
  assert.equal(
    ranks[0]!.failures / ranks[0]!.sampleCount,
    budget.actualFailureRatio,
  );
  assert.equal(budget.spent, 0.8);
});

test("journal frames can be flushed in stable batches without duplicate writes", async () => {
  const journal = new QuoteJournal();
  const appender = new BufferedAppender();
  const frames = Array.from({ length: 7 }, (_, sequence) =>
    journal.append(sequence, new TextEncoder().encode(`quote-${sequence}`)),
  );
  const records = frames.map((frame) => ({
    id: `frame-${frame.sequence}`,
    timestamp: frame.sequence,
    fields: { checksum: frame.checksum, bytes: frame.payload.byteLength },
  }));
  const persisted: string[] = [];
  const first = await appender.flushNow(
    records,
    async (batch) => {
      persisted.push(...batch.map((record) => record.id));
    },
    3,
  );
  const second = await appender.flushNow(
    records,
    async (batch) => {
      persisted.push(...batch.map((record) => record.id));
    },
    3,
  );

  assert.equal(first.batches, 3);
  assert.deepEqual(first.batchRecordCounts, [3, 3, 1]);
  assert.equal(second.persisted, 0);
  assert.equal(second.skipped, 7);
  assert.equal(new Set(persisted).size, 7);
});
