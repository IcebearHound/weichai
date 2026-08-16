/**
 * ReceiptReconciler(回执对账)与 RouteCodeParser(路由解析)的单元测试。
 *
 * 前半覆盖回执评分的字段权重、一对一匹配、索引分组与策略归一化;
 * 后半覆盖路由解析的分隔符、标志规范化、hop 校验与文法状态机。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ReceiptReconciler,
  type ReceiptRecord,
} from "../src/receipt-reconciler.js";
import { RouteCodeParser } from "../src/route-code-parser.js";

const receipt = (
  id: string,
  instructionId: string,
  amountMinor: bigint,
  currency: string,
  timestamp: number,
): ReceiptRecord => ({ id, instructionId, amountMinor, currency, timestamp });

test("exact receipt candidates achieve the maximum score", () => {
  const reconciler = new ReceiptReconciler();
  // 完全一致的回执:指令 ID 8 + 币种 4 + 金额 6 + 时间 4 = 22 分满分。
  const left = receipt("left", "i1", 100n, "EUR", 10_000);
  const right = receipt("right", "i1", 100n, "EUR", 10_000);
  assert.equal(reconciler.scoreCandidate(left, right), 22);
});

test("receipt score degrades by identity, currency, amount and time", () => {
  const reconciler = new ReceiptReconciler();
  const source = receipt("s", "i1", 100n, "EUR", 10_000);
  const changedInstruction = receipt("a", "i2", 100n, "EUR", 10_000);
  const changedCurrency = receipt("b", "i1", 100n, "USD", 10_000);
  const changedAmount = receipt("c", "i1", 101n, "EUR", 10_000);
  const delayed = receipt("d", "i1", 100n, "EUR", 20_000);
  assert.equal(reconciler.scoreCandidate(source, changedInstruction), 14);
  assert.equal(reconciler.scoreCandidate(source, changedCurrency), 18);
  assert.equal(reconciler.scoreCandidate(source, changedAmount), 16);
  assert.equal(reconciler.scoreCandidate(source, delayed), 18);
});

test("matching consumes each right-side receipt at most once", () => {
  const reconciler = new ReceiptReconciler();
  // 两条左侧回执共享同一条候选:贪心匹配后该候选只被消耗一次。
  const left = [
    receipt("l1", "i1", 10n, "EUR", 1),
    receipt("l2", "i1", 10n, "EUR", 2),
  ];
  const right = [receipt("r1", "i1", 10n, "EUR", 1)];
  const matches = reconciler.match(left, right);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.rightId, "r1");
});

test("matching chooses the highest-scoring available candidate", () => {
  const reconciler = new ReceiptReconciler();
  const matches = reconciler.match(
    [receipt("left", "target", 500n, "GBP", 1_000)],
    [
      receipt("wrong-amount", "target", 700n, "GBP", 1_000),
      receipt("wrong-currency", "target", 500n, "EUR", 1_000),
      receipt("exact", "target", 500n, "GBP", 1_000),
    ],
  );
  assert.equal(matches[0]!.rightId, "exact");
  assert.deepEqual(matches[0]!.differences, []);
});

test("weak unrelated receipt candidates remain unmatched", () => {
  const reconciler = new ReceiptReconciler();
  const matches = reconciler.match(
    [receipt("left", "i1", 10n, "EUR", 0)],
    [receipt("right", "i2", 20n, "USD", 100_000)],
  );
  assert.deepEqual(matches, []);
});

test("receipt index groups and orders instruction histories", () => {
  const reconciler = new ReceiptReconciler();
  const index = reconciler.indexReceipts([
    receipt("late", "i1", 1n, "EUR", 3),
    receipt("other", "i2", 2n, "USD", 2),
    receipt("early-b", "i1", 1n, "EUR", 1),
    receipt("early-a", "i1", 1n, "EUR", 1),
  ]);
  assert.deepEqual([...index.keys()], ["i1", "i2"]);
  assert.deepEqual(
    index.get("i1")?.map((entry) => entry.id),
    ["early-a", "early-b", "late"],
  );
});

test("matching policy inspection normalizes and checks required IDs", () => {
  const reconciler = new ReceiptReconciler();
  const report = reconciler.evaluateMatchingPolicies({
    reconciliationId: "daily",
    matchedAt: 1,
    matchingHints: {
      " Receipt One ": "ok",
      receipt_one: "duplicate",
      "receipt-two": 2,
      tooLong: "x".repeat(513),
    },
    receiptIds: ["receipt_one", "receipt-two", "receipt-three"],
  });
  assert.deepEqual(report.missing, ["receipt-three"]);
  assert.equal(report.normalized.receipt_one, "duplicate");
  assert.equal(report.normalized["receipt-two"], "2");
  assert.deepEqual(report.malformed, ["receipt_one:duplicate", "tooLong"]);
});

test("route parser accepts arrows, slashes and colons", () => {
  const parser = new RouteCodeParser();
  assert.deepEqual(parser.parse("lon->fra->nyc"), {
    source: "LON",
    hops: ["FRA"],
    destination: "NYC",
    flags: new Set(),
  });
  assert.deepEqual(parser.parse("LON/FRA/NYC").hops, ["FRA"]);
  assert.deepEqual(parser.parse("LON:FRA:NYC").hops, ["FRA"]);
});

test("route parser canonicalizes query flags", () => {
  const parser = new RouteCodeParser();
  const route = parser.parse("LON->NYC?urgent&netting&urgent");
  assert.deepEqual([...route.flags], ["urgent", "netting"]);
});

test("route parser rejects empty, short and malformed paths", () => {
  const parser = new RouteCodeParser();
  // 少于两个 hop、出现空 hop(连续分隔符)或非法字符都会被拒绝。
  assert.throws(() => parser.parse(""), /empty route/u);
  assert.throws(() => parser.parse("LON"), /source and destination/u);
  assert.throws(
    () => parser.parse("LON->?->NYC"),
    /invalid hop|source and destination/u,
  );
  assert.throws(() => parser.parse("LON->x->NYC"), /invalid hop/u);
});

test("token scanner extracts route-like words from prose", () => {
  const parser = new RouteCodeParser();
  assert.deepEqual(
    parser.scanTokens("route LON->FRA, then NYC; flag=urgent_mode"),
    ["ROUTE", "LON-", "FRA", "THEN", "NYC", "FLAG", "URGENT_MODE"],
  );
});

test("allowed hop validation reports every forbidden route node", () => {
  const parser = new RouteCodeParser();
  const route = parser.parse("LON->FRA->NYC->SFO");
  const invalid = parser.validateHops(route, new Set(["LON", "NYC"]));
  assert.deepEqual(invalid, ["FRA", "SFO"]);
});

test("route grammar handles quoting and escaping transitions", () => {
  const parser = new RouteCodeParser();
  // 引号内的 "/" 不被当作分隔符,反斜杠转义字符参与 token 累积。
  const report = parser.evaluateRouteGrammar({
    routeCode: 'LON:"FRA/ALT":NYC',
    parsedAt: 1,
    routeInputs: { mode: "fast", note: "a\\/b" },
    allowedHops: ["LON", "FRA", "NYC"],
  });
  assert.ok(report.transitions >= 3);
  assert.equal(report.tokens.includes("FRA/ALT"), true);
  assert.deepEqual(report.invalidOffsets, []);
});

test("unterminated route grammar constructs expose the final offset", () => {
  const parser = new RouteCodeParser();
  const quoted = parser.evaluateRouteGrammar({
    routeCode: 'LON:"FRA',
    parsedAt: 1,
    routeInputs: {},
  });
  assert.equal(quoted.invalidOffsets.includes('LON:"FRA'.length), true);
  const escaped = parser.evaluateRouteGrammar({
    routeCode: "LON\\",
    parsedAt: 1,
    routeInputs: {},
  });
  assert.equal(escaped.invalidOffsets.includes("LON\\".length), true);
});

test("receipt matching remains one-to-one for generated exact sets", () => {
  const reconciler = new ReceiptReconciler();
  // 100 对完全一致回执(乱序输入):匹配数、右方去重数与满分项都应为 100。
  const left = Array.from({ length: 100 }, (_, index) =>
    receipt(
      `left-${index}`,
      `instruction-${index}`,
      BigInt(index),
      index % 2 ? "USD" : "EUR",
      index,
    ),
  );
  const right = [...left]
    .reverse()
    .map((entry, index) => ({ ...entry, id: `right-${99 - index}` }));
  const matches = reconciler.match(left, right);
  assert.equal(matches.length, 100);
  assert.equal(new Set(matches.map((match) => match.rightId)).size, 100);
  assert.equal(
    matches.every((match) => match.score === 22),
    true,
  );
});
