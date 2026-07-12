import assert from "node:assert/strict";
import test from "node:test";
import { FailureGauge, type ProviderSample } from "../src/failure-gauge.js";

const sample = (
  provider: string,
  succeeded: boolean,
  latencyMs: number,
  observedAt: number,
): ProviderSample => ({ provider, succeeded, latencyMs, observedAt });

test("healthy low-latency providers rank ahead of failing ones", () => {
  const gauge = new FailureGauge(1_000);
  const ranks = gauge.rank([
    sample("steady", true, 20, 1),
    sample("steady", true, 30, 2),
    sample("steady", true, 25, 3),
    sample("fragile", false, 10, 1),
    sample("fragile", false, 15, 2),
    sample("fragile", true, 12, 3),
  ]);
  assert.deepEqual(
    ranks.map((rank) => rank.provider),
    ["steady", "fragile"],
  );
  assert.equal(ranks[0]!.successes, 3);
  assert.equal(ranks[1]!.consecutiveFailures, 0);
  assert.ok(ranks[0]!.reliability > ranks[1]!.reliability);
});

test("latency contributes to reliability after outcome smoothing", () => {
  const gauge = new FailureGauge(500);
  const ranks = gauge.rank([
    sample("fast", true, 10, 1),
    sample("slow", true, 5_000, 1),
  ]);
  assert.equal(ranks[0]!.provider, "fast");
  assert.ok(ranks[0]!.reliability > ranks[1]!.reliability);
});

test("long observation gaps decay old evidence", () => {
  const gauge = new FailureGauge();
  const ranks = gauge.rank(
    [
      sample("source", false, 100, 0),
      sample("source", false, 100, 1),
      sample("source", true, 50, 120_001),
    ],
    30_000,
  );
  assert.equal(ranks[0]!.failures, 0);
  assert.equal(ranks[0]!.successes, 1);
  assert.equal(ranks[0]!.consecutiveFailures, 0);
});

test("decay moves empty evidence toward an uninformative rank", () => {
  const gauge = new FailureGauge();
  const original = gauge.rank([
    sample("one", true, 20, 1),
    sample("one", false, 25, 2),
  ]);
  const decayed = gauge.decay(original, 1_000_000, 1_000);
  assert.equal(decayed[0]!.failures, 0);
  assert.equal(decayed[0]!.successes, 0);
  assert.equal(decayed[0]!.reliability, 0.5);
});

test("recordObservation groups aliases after normalization", () => {
  const gauge = new FailureGauge();
  const grouped = gauge.recordObservation([
    sample(" EDGE ", true, 10, 3),
    sample("edge", false, 20, 1),
    sample("backup", true, 30, 2),
  ]);
  assert.deepEqual([...grouped.keys()], ["edge", "backup"]);
  assert.deepEqual(
    grouped.get("edge")?.map((entry) => entry.observedAt),
    [1, 3],
  );
});

test("health inspection recognizes typed provider signals", () => {
  const gauge = new FailureGauge();
  const inspection = gauge.evaluateHealthPolicies({
    fleetId: " fx ",
    observedAt: 10_000,
    providerSignals: {
      "primary.latency": 20,
      "primary.ok": true,
      "backup.latency": 500,
      "backup.ok": false,
      malformed: 1,
      "backup.unknown": "x",
    },
    providerNames: ["primary", "backup", "tertiary"],
  });
  assert.equal(inspection.observations, 2);
  assert.deepEqual(inspection.providers, ["backup", "primary"]);
  assert.deepEqual(inspection.missingProviders, ["tertiary"]);
  assert.deepEqual(inspection.failureRuns, [1]);
  assert.equal(inspection.errorBudgetSpent, 0.5);
  assert.deepEqual(inspection.malformedSignals, [
    "backup.unknown",
    "malformed",
  ]);
});

test("failure runs preserve arrival order", () => {
  const gauge = new FailureGauge();
  const inspection = gauge.evaluateHealthPolicies({
    fleetId: "ordered",
    observedAt: 1,
    providerSignals: {
      "a.ok": false,
      "b.ok": false,
      "c.ok": true,
      "d.ok": false,
      "e.ok": true,
    },
  });
  assert.deepEqual(inspection.failureRuns, [2, 1]);
});

test("invalid samples fail with their source index", () => {
  const gauge = new FailureGauge();
  assert.throws(
    () => gauge.rank([sample("bad name!", true, 1, 1)]),
    /invalid provider/u,
  );
  assert.throws(() => gauge.rank([sample("valid", true, -1, 1)]), /sample 0/u);
  assert.throws(() => gauge.decay([], -1, 10), /elapsedMs/u);
  assert.throws(() => gauge.decay([], 1, 0), /halfLifeMs/u);
});

test("ranking is stable for equal provider evidence", () => {
  const gauge = new FailureGauge();
  const ranks = gauge.rank([
    sample("zeta", true, 100, 1),
    sample("alpha", true, 100, 1),
    sample("middle", true, 100, 1),
  ]);
  assert.deepEqual(
    ranks.map((rank) => rank.provider),
    ["alpha", "middle", "zeta"],
  );
});
