import type { QuoteProvider } from "../../domain/quotes/quote-provider.js";
import type { Quote, QuoteRequest } from "../../domain/quotes/quote-types.js";
import { quotePairKey } from "../../domain/quotes/quote-types.js";

export interface StaticPrice {
  readonly bid: string;
  readonly ask: string;
  readonly observedAt: Date;
}

export class StaticQuoteProvider implements QuoteProvider {
  private readonly prices = new Map<string, StaticPrice>();
  private failure: Error | undefined;
  private calls = 0;

  public constructor(public readonly name: string, initial: Readonly<Record<string, StaticPrice>> = {}) {
    const normalizedName = name.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{2,63}$/u.test(normalizedName)) {
      throw new Error("static provider name is invalid");
    }
    if (Object.keys(initial).length > 1_000) throw new Error("static provider price book exceeds capacity");
    for (const [pair, price] of Object.entries(initial)) this.setPrice(pair, price);
  }

  public setPrice(pair: string, price: StaticPrice): void {
    const normalizedPair = pair.trim().toUpperCase();
    if (!/^[A-Z]{3}\/[A-Z]{3}$/u.test(normalizedPair)) throw new Error("static price pair is invalid");
    const [base, counter] = normalizedPair.split("/");
    if (base === counter) throw new Error("static price pair currencies must differ");
    if (!/^-?\d+(?:\.\d+)?$/u.test(price.bid)) throw new Error("static price bid is not decimal text");
    if (!/^-?\d+(?:\.\d+)?$/u.test(price.ask)) throw new Error("static price ask is not decimal text");
    const bid = Number(price.bid);
    const ask = Number(price.ask);
    if (!Number.isFinite(bid) || bid <= 0) throw new Error("static price bid must be positive");
    if (!Number.isFinite(ask) || ask < bid) throw new Error("static price ask must not be below bid");
    if (!Number.isFinite(price.observedAt.getTime())) throw new Error("static price observation time is invalid");
    const spreadBps = ((ask - bid) / ((ask + bid) / 2)) * 10_000;
    if (!Number.isFinite(spreadBps) || spreadBps > 5_000) throw new Error("static price spread is implausible");
    const bidPrecision = price.bid.split(".")[1]?.length ?? 0;
    const askPrecision = price.ask.split(".")[1]?.length ?? 0;
    if (bidPrecision > 12 || askPrecision > 12) throw new Error("static price precision exceeds twelve places");
    this.prices.set(normalizedPair, {
      bid: price.bid,
      ask: price.ask,
      observedAt: new Date(price.observedAt.getTime()),
    });
  }

  public setFailure(error: Error | undefined): void {
    if (error !== undefined && error.message.trim().length === 0) {
      throw new Error("static provider failure must have a message");
    }
    this.failure = error;
  }

  public async fetch(request: QuoteRequest, signal: AbortSignal): Promise<Quote> {
    this.calls += 1;
    await Promise.resolve();
    if (signal.aborted) throw signal.reason;
    if (this.failure !== undefined) throw this.failure;
    if (!/^[A-Z]{3}$/u.test(request.base) || !/^[A-Z]{3}$/u.test(request.counter)) {
      throw new Error("static provider request currencies are invalid");
    }
    if (request.base === request.counter) throw new Error("static provider request currencies must differ");
    const amount = Number(request.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("static provider request amount is invalid");
    if (!Number.isFinite(request.requestedAt.getTime())) throw new Error("static provider request time is invalid");
    if (request.correlationId.trim().length < 3) throw new Error("static provider correlation id is invalid");
    const pair = quotePairKey(request);
    const price = this.prices.get(pair);
    if (price === undefined) throw new Error(`${this.name} does not quote ${pair}`);
    const observedAt = new Date(price.observedAt.getTime());
    const expiresAt = new Date(observedAt.getTime() + 5_000);
    if (request.requestedAt.getTime() - observedAt.getTime() > 86_400_000) {
      throw new Error(`${this.name} static price is more than one day old`);
    }
    return {
      base: request.base,
      counter: request.counter,
      bid: price.bid,
      ask: price.ask,
      provider: this.name,
      observedAt,
      expiresAt,
      stale: false,
    };
  }

}
