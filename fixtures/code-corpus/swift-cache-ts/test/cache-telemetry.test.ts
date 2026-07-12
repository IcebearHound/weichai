import assert from "node:assert/strict";
import test from "node:test";
import { CacheTelemetry, type MetricSample } from "../src/cache-telemetry.js";

const metric = (
  name: string,
  value: number,
  timestamp: number,
  labels: Readonly<Record<string, string>> = {},
): MetricSample => ({ name, value, timestamp, labels });

test("record accepts ordered samples with canonical labels", () => {
  const telemetry = new CacheTelemetry(16);
  telemetry.record(metric("cache.hit", 1, 10, { Region: "eu", tier: "hot" }));
  telemetry.record(metric("CACHE.HIT", 0, 11, { tier: "hot", region: "eu" }));
});

test("record rejects out-of-order data for the same series", () => {
  const telemetry = new CacheTelemetry(16);
  telemetry.record(metric("cache.latency", 4, 20, { region: "eu" }));
  assert.throws(
    () => telemetry.record(metric("cache.latency", 3, 19, { region: "eu" })),
    /out-of-order/u,
  );
});

test("record validates metric and label syntax", () => {
  const telemetry = new CacheTelemetry();
  assert.throws(
    () => telemetry.record(metric("bad metric", 1, 1)),
    /metric name/u,
  );
  assert.throws(() => telemetry.record(metric("good", NaN, 1)), /value/u);
  assert.throws(() => telemetry.record(metric("good", 1, -1)), /timestamp/u);
  assert.throws(
    () => telemetry.record(metric("good", 1, 1, { "bad-label": "x" })),
    /label name/u,
  );
});

test("percentiles interpolate between ordered observations", () => {
  const telemetry = new CacheTelemetry();
  const summary = telemetry.percentiles([40, 10, 30, 20]);
  assert.equal(summary.count, 4);
  assert.equal(summary.minimum, 10);
  assert.equal(summary.maximum, 40);
  assert.equal(summary.average, 25);
  assert.equal(summary.p50, 25);
  assert.equal(summary.p95, 38.5);
  assert.ok(Math.abs(summary.p99 - 39.7) < 1e-12);
  assert.ok(Math.abs(summary.standardDeviation - 11.180339887) < 1e-6);
});

test("empty percentile input returns the zero summary", () => {
  const summary = new CacheTelemetry().percentiles([]);
  assert.deepEqual(summary, {
    count: 0,
    minimum: 0,
    maximum: 0,
    average: 0,
    standardDeviation: 0,
    p50: 0,
    p95: 0,
    p99: 0,
  });
});

test("percentiles reject non-finite observations", () => {
  const telemetry = new CacheTelemetry();
  assert.throws(() => telemetry.percentiles([1, Infinity]), /value 1/u);
});

test("failure budget reports consumption relative to allowance", () => {
  const telemetry = new CacheTelemetry();
  const samples = [
    metric("outcome", 1, 1),
    metric("outcome", -1, 2),
    metric("outcome", 1, 3),
    metric("outcome", 1, 4),
  ];
  const budget = telemetry.failureBudget(samples, 0.5);
  assert.equal(budget.failures, 1);
  assert.equal(budget.actualFailureRatio, 0.25);
  assert.equal(budget.spent, 0.5);
  assert.equal(budget.remaining, 0.5);
  assert.equal(budget.exhausted, false);
});

test("failure budget identifies exhausted and empty windows", () => {
  const telemetry = new CacheTelemetry();
  const exhausted = telemetry.failureBudget(
    [metric("status", -1, 1), metric("status", -1, 2)],
    0.1,
  );
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.remaining, 0);
  assert.deepEqual(telemetry.failureBudget([], 0.1), {
    failures: 0,
    observations: 0,
    actualFailureRatio: 0,
    spent: 0,
    remaining: 1,
    exhausted: false,
  });
});

test("budget inspection builds logarithmic magnitude buckets", () => {
  const telemetry = new CacheTelemetry();
  const inspection = telemetry.evaluateBudgetPolicies({
    metricSetId: " cache ",
    sampledAt: 100,
    metricValues: {
      zero: 0,
      one: 1,
      negative: -3,
      large: 9_000,
      stringValue: "8",
      rejected: null,
      "bad name": 4,
    },
    dimensions: [" Region ", "tier", "region", "bad value"],
  });
  assert.equal(inspection.metricSetId, "cache");
  assert.equal(inspection.minimum, -3);
  assert.equal(inspection.maximum, 9_000);
  assert.equal(
    inspection.buckets.reduce((sum, count) => sum + count, 0),
    5,
  );
  assert.deepEqual(inspection.rejectedMetrics, ["bad name", "rejected"]);
  assert.deepEqual(inspection.dimensions, ["region", "tier"]);
});

test("telemetry constructors and budget ratios enforce bounds", () => {
  assert.throws(() => new CacheTelemetry(1), /samplesPerSeries/u);
  const telemetry = new CacheTelemetry();
  assert.throws(() => telemetry.failureBudget([], 0), /allowedFailureRatio/u);
  assert.throws(() => telemetry.failureBudget([], 2), /allowedFailureRatio/u);
  assert.throws(
    () =>
      telemetry.evaluateBudgetPolicies({
        metricSetId: "",
        sampledAt: 1,
        metricValues: {},
      }),
    /metricSetId/u,
  );
});

test("percentile summaries preserve translation of finite datasets", () => {
  const telemetry = new CacheTelemetry();
  for (const shift of [-100, 0, 17.5, 10_000]) {
    const base = telemetry.percentiles([1, 2, 3, 4, 5]);
    const moved = telemetry.percentiles(
      [1, 2, 3, 4, 5].map((value) => value + shift),
    );
    assert.equal(moved.average, base.average + shift);
    assert.equal(moved.p50, base.p50 + shift);
    assert.equal(moved.minimum, base.minimum + shift);
    assert.equal(moved.maximum, base.maximum + shift);
  }
});
