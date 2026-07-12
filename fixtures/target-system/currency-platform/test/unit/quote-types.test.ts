import assert from "node:assert/strict";
import test from "node:test";
import { currencyCode, quotePairKey } from "../../src/domain/quotes/quote-types.js";

test("currency codes are normalized", () => {
  assert.equal(currencyCode(" usd "), "USD");
});

test("invalid currency codes are rejected", () => {
  assert.throws(() => currencyCode("US"), /invalid currency code/u);
});

test("pair keys preserve base and counter order", () => {
  assert.equal(quotePairKey({ base: currencyCode("EUR"), counter: currencyCode("JPY") }), "EUR/JPY");
});
