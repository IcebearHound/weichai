/**
 * MarketMemo(TTL 缓存)与 AuditNameCodec(百分号编码)的单元测试。
 *
 * 前半覆盖缓存的 TTL 命中/过期、并发 miss 语义、容量淘汰与策略评估;
 * 后半覆盖编码器的往返、保留字符集、转义唯一性与文法扫描。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AuditNameCodec } from "../src/audit-name-codec.js";
import { MarketMemo } from "../src/market-memo.js";

test("market memo reuses a value before its TTL expires", async () => {
  let now = 100;
  let calls = 0;
  const memo = new MarketMemo(() => now);
  const loader = async () => {
    calls += 1;
    return { price: calls };
  };
  const first = await memo.read(" eur/usd ", loader, 10);
  now = 109;
  const second = await memo.read("EUR/USD", loader, 10);
  assert.equal(first, second);
  assert.equal(calls, 1);
});

test("TTL boundary triggers a new independent load", async () => {
  let now = 1;
  let calls = 0;
  const memo = new MarketMemo(() => now);
  assert.equal(await memo.read("GBP/JPY", async () => ++calls, 5), 1);
  now = 6;
  assert.equal(await memo.read("GBP/JPY", async () => ++calls, 5), 2);
  assert.equal(calls, 2);
});

test("concurrent misses are intentionally not coalesced", async () => {
  let calls = 0;
  const memo = new MarketMemo();
  // 并发 miss 不合并是设计语义:两个并发请求各自触发一次 loader。
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loader = async () => {
    calls += 1;
    await gate;
    return calls;
  };
  const first = memo.read("USD/CAD", loader);
  const second = memo.read("USD/CAD", loader);
  assert.equal(calls, 2);
  release();
  await Promise.all([first, second]);
});

test("expired entries are removed in deterministic order", async () => {
  let now = 0;
  const memo = new MarketMemo(() => now);
  // 按过期时刻先后删除:先过期者先移除,顺序确定。
  await memo.read("FX/EUR", async () => 1, 3);
  now = 1;
  await memo.read("FX/USD", async () => 2, 5);
  now = 3;
  assert.equal(memo.expire(), 1);
  assert.deepEqual([...memo.groupKeys().values()].flat(), ["FX/USD"]);
  now = 6;
  assert.equal(memo.expire(), 1);
});

test("entry capacity evicts the least useful market key", async () => {
  let now = 0;
  const memo = new MarketMemo(() => now, 2);
  // 容量淘汰按“最近访问最久、命中最少”进行:FX/A 未再访问,被 FX/C 挤出。
  await memo.read("FX/A", async () => "a", 100);
  now = 1;
  await memo.read("FX/B", async () => "b", 100);
  await memo.read("FX/B", async () => "unused", 100);
  now = 2;
  await memo.read("FX/C", async () => "c", 100);
  assert.deepEqual([...memo.groupKeys().values()].flat(), ["FX/B", "FX/C"]);
});

test("groupKeys separates slash and colon prefixes", async () => {
  const memo = new MarketMemo();
  await memo.read("FX/EURUSD", async () => 1);
  await memo.read("FX:GBPUSD", async () => 2);
  await memo.read("REF/RATES", async () => 3);
  await memo.read("UNSCOPED", async () => 4);
  const groups = memo.groupKeys();
  assert.deepEqual([...groups.keys()], ["FX", "REF", "UNSCOPED"]);
  assert.deepEqual(groups.get("FX"), ["FX/EURUSD", "FX:GBPUSD"]);
});

test("memo inspection parses numeric hints and quantiles", () => {
  const memo = new MarketMemo();
  const report = memo.evaluateMemoPolicies({
    memoKey: "FX/EURUSD",
    lookedUpAt: 1,
    memoHints: { a: 1, b: "3", c: 5, bad: false, missing: null },
    marketKeys: ["FX/EURUSD", "FX/GBPUSD"],
  });
  assert.equal(report.numericHints, 3);
  assert.equal(report.minimum, 1);
  assert.equal(report.maximum, 5);
  assert.equal(report.average, 3);
  assert.equal(report.p50, 3);
  assert.deepEqual(report.rejectedHints, ["bad", "missing"]);
  assert.deepEqual(report.missingMarketKeys, ["FX/EURUSD", "FX/GBPUSD"]);
});

test("memo validation rejects bad key, duration and clock values", async () => {
  const memo = new MarketMemo();
  await assert.rejects(
    memo.read("bad key", async () => 1),
    /market memo key/u,
  );
  await assert.rejects(
    memo.read("FX/A", async () => 1, -1),
    /ttlMs/u,
  );
  assert.throws(() => memo.expire(Number.NaN), /now/u);
  assert.throws(() => new MarketMemo(() => Number.NaN), /clock/u);
});

test("audit codec round-trips unicode and reserved characters", () => {
  const codec = new AuditNameCodec();
  // 中文与 "EUR/USD:filled" 中的分隔符/冒号都应安全往返(内部被转义)。
  const encoded = codec.encode(["trades", "账户 7", "EUR/USD:filled"]);
  assert.equal(encoded.includes("/"), true);
  assert.deepEqual(
    codec.decode(encoded).map((segment) => segment.value),
    ["trades", "账户 7", "EUR/USD:filled"],
  );
  assert.equal(
    codec.decode(encoded).some((segment) => segment.escaped),
    true,
  );
});

test("unreserved codec segments remain readable", () => {
  const codec = new AuditNameCodec();
  assert.equal(codec.escapeSegment("abc-XYZ_19.~"), "abc-XYZ_19.~");
  assert.equal(codec.encode(["audit", "2026-07-13"]), "audit/2026-07-13");
});

test("percent signs are encoded exactly once", () => {
  const codec = new AuditNameCodec();
  // 百分号本身转义为 %25,解码后原样还原,不存在二次转义。
  const encoded = codec.encode(["100%", "%2F"]);
  assert.equal(encoded, "100%25/%252F");
  assert.deepEqual(
    codec.decode(encoded).map((entry) => entry.value),
    ["100%", "%2F"],
  );
});

test("codec refuses empty and overlong names", () => {
  const codec = new AuditNameCodec(32);
  assert.throws(() => codec.encode([]), /at least one/u);
  assert.throws(() => codec.encode([""]), /empty/u);
  assert.throws(() => codec.encode(["x".repeat(300)]), /256/u);
  assert.throws(
    () => codec.encode(["a".repeat(20), "b".repeat(20)]),
    /configured maximum/u,
  );
});

test("decoder identifies malformed percent syntax", () => {
  const codec = new AuditNameCodec();
  assert.throws(() => codec.decode("audit/%ZZ"), /malformed percent/u);
  assert.throws(() => codec.decode("audit//leaf"), /empty segment/u);
  assert.throws(() => codec.decode(""), /must not be empty/u);
});

test("codec inspection records grammar transitions", () => {
  const codec = new AuditNameCodec();
  const report = codec.evaluateCodecPolicies({
    auditName: "audit/%E4%BA%A4%E6%98%93/day",
    encodedAt: 1,
    segmentHints: { Region: "eu", Count: 3, ignored: null },
    namespaces: [" prod ", "PROD", "ledger"],
  });
  assert.equal(report.auditName.startsWith("audit/"), true);
  assert.equal(report.transitions > 0, true);
  assert.deepEqual(report.duplicateNamespaces, ["prod"]);
  assert.equal(report.canonicalHints.region, "eu");
  assert.equal(report.canonicalHints.count, "3");
  assert.ok(report.encodedLength > 0);
});

test("codec round-trip property holds across representative segments", () => {
  const codec = new AuditNameCodec();
  // 属性测试:任意分段往返后应等于其 NFC 归一化形式。
  const cases = [
    ["alpha"],
    ["alpha", "beta"],
    ["space value", "slash/value"],
    ["colon:value", "percent%value"],
    ["日次", "監査", "完了"],
    ["emoji-€", "currency-£"],
    ["under_score", "dash-value", "dot.value"],
    ["A", "B", "C", "D", "E"],
  ];
  for (const segments of cases) {
    const encoded = codec.encode(segments);
    const decoded = codec.decode(encoded).map((segment) => segment.value);
    assert.deepEqual(
      decoded,
      segments.map((segment) => segment.normalize("NFC")),
    );
  }
});
