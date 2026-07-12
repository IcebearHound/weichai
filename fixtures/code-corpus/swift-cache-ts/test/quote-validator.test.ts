import assert from "node:assert/strict";
import test from "node:test";
import { QuoteValidator } from "../src/quote-validator.js";

test("a current well-formed quote has no issues", () => {
  const validator = new QuoteValidator();
  const issues = validator.validate(
    {
      base: "EUR",
      counter: "USD",
      price: 1.08,
      timestamp: 10_000,
      precision: 4,
    },
    10_500,
  );
  assert.deepEqual(issues, []);
});

test("structural errors are returned in stable field order", () => {
  const validator = new QuoteValidator();
  const issues = validator.validate(
    { base: "eur", counter: "eur", price: -1, timestamp: -2, precision: 20 },
    100,
  );
  assert.deepEqual(
    issues.map((issue) => `${issue.field}:${issue.code}`),
    [
      "base:currency-code",
      "counter:currency-code",
      "counter:same-currency",
      "price:non-positive",
      "timestamp:invalid-epoch",
      "precision:unsupported",
    ],
  );
  assert.equal(
    issues.every((issue) => Object.isFrozen(issue)),
    true,
  );
});

test("freshness boundaries distinguish tolerated skew and stale data", () => {
  const validator = new QuoteValidator(5_000, 1_000);
  const quote = {
    base: "GBP",
    counter: "USD",
    price: 1.2,
    timestamp: 10_000,
    precision: 2,
  };
  assert.deepEqual(validator.validate(quote, 15_000), []);
  assert.deepEqual(
    validator.validate(quote, 15_001).map((issue) => issue.code),
    ["stale"],
  );
  assert.deepEqual(validator.validate(quote, 9_000), []);
  assert.deepEqual(
    validator.validate(quote, 8_999).map((issue) => issue.code),
    ["future"],
  );
});

test("declared scale mismatch is a warning rather than rejection", () => {
  const validator = new QuoteValidator();
  const issues = validator.validate(
    { base: "USD", counter: "JPY", price: 151.234, timestamp: 1, precision: 2 },
    1,
  );
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["price-exceeds-scale"],
  );
  assert.equal(issues[0]!.severity, "warning");
});

test("currency pairs are normalized with a canonical slash", () => {
  const validator = new QuoteValidator();
  assert.equal(validator.normalizePair(" eur ", "uSd"), "EUR/USD");
  assert.throws(() => validator.normalizePair("EU", "USD"), /base currency/u);
  assert.throws(() => validator.normalizePair("USD", "USD"), /must differ/u);
});

test("price precision rounds representative decimal values", () => {
  const validator = new QuoteValidator();
  assert.equal(validator.checkPrecision(1.23456, 4), 1.2346);
  assert.equal(validator.checkPrecision(151.005, 2), 151.01);
  assert.equal(validator.checkPrecision(3, 0), 3);
});

test("precision checks reject unsafe or non-positive prices", () => {
  const validator = new QuoteValidator();
  assert.throws(() => validator.checkPrecision(0, 2), /greater than zero/u);
  assert.throws(() => validator.checkPrecision(Infinity, 2), /finite/u);
  assert.throws(() => validator.checkPrecision(1, 13), /zero to twelve/u);
  assert.throws(
    () => validator.checkPrecision(Number.MAX_VALUE, 12),
    /safely/u,
  );
});

test("field inspection normalizes keys and tracks numeric values", () => {
  const validator = new QuoteValidator();
  const inspection = validator.evaluateQualityPolicies({
    quoteId: " quote-7 ",
    receivedAt: 1,
    quoteFields: { Base: "EUR", counter: "USD", Price: "1.25", active: true },
    requiredFields: ["base", "counter", "price", "provider"],
  });
  assert.equal(inspection.quoteId, "quote-7");
  assert.deepEqual(inspection.missing, ["provider"]);
  assert.equal(inspection.normalized.base, "EUR");
  assert.equal(inspection.numericFields.price, 1.25);
  assert.deepEqual(inspection.malformed, []);
});

test("field normalization exposes collisions and malformed values", () => {
  const validator = new QuoteValidator();
  const inspection = validator.evaluateQualityPolicies({
    quoteId: "q",
    receivedAt: 1,
    quoteFields: {
      "trade id": "first",
      trade_id: "second",
      nullValue: null,
      oversized: "x".repeat(513),
    },
  });
  assert.deepEqual(inspection.duplicates, ["trade_id"]);
  assert.deepEqual(inspection.malformed, ["nullValue:null", "oversized:value"]);
  assert.equal(inspection.normalized.trade_id, "first");
});

test("quote validation is stable across common currency combinations", () => {
  const validator = new QuoteValidator();
  for (const [base, counter] of [
    ["EUR", "USD"],
    ["GBP", "JPY"],
    ["AUD", "NZD"],
    ["CAD", "CHF"],
  ] as const) {
    const issues = validator.validate(
      { base, counter, price: 1, timestamp: 100, precision: 0 },
      100,
    );
    assert.deepEqual(issues, [], `${base}/${counter}`);
  }
});
