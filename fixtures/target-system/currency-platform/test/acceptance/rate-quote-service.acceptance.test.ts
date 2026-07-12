import assert from "node:assert/strict";
import test from "node:test";
import { RateQuoteService } from "../../src/application/quotes/rate-quote-service.js";
import type { QuoteProvider } from "../../src/domain/quotes/quote-provider.js";
import { currencyCode, type Quote, type QuoteRequest } from "../../src/domain/quotes/quote-types.js";

const request: QuoteRequest = {
  base: currencyCode("USD"),
  counter: currencyCode("CNY"),
  amount: "100",
  requestedAt: new Date(0),
  correlationId: "quote-1",
};

function quote(stale = false): Quote {
  return {
    base: request.base,
    counter: request.counter,
    bid: "7.1200",
    ask: "7.1300",
    provider: "sample-provider",
    observedAt: new Date(0),
    expiresAt: new Date(5_000),
    stale,
  };
}

test("normal: a fresh quote is cached for five seconds", async () => {
  let calls = 0;
  const provider: QuoteProvider = {
    name: "sample-provider",
    async fetch() {
      calls += 1;
      return quote();
    },
  };
  const service = new RateQuoteService(provider, { freshTtlMs: 5_000, providerTimeoutMs: 100, staleTtlMs: 60_000 });
  assert.deepEqual(await service.getQuote(request), quote());
  assert.deepEqual(await service.getQuote(request), quote());
  assert.equal(calls, 1);
});

test("boundary: an entry at the TTL boundary is refreshed", async () => {
  let now = 0;
  let calls = 0;
  const provider: QuoteProvider = {
    name: "sample-provider",
    async fetch() {
      calls += 1;
      return quote();
    },
  };
  const service = new RateQuoteService(
    provider,
    { freshTtlMs: 5_000, providerTimeoutMs: 100, staleTtlMs: 60_000 },
    () => now,
  );
  await service.getQuote(request);
  now = 5_000;
  await service.getQuote(request);
  assert.equal(calls, 2);
});

test("failure: provider timeout falls back to stale data", async () => {
  let fail = false;
  const provider: QuoteProvider = {
    name: "sample-provider",
    async fetch() {
      if (fail) throw new Error("offline");
      return quote();
    },
  };
  const service = new RateQuoteService(provider, { freshTtlMs: 5_000, providerTimeoutMs: 10, staleTtlMs: 60_000 });
  await service.getQuote(request);
  fail = true;
  const result = await service.getQuote({ ...request, requestedAt: new Date(10_000) });
  assert.equal(result.stale, true);
});

test("concurrency: requests for one pair share one provider call", async () => {
  let calls = 0;
  const provider: QuoteProvider = {
    name: "sample-provider",
    async fetch() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return quote();
    },
  };
  const service = new RateQuoteService(provider, { freshTtlMs: 5_000, providerTimeoutMs: 100, staleTtlMs: 60_000 });
  await Promise.all([service.getQuote(request), service.getQuote(request), service.getQuote(request)]);
  assert.equal(calls, 1);
});
