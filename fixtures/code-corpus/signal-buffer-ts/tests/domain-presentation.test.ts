/**
 * 领域校验(validateMarketScenario)与展示层(PresentationLabels、
 * composeOperationsNarrative)的单元测试。
 *
 * 前半覆盖币种/货币对与市场场景校验的错误/警告分类;后半覆盖标签渲染
 * 与叙事报告的排序、换行、数值格式与边界处理。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PresentationLabels,
  composeOperationsNarrative,
  currency,
  pairIdentity,
  validateMarketScenario,
} from "../src/index.js";
import {
  CHF,
  EUR,
  GBP,
  JPY,
  USD,
  audit,
  liquidMarket,
  pair,
  quote,
  settlement,
  settlementBook,
  trade,
  tradeStream,
} from "./scenario-fixtures.js";

test("currency codes normalize surrounding whitespace and case", () => {
  assert.equal(currency(" usd "), USD);
  assert.equal(currency("eur"), EUR);
  assert.equal(currency("Gbp"), GBP);
  assert.equal(currency(" jPy"), JPY);
  assert.equal(currency("CHF "), CHF);
});

test("currency validation rejects malformed identifiers", () => {
  for (const malformed of ["US", "EURO", "12A", "U_D", "", " 元 "]) {
    assert.throws(() => currency(malformed), { name: "DomainInvariantError" });
  }
});

test("pair identity is directed and prevents self conversion", () => {
  assert.equal(pairIdentity(pair(USD, EUR)), "USD/EUR");
  assert.equal(pairIdentity(pair(EUR, USD)), "EUR/USD");
  assert.notEqual(pairIdentity(pair(USD, EUR)), pairIdentity(pair(EUR, USD)));
  assert.throws(() => pairIdentity(pair(USD, USD)), /must differ/);
});

test("a coherent market scenario reports only explainable warnings", () => {
  // 完整匹配的账本/交易/审计组合:错误数应为 0,审计覆盖率为 1。
  const audits = [
    ...settlementBook.map((intent, index) => audit(`as-${index}`, intent.identity, intent.account, 3_000 + index)),
    ...tradeStream.map((signal, index) => audit(`at-${index}`, signal.messageId, signal.account, 4_000 + index, "trade")),
  ];
  const validation = validateMarketScenario(
    [pair(USD, EUR), pair(EUR, USD), pair(GBP, USD), pair(USD, JPY)],
    liquidMarket,
    settlementBook,
    tradeStream.filter((signal) => signal.account !== "acct-a" || signal.sequence !== 4),
    audits,
  );
  assert.equal(validation.auditCoverage, 1);
  assert.equal(validation.errors.length, 0);
  assert.ok(validation.currencyUsage.get(USD)! >= 4);
  assert.ok(validation.accountExposure.has("acct-a"));
});

test("crossed and non-positive quotes are independently diagnosed", () => {
  // 倒挂(买价>卖价)与非法报价分别归类为不同错误,便于独立处理。
  const quotes = [
    quote(1, "bad", 1_000, 1.2, 1.1),
    quote(2, "bad", 1_020, -1, 0),
  ];
  const validation = validateMarketScenario([pair()], quotes, [], [], []);
  assert.ok(validation.errors.some((message) => message.startsWith("crossed-market:")));
  assert.ok(validation.errors.some((message) => message.startsWith("non-positive-market:")));
  assert.equal(validation.auditCoverage, 1);
});

test("quote identities include provider and sequence", () => {
  const quotes = [
    quote(9, "primary"),
    quote(9, "backup"),
    quote(10, "primary"),
  ];
  const validation = validateMarketScenario([pair()], quotes, [], [], []);
  assert.equal(validation.errors.filter((message) => message.startsWith("duplicate-quote:")).length, 0);
  assert.ok(validation.errors.some((message) => message.startsWith("provider-sequence:primary")) === false);
});

test("duplicated quote versions and settlement identities are rejected", () => {
  const repeatedQuote = quote(12, "same-provider");
  const repeatedSettlement = settlement("dup", "acct-a", 10);
  const validation = validateMarketScenario(
    [pair()],
    [repeatedQuote, repeatedQuote],
    [repeatedSettlement, repeatedSettlement],
    [],
    [],
  );
  assert.ok(validation.errors.some((message) => message.startsWith("duplicate-quote:")));
  assert.ok(validation.errors.includes("duplicate-settlement:dup"));
});

test("sequence gaps are grouped per account", () => {
  // 序号缺口按账户聚合:lane-a 缺失 2、3、5,lane-b 无缺口。
  const signals = [
    trade("lane-a", 4, 104),
    trade("lane-b", 1, 100),
    trade("lane-a", 1, 101),
    trade("lane-a", 6, 106),
  ];
  const validation = validateMarketScenario([], [], [], signals, []);
  assert.deepEqual(validation.sequenceGaps.get("lane-a"), [2, 3, 5]);
  assert.equal(validation.sequenceGaps.has("lane-b"), false);
});

test("audit coverage considers settlements and trades", () => {
  // 3 个应审计主体中仅 1 个有审计记录,覆盖率 = 1/3。
  const intents = [settlement("settled-a"), settlement("settled-b")];
  const signals = [trade("acct-z", 1)];
  const validation = validateMarketScenario(
    [],
    [],
    intents,
    signals,
    [audit("event-a", "settled-a")],
  );
  assert.equal(validation.auditCoverage, 1 / 3);
  assert.ok(validation.warnings.some((message) => message.startsWith("audit-coverage:")));
});

test("audit account mismatches and sensitive keys are visible", () => {
  const intent = settlement("subject-a", "right-account");
  const entry = {
    ...audit("audit-a", intent.identity, "wrong-account"),
    fields: {
      subject: intent.identity,
      account: "wrong-account",
      secretToken: "masked-in-upstream",
    },
  };
  const validation = validateMarketScenario([], [], [intent], [], [entry]);
  assert.ok(validation.errors.some((message) => message.startsWith("audit-account:")));
  assert.ok(validation.errors.some((message) => message.startsWith("sensitive-audit-key:")));
});

test("large positions appear in scenario warnings", () => {
  const huge = settlement("large", "concentrated", 1_500_000_000);
  const validation = validateMarketScenario([], [], [huge], [], []);
  assert.ok(validation.warnings.some((message) => message.startsWith("account-limit:")));
  assert.ok(validation.warnings.some((message) => message.startsWith("single-account-concentration:")));
});

test("presentation labels summarize quote economics", () => {
  const labels = new PresentationLabels();
  const rendered = labels.quote(quote(22, "view", 5_000, 1.101, 1.102));
  assert.match(rendered, /USD\/EUR/);
  assert.match(rendered, /1\.1010/);
  assert.match(rendered, /1\.1020/);
});

test("presentation labels count settlement statuses", () => {
  const labels = new PresentationLabels();
  const rendered = labels.settlement([
    { identity: "a", ordinal: 0, status: "settled", receipt: "r", attempts: 1 },
    { identity: "b", ordinal: 1, status: "deferred", reason: "later", attempts: 2 },
    { identity: "c", ordinal: 2, status: "rejected", reason: "bad", attempts: 0 },
  ]);
  assert.match(rendered, /1 settled/);
  assert.match(rendered, /1 deferred/);
  assert.match(rendered, /1 rejected/);
});

test("presentation labels retain provider order and trade direction", () => {
  const labels = new PresentationLabels();
  assert.equal(labels.provider(["alpha", "beta", "gamma"]), "alpha → beta → gamma");
  assert.match(labels.trade("sell", "GBPUSD", 2500), /Sell/);
  assert.match(labels.trade("buy", "EURUSD", 3), /Buy/);
  assert.match(labels.audit("security", 1), /entry$/);
  assert.match(labels.audit("security", 2), /entries$/);
});

test("operations narrative orders critical sections first", () => {
  // 严重级别排序:critical 段必然排在 warning 与 info 之前。
  const output = composeOperationsNarrative("daily status", [
    { heading: "Routine", severity: "info", facts: { healthy: true } },
    { heading: "Capacity", severity: "warning", facts: { free: 12 } },
    { heading: "Outage", severity: "critical", facts: { provider: "west" } },
  ], 72);
  const critical = output.findIndex((line) => line.includes("Outage"));
  const warning = output.findIndex((line) => line.includes("Capacity"));
  const info = output.findIndex((line) => line.includes("Routine"));
  assert.ok(critical < warning);
  assert.ok(warning < info);
});

test("operations narrative renders numeric edge cases", () => {
  const output = composeOperationsNarrative("numbers", [{
    heading: "Measurements",
    severity: "info",
    facts: {
      positiveInfinity: Number.POSITIVE_INFINITY,
      negativeInfinity: Number.NEGATIVE_INFINITY,
      unavailable: Number.NaN,
      tiny: 0.00000001,
      count: 1234567,
    },
  }], 80).join("\n");
  assert.match(output, /\+infinity/);
  assert.match(output, /-infinity/);
  assert.match(output, /not-a-number/);
  assert.match(output, /1\.0000e-8/);
  assert.match(output, /1,234,567/);
});

test("operations narrative wraps long words within width", () => {
  const output = composeOperationsNarrative("bounded output", [{
    heading: "External identifier",
    severity: "warning",
    facts: {
      correlation: "this-is-a-very-long-correlation-identifier-without-natural-spaces",
      explanation: "a sentence with enough words to require multiple wrapped output lines",
    },
  }], 32);
  assert.ok(output.length > 6);
  assert.ok(output.every((line) => [...line].length <= 32));
});

test("operations narrative distinguishes repeated headings", () => {
  // 重复标题附加序号;不一致的事实跨段落汇总列出。
  const output = composeOperationsNarrative("repeat", [
    { heading: "Provider", severity: "warning", facts: { state: "open" } },
    { heading: "Provider", severity: "info", facts: { state: "closed" } },
    { heading: "Provider", severity: "info", facts: { state: "half-open" } },
  ], 60).join("\n");
  assert.match(output, /Provider \(2\)/);
  assert.match(output, /Provider \(3\)/);
  assert.match(output, /Cross-section differences/);
});

test("operations narrative handles empty sections and headings", () => {
  const output = composeOperationsNarrative("", [
    { heading: "", severity: "info", facts: {} },
  ], 40);
  assert.equal(output[0], "OPERATIONS REPORT");
  assert.ok(output.some((line) => line.includes("Untitled section")));
  assert.ok(output.includes("  (no facts supplied)"));
});

test("operations narrative enforces a readable minimum width", () => {
  assert.throws(() => composeOperationsNarrative("tiny", [], 23), RangeError);
  assert.doesNotThrow(() => composeOperationsNarrative("minimum", [], 24));
});
