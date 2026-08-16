/**
 * CoalescingWindow 的单元测试:TTL 新鲜度、并发合并、陈旧降级、超时、
 * 修剪与诊断排序。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CoalescingWindow } from "../src/coalescing-window.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
};

test("fresh values are served until the five second deadline", async () => {
  // TTL 边界:4999ms 内命中缓存,恰在 5000ms 处触发重新加载。
  let now = 1_000;
  let calls = 0;
  const cache = new CoalescingWindow<string, number>(5_000, () => now, 100);
  const loader = async () => {
    calls += 1;
    return calls * 10;
  };

  assert.equal(await cache.resolve("EUR/USD", loader), 10);
  now = 5_999;
  assert.equal(await cache.resolve("EUR/USD", loader), 10);
  assert.equal(calls, 1);

  now = 6_000;
  assert.equal(await cache.resolve("EUR/USD", loader), 20);
  assert.equal(calls, 2);
});

test("a burst for one key shares the exact provider promise", async () => {
  const gate = deferred<number>();
  let calls = 0;
  const cache = new CoalescingWindow<string, number>(5_000, Date.now, 200);
  const loader = () => {
    calls += 1;
    return gate.promise;
  };

  const first = cache.resolve("GBP/JPY", loader);
  const second = cache.resolve("GBP/JPY", loader);
  const third = cache.resolve("GBP/JPY", loader);
  assert.equal(calls, 1);
  assert.equal(cache.diagnostics()[0]?.state, "loading");

  gate.resolve(191);
  assert.deepEqual(await Promise.all([first, second, third]), [191, 191, 191]);
  assert.equal(cache.diagnostics()[0]?.loadAttempts, 1);
});

test("different currency pairs may load in parallel", async () => {
  const euro = deferred<string>();
  const pound = deferred<string>();
  const started: string[] = [];
  const cache = new CoalescingWindow<string, string>(5_000, Date.now, 200);

  const first = cache.resolve("EUR/CHF", () => {
    started.push("EUR/CHF");
    return euro.promise;
  });
  const second = cache.resolve("GBP/CHF", () => {
    started.push("GBP/CHF");
    return pound.promise;
  });
  assert.deepEqual(started.sort(), ["EUR/CHF", "GBP/CHF"]);

  pound.resolve("pound");
  euro.resolve("euro");
  assert.deepEqual(await Promise.all([first, second]), ["euro", "pound"]);
});

test("an expired value is retained when replacement fails", async () => {
  // 替换加载失败时返回陈旧值,并标记为不新鲜。
  let now = 10;
  const cache = new CoalescingWindow<string, number>(5, () => now, 50);
  assert.equal(await cache.resolve("EUR/USD", async () => 11), 11);
  now = 20;

  const fallback = await cache.resolve("EUR/USD", async () => {
    throw new Error("provider offline");
  });
  assert.equal(fallback, 11);
  assert.equal(cache.peek("EUR/USD")?.fresh, false);
  assert.equal(cache.peek("EUR/USD")?.staleForMs, 5);
  assert.equal(cache.diagnostics()[0]?.loadFailures, 1);
});

test("a provider exception is preserved when no stale value exists", async () => {
  const cache = new CoalescingWindow<string, number>();
  const failure = new Error("permission denied");
  await assert.rejects(
    cache.resolve("USD/CAD", async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(cache.diagnostics(), []);
});

test("provider timeouts use stale data and release the flight", async () => {
  let now = 100;
  let calls = 0;
  const cache = new CoalescingWindow<string, string>(1, () => now, 10);
  await cache.resolve("AUD/NZD", async () => "old");
  now = 200;

  assert.equal(
    await cache.resolve("AUD/NZD", () => new Promise(() => undefined)),
    "old",
  );
  assert.equal(cache.diagnostics()[0]?.state, "stale");
  assert.equal(
    await cache.resolve("AUD/NZD", async () => {
      calls += 1;
      return "new";
    }),
    "new",
  );
  assert.equal(calls, 1);
});

test("provider timeout rejects if the cache has never succeeded", async () => {
  const cache = new CoalescingWindow<string, string>(5_000, Date.now, 8);
  await assert.rejects(
    cache.resolve("NOK/SEK", () => new Promise(() => undefined)),
    /provider timeout/u,
  );
});

test("prune removes only entries beyond the stale retention window", async () => {
  // 超过保留窗口的过期条目被修剪,新鲜条目不受影响。
  let now = 0;
  const cache = new CoalescingWindow<string, number>(10, () => now, 100);
  await cache.resolve("A", async () => 1);
  now = 5;
  await cache.resolve("B", async () => 2);
  now = 25;

  assert.deepEqual(cache.prune(9), ["A", "B"]);
  assert.equal(cache.peek("A"), undefined);
  assert.equal(cache.peek("B"), undefined);
  assert.deepEqual(cache.diagnostics(), []);
});

test("prune validates its retention duration", () => {
  const cache = new CoalescingWindow<string, number>();
  assert.throws(() => cache.prune(-1), /maximumStaleMs/u);
  assert.throws(() => cache.prune(Number.NaN), /maximumStaleMs/u);
});

test("diagnostics order loading, stale, then fresh entries", async () => {
  // 诊断排序:loading 优先,其次 stale,最后 fresh。
  let now = 0;
  const cache = new CoalescingWindow<string, number>(10, () => now, 100);
  await cache.resolve("stale", async () => 1);
  now = 20;
  await cache.resolve("fresh", async () => 2);
  const gate = deferred<number>();
  const loading = cache.resolve("loading", () => gate.promise);

  assert.deepEqual(
    cache.diagnostics().map((entry) => entry.state),
    ["loading", "stale", "fresh"],
  );
  gate.resolve(3);
  await loading;
});

test("cache behavior is invariant across representative TTL values", async () => {
  for (const ttl of [0, 1, 2, 17, 999, 5_000]) {
    let now = 50_000;
    let sequence = 0;
    const cache = new CoalescingWindow<string, number>(ttl, () => now, 100);
    const load = async () => {
      sequence += 1;
      return sequence;
    };

    const initial = await cache.resolve("pair", load);
    assert.equal(initial, 1, `initial value for ttl=${ttl}`);
    if (ttl > 0) {
      now += ttl - 1;
      assert.equal(await cache.resolve("pair", load), 1);
    }
    now += Math.max(1, ttl);
    assert.equal(await cache.resolve("pair", load), 2);
  }
});

test("invalid cache configuration fails immediately", () => {
  assert.throws(() => new CoalescingWindow(5_000, Date.now, 0), /timeoutMs/u);
  assert.throws(() => new CoalescingWindow(-1), /ttlMs/u);
  assert.throws(() => new CoalescingWindow(5_000, () => Number.NaN), /clock/u);
});
