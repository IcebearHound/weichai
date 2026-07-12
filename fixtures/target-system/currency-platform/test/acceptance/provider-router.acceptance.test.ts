import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRouter } from "../../src/application/providers/provider-router.js";
import type { QuoteProvider } from "../../src/domain/quotes/quote-provider.js";
import type { Quote, QuoteRequest } from "../../src/domain/quotes/quote-types.js";
import { currencyCode } from "../../src/domain/quotes/quote-types.js";
import { providerId, type ProviderRegistration } from "../../src/domain/providers/provider-types.js";

const request: QuoteRequest = {
  base: currencyCode("USD"),
  counter: currencyCode("CNY"),
  amount: "1000",
  requestedAt: new Date("2026-07-12T08:00:00.000Z"),
  correlationId: "router-test-001",
};

function quote(provider: string): Quote {
  return {
    base: request.base,
    counter: request.counter,
    bid: "7.1200",
    ask: "7.1300",
    provider,
    observedAt: request.requestedAt,
    expiresAt: new Date(request.requestedAt.getTime() + 5_000),
    stale: false,
  };
}

function registration(name: string, priority: number, provider: QuoteProvider): ProviderRegistration {
  return {
    id: providerId(name),
    priority,
    provider,
    supportedPairs: ["USD/CNY"],
    timeoutMs: 100,
  };
}

const policy = {
  failureThreshold: 2,
  openDurationMs: 50,
  halfOpenProbeLimit: 1,
  successThreshold: 1,
} as const;

test("normal: the primary provider serves a supported pair", async () => {
  let primaryCalls = 0;
  const primary: QuoteProvider = {
    name: "primary-provider",
    async fetch() {
      primaryCalls += 1;
      return quote("primary-provider");
    },
  };
  const router = new ProviderRouter([registration("primary", 0, primary)], policy);
  const result = await router.fetchQuote(request);
  assert.equal(result.provider, "primary-provider");
  assert.equal(primaryCalls, 1);
});

test("boundary: the exact failure threshold opens only the failing provider circuit", async () => {
  let primaryCalls = 0;
  let backupCalls = 0;
  const primary: QuoteProvider = {
    name: "primary-provider",
    async fetch() {
      primaryCalls += 1;
      throw new Error("primary unavailable");
    },
  };
  const backup: QuoteProvider = {
    name: "backup-provider",
    async fetch() {
      backupCalls += 1;
      return quote("backup-provider");
    },
  };
  const router = new ProviderRouter(
    [registration("primary", 0, primary), registration("backup", 1, backup)],
    policy,
  );
  await router.fetchQuote(request);
  await router.fetchQuote(request);
  await router.fetchQuote(request);
  assert.equal(primaryCalls, 2);
  assert.equal(backupCalls, 3);
  assert.equal(router.snapshots().find((item) => item.providerId === "primary")?.mode, "open");
  assert.equal(router.snapshots().find((item) => item.providerId === "backup")?.mode, "closed");
});

test("failure: exhausting primary and backup reports a routing failure", async () => {
  const failing = (name: string): QuoteProvider => ({
    name,
    async fetch() {
      throw new Error(`${name} unavailable`);
    },
  });
  const router = new ProviderRouter(
    [registration("primary", 0, failing("primary-provider")), registration("backup", 1, failing("backup-provider"))],
    policy,
  );
  await assert.rejects(router.fetchQuote(request), /all quote providers failed/u);
});

test("concurrency: half-open recovery admits only one probe", async () => {
  let now = new Date(0);
  let calls = 0;
  let fail = true;
  const provider: QuoteProvider = {
    name: "recovering-provider",
    async fetch() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail) throw new Error("recovering provider unavailable");
      return quote("recovering-provider");
    },
  };
  const router = new ProviderRouter([registration("recovering", 0, provider)], policy, () => now);
  await assert.rejects(router.fetchQuote(request));
  await assert.rejects(router.fetchQuote(request));
  now = new Date(50);
  fail = false;
  const results = await Promise.allSettled([
    router.fetchQuote(request),
    router.fetchQuote(request),
    router.fetchQuote(request),
  ]);
  assert.equal(calls, 3);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(router.snapshots()[0]?.mode, "closed");
});
