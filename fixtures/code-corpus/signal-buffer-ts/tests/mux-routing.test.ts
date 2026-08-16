/**
 * ExpiringRequestMux、modelCachePressure、HealthAwareChannel 与
 * simulateCircuitTimeline 的单元测试:覆盖请求合并、TTL/超时/陈旧降级、
 * 缓存压力建模与熔断通道选择/时间线。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ExpiringRequestMux,
  HealthAwareChannel,
  modelCachePressure,
  simulateCircuitTimeline,
} from "../src/index.js";

test("request mux collapses concurrent work for the same key", async () => {
  // 三个并发请求同一键:仅一次 loader 调用,其余作为共享等待者。
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mux = new ExpiringRequestMux<string, string>(5_000, 500, 20_000, () => 1_000);
  const loader = async () => {
    calls += 1;
    await gate;
    return "quoted";
  };
  const first = mux.load("USD/EUR", loader);
  const second = mux.load("USD/EUR", loader);
  const third = mux.load("USD/EUR", loader);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(mux.snapshot().inFlight, 1);
  assert.equal(mux.snapshot().sharedWaiters, 2);
  release?.();
  assert.deepEqual(await Promise.all([first, second, third]), ["quoted", "quoted", "quoted"]);
});

test("request mux does not collapse unrelated keys", async () => {
  const calls: string[] = [];
  const mux = new ExpiringRequestMux<string, string>(5_000, 500, 20_000);
  const result = await Promise.all([
    mux.load("USD/EUR", async () => { calls.push("USD/EUR"); return "a"; }),
    mux.load("GBP/USD", async () => { calls.push("GBP/USD"); return "b"; }),
    mux.load("USD/JPY", async () => { calls.push("USD/JPY"); return "c"; }),
  ]);
  assert.deepEqual(result, ["a", "b", "c"]);
  assert.deepEqual(calls.sort(), ["GBP/USD", "USD/EUR", "USD/JPY"]);
  assert.equal(mux.snapshot().misses, 3);
});

test("fresh cache values avoid the loader", async () => {
  let now = 10_000;
  let calls = 0;
  const mux = new ExpiringRequestMux<string, number>(5_000, 100, 30_000, () => now);
  assert.equal(await mux.load("key", async () => ++calls), 1);
  now += 4_999;
  assert.equal(await mux.load("key", async () => ++calls), 1);
  assert.equal(calls, 1);
  assert.equal(mux.snapshot().freshHits, 1);
});

test("expiration refreshes a key", async () => {
  let now = 1_000;
  let version = 40;
  const mux = new ExpiringRequestMux<string, number>(5_000, 100, 30_000, () => now);
  assert.equal(await mux.load("key", async () => ++version), 41);
  now += 5_000;
  assert.equal(await mux.load("key", async () => ++version), 42);
  assert.equal(mux.snapshot().misses, 2);
});

test("provider failure falls back to retained stale data", async () => {
  // 提供方失败时,未超龄的陈旧值作为降级结果返回(避免下游空等)。
  let now = 2_000;
  const mux = new ExpiringRequestMux<string, string>(5_000, 100, 20_000, () => now);
  await mux.load("key", async () => "stable");
  now += 7_500;
  const recovered = await mux.load("key", async () => { throw new Error("provider offline"); });
  assert.equal(recovered, "stable");
  assert.equal(mux.snapshot().staleRecoveries, 1);
});

test("stale data outside retention is not returned", async () => {
  let now = 2_000;
  const mux = new ExpiringRequestMux<string, string>(5_000, 100, 20_000, () => now);
  await mux.load("key", async () => "old");
  now += 20_001;
  await assert.rejects(
    mux.load("key", async () => { throw new Error("still offline"); }),
    /still offline/,
  );
  assert.equal(mux.snapshot().staleRecoveries, 0);
});

test("timeout aborts provider work and rejects without stale data", async () => {
  let aborted = false;
  const mux = new ExpiringRequestMux<string, string>(5_000, 15, 20_000);
  const pending = mux.load("slow", (signal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(signal.reason);
    });
  }));
  await assert.rejects(pending, /exceeded 15ms/);
  assert.equal(aborted, true);
  assert.equal(mux.snapshot().timeouts, 1);
  assert.equal(mux.snapshot().inFlight, 0);
});

test("eviction respects last read time and maximum count", async () => {
  let now = 100;
  const mux = new ExpiringRequestMux<string, number>(50, 100, 500, () => now);
  await mux.load("a", async () => 1);
  now += 10;
  await mux.load("b", async () => 2);
  now += 10;
  await mux.load("c", async () => 3);
  assert.deepEqual(mux.evictBefore(115, 1), ["a"]);
  assert.equal(mux.snapshot().liveValues, 2);
  assert.deepEqual([...mux.evictBefore(1_000, 10)].sort(), ["b", "c"]);
});

test("request mux validates time policies", () => {
  assert.throws(() => new ExpiringRequestMux(0, 10, 20), /ttlMs/);
  assert.throws(() => new ExpiringRequestMux(10, 0, 20), /timeoutMs/);
  assert.throws(() => new ExpiringRequestMux(10, 10, 9), /stale retention/);
});

test("cache pressure identifies access-heavy keys", () => {
  const events = [
    { key: "hot", at: 1, kind: "miss" as const },
    { key: "hot", at: 2, kind: "load" as const, latencyMs: 20 },
    { key: "cold", at: 3, kind: "miss" as const },
    { key: "hot", at: 4, kind: "hit" as const },
    { key: "hot", at: 5, kind: "hit" as const },
    { key: "cold", at: 6, kind: "load" as const, latencyMs: 50 },
    { key: "hot", at: 7, kind: "hit" as const },
  ];
  const model = modelCachePressure(events, 100, 2);
  assert.equal(model.hotKeys[0], "hot");
  assert.ok(model.intervals.length >= 1);
  assert.ok(model.suggestedTtlMs >= 100);
});

test("cache pressure reports a request stampede", () => {
  // 同一键在加载未完成期间出现 ≥3 个并发 miss,判定为惊群。
  const model = modelCachePressure([
    { key: "pair", at: 10, kind: "load" },
    { key: "pair", at: 11, kind: "miss" },
    { key: "pair", at: 12, kind: "miss" },
    { key: "pair", at: 13, kind: "miss" },
    { key: "pair", at: 20, kind: "error" },
  ], 1_000, 4);
  assert.deepEqual(model.stampedes, [{ key: "pair", startedAt: 10, requests: 4 }]);
  assert.equal(model.hotKeys[0], "pair");
});

test("cache pressure validates policy dimensions", () => {
  assert.throws(() => modelCachePressure([], 0, 1), RangeError);
  assert.throws(() => modelCachePressure([], 1_000, 0), RangeError);
});

test("channel selection prefers a healthy primary", () => {
  const router = new HealthAwareChannel();
  assert.equal(router.choose(["primary", "backup"], 1_000, 2, 500), "primary");
  assert.equal(router.describe("primary", 2, 1_000, 500).state, "closed");
});

test("channel failures are isolated per provider", () => {
  const router = new HealthAwareChannel();
  router.recordFailure("primary", 1_000, 2);
  router.recordFailure("primary", 1_010, 2);
  assert.equal(router.describe("primary", 2, 1_011, 500).state, "open");
  assert.equal(router.describe("backup", 2, 1_011, 500).state, "closed");
  assert.equal(router.choose(["primary", "backup"], 1_020, 2, 500), "backup");
});

test("an open provider becomes eligible for one half-open probe", () => {
  const router = new HealthAwareChannel();
  // 冷却期过后只放行一个探测请求,探测在途期间通道仍不可选。
  router.recordFailure("primary", 1_000, 1);
  assert.equal(router.choose(["primary"], 1_100, 1, 500), undefined);
  assert.equal(router.choose(["primary"], 1_500, 1, 500), "primary");
  assert.equal(router.choose(["primary"], 1_501, 1, 500), undefined);
  assert.equal(router.describe("primary", 1, 1_501, 500).probeInFlight, true);
});

test("channel selection rejects invalid thresholds", () => {
  const router = new HealthAwareChannel();
  assert.throws(() => router.choose(["a"], 1, 0, 100), /failure limit/);
  assert.throws(() => router.choose(["a"], 1, 1, 0), /cooldown/);
});

test("circuit timeline opens after consecutive failures", () => {
  // 连续失败达阈值即熔断,熔断通道的得分低于健康通道。
  const timeline = simulateCircuitTimeline(["alpha", "beta"], [
    { at: 100, channel: "alpha", outcome: "failure" },
    { at: 110, channel: "beta", outcome: "success", latencyMs: 30 },
    { at: 120, channel: "alpha", outcome: "failure" },
  ], 2, 500);
  const finalAlpha = timeline.filter((entry) => entry.channel === "alpha").at(-1)!;
  const finalBeta = timeline.filter((entry) => entry.channel === "beta").at(-1)!;
  assert.equal(finalAlpha.state, "open");
  assert.equal(finalBeta.state, "closed");
  assert.ok(finalAlpha.score < finalBeta.score);
});

test("circuit timeline recovers only after cooldown", () => {
  const timeline = simulateCircuitTimeline(["alpha"], [
    { at: 100, channel: "alpha", outcome: "failure" },
    { at: 200, channel: "alpha", outcome: "success", latencyMs: 50 },
    { at: 700, channel: "alpha", outcome: "probe" },
    { at: 710, channel: "alpha", outcome: "success", latencyMs: 20 },
  ], 1, 500);
  assert.equal(timeline.some((entry) => entry.at === 200 && entry.state === "closed"), true);
  assert.equal(timeline.at(-1)?.state, "closed");
});

test("timeline ignores telemetry for unknown channels", () => {
  const timeline = simulateCircuitTimeline(["known"], [
    { at: 10, channel: "unknown", outcome: "failure" },
    { at: 20, channel: "known", outcome: "success", latencyMs: 5 },
  ], 2, 100);
  assert.equal(timeline.some((entry) => entry.channel === "unknown"), false);
  assert.equal(timeline.filter((entry) => entry.channel === "known").length, 1);
});
