/**
 * TradeEventLabel 的单元测试:标签生成(归一化/排序/编码)、token 化、
 * 规范化与命名空间策略评估。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TradeEventLabel } from "../src/trade-event-label.js";

test("format emits a stable normalized event label", () => {
  // 类别连字符化、账户大写、序号转 base36 补零、属性排序编码。
  const labels = new TradeEventLabel();
  const formatted = labels.format({
    category: " Trade Filled ",
    account: " acct-42 ",
    sequence: 35,
    attributes: { Venue: "LON 1", Side: "buy" },
  });
  assert.equal(
    formatted,
    "trade-filled:ACCT-42:0000000z?side=buy&venue=LON%201",
  );
});

test("attribute insertion order does not affect output", () => {
  const labels = new TradeEventLabel();
  const left = labels.format({
    category: "trade",
    account: "A1",
    sequence: 8,
    attributes: { z: "last", a: "first" },
  });
  const right = labels.format({
    category: "trade",
    account: "A1",
    sequence: 8,
    attributes: { a: "first", z: "last" },
  });
  assert.equal(left, right);
});

test("format rejects invalid identity and sequence data", () => {
  const labels = new TradeEventLabel();
  assert.throws(
    () =>
      labels.format({
        category: "***",
        account: "A",
        sequence: 1,
        attributes: {},
      }),
    /category/u,
  );
  assert.throws(
    () =>
      labels.format({
        category: "trade",
        account: "",
        sequence: 1,
        attributes: {},
      }),
    /account/u,
  );
  assert.throws(
    () =>
      labels.format({
        category: "trade",
        account: "A",
        sequence: -1,
        attributes: {},
      }),
    /sequence/u,
  );
});

test("normalization detects colliding attribute names", () => {
  const labels = new TradeEventLabel();
  assert.throws(
    () =>
      labels.format({
        category: "trade",
        account: "A1",
        sequence: 1,
        attributes: { Venue: "x", venue: "y" },
      }),
    /duplicate normalized attribute/u,
  );
});

test("tokenize decodes query values and honors quoted delimiters", () => {
  // 引号内的 “&” 不当作分隔符;百分号编码的 “LON 1” 被解码。
  const labels = new TradeEventLabel();
  assert.deepEqual(
    labels.tokenize('trade:ACCT:00000001?note="a&b"&venue=LON%201'),
    ["trade", "ACCT", "00000001", "note", "a&b", "venue", "LON 1"],
  );
});

test("tokenize reports malformed percent, quote and escape syntax", () => {
  const labels = new TradeEventLabel();
  assert.throws(() => labels.tokenize("trade:%zz"), /percent/u);
  assert.throws(() => labels.tokenize('trade:"open'), /unterminated/u);
  assert.throws(() => labels.tokenize("trade:value\\"), /incomplete escape/u);
});

test("canonicalize sorts attributes and lets the last duplicate win", () => {
  // 任意形式的标签归一化:属性按名排序,重复键取最后一个。
  const labels = new TradeEventLabel();
  assert.equal(
    labels.canonicalize(" Trade : acct-9 : a ?Z=1&a=2&z=3"),
    "trade:ACCT-9:0000000a?a=2&z=3",
  );
});

test("canonicalize validates the three path components", () => {
  const labels = new TradeEventLabel();
  assert.throws(() => labels.canonicalize("trade:acct"), /three/u);
  assert.throws(() => labels.canonicalize("trade:acct:not!base36"), /base36/u);
  assert.throws(() => labels.canonicalize(""), /must not be empty/u);
});

test("namespace inspection identifies invalid offsets and collisions", () => {
  // 非法字符记录偏移,重复组件单独列出,规范化组件取后值。
  const labels = new TradeEventLabel();
  const inspection = labels.evaluateNamespacePolicies({
    eventId: "evt 9",
    emittedAt: 100,
    labelComponents: { Venue: "lon", venue: "ny", nullish: null },
    namespaces: [" Trading ", "Retail Accounts"],
  });
  assert.equal(inspection.eventId, "evt 9");
  assert.equal(inspection.namespaceDepth, 2);
  assert.deepEqual(inspection.duplicateComponents, ["venue"]);
  assert.ok(inspection.invalidOffsets.length > 0);
  assert.equal(inspection.canonicalComponents.venue, "ny");
});

test("maximum label length is enforced on both input and output", () => {
  const labels = new TradeEventLabel(32);
  assert.throws(
    () =>
      labels.format({
        category: "trade",
        account: "ACCOUNT123",
        sequence: 1,
        attributes: { note: "x".repeat(40) },
      }),
    /exceeds/u,
  );
  assert.throws(() => labels.tokenize("x".repeat(33)), /longer/u);
});
