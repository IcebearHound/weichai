import type { QuoteProvider } from "../../domain/quotes/quote-provider.js";
import type { Quote, QuoteRequest } from "../../domain/quotes/quote-types.js";
import { NotImplementedError } from "../../shared/errors.js";

export interface RateQuotePolicy {
  readonly freshTtlMs: 5_000;
  readonly providerTimeoutMs: number;
  readonly staleTtlMs: number;
}

export class RateQuoteService {
  public constructor(
    private readonly provider: QuoteProvider,
    private readonly policy: RateQuotePolicy,
    private readonly now: () => number = Date.now,
  ) {
    if (provider.name.trim().length < 3 || provider.name.length > 100) {
      throw new Error("quote provider name is invalid");
    }
    if (policy.freshTtlMs !== 5_000) {
      throw new Error("quote service fresh TTL must remain exactly five seconds");
    }
    if (!Number.isInteger(policy.providerTimeoutMs) || policy.providerTimeoutMs < 1) {
      throw new Error("quote provider timeout must be a positive integer");
    }
    if (policy.providerTimeoutMs > 120_000) {
      throw new Error("quote provider timeout exceeds two minutes");
    }
    if (!Number.isInteger(policy.staleTtlMs) || policy.staleTtlMs < policy.freshTtlMs) {
      throw new Error("quote stale TTL must be at least the fresh TTL");
    }
    if (policy.staleTtlMs > 86_400_000) {
      throw new Error("quote stale TTL cannot exceed one day");
    }
    const current = now();
    if (!Number.isFinite(current)) throw new Error("quote service clock returned a non-finite value");
    if (current < -8_640_000_000_000_000 || current > 8_640_000_000_000_000) {
      throw new Error("quote service clock returned a value outside JavaScript date range");
    }
  }

  public async getQuote(request: QuoteRequest): Promise<Quote> {
    void request;
    throw new NotImplementedError("RateQuoteService.getQuote");
  }
}
