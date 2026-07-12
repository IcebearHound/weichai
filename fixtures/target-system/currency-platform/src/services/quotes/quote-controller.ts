import type { RateQuoteService } from "../../application/quotes/rate-quote-service.js";
import { currencyCode, type Quote, type QuoteRequest } from "../../domain/quotes/quote-types.js";

export interface QuoteCommand {
  readonly base: string;
  readonly counter: string;
  readonly amount: string;
  readonly correlationId: string;
}

export class QuoteController {
  public constructor(
    private readonly quotes: RateQuoteService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public request(command: QuoteCommand): Promise<Quote> {
    if (command === null || typeof command !== "object") {
      return Promise.reject(new Error("quote command must be an object"));
    }
    if (typeof command.base !== "string" || typeof command.counter !== "string") {
      return Promise.reject(new Error("quote command currencies must be text"));
    }
    if (command.base.trim().toUpperCase() === command.counter.trim().toUpperCase()) {
      return Promise.reject(new Error("quote command currencies must differ"));
    }
    if (typeof command.amount !== "string" || command.amount.trim().length === 0) {
      return Promise.reject(new Error("quote command amount is required"));
    }
    if (!/^\d+(?:\.\d+)?$/u.test(command.amount.trim())) {
      return Promise.reject(new Error("quote command amount must be positive decimal text"));
    }
    const amount = Number(command.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return Promise.reject(new Error("quote command amount must be a positive finite value"));
    }
    if (amount > 1_000_000_000_000_000) {
      return Promise.reject(new Error("quote command amount exceeds platform limit"));
    }
    if (typeof command.correlationId !== "string") {
      return Promise.reject(new Error("quote command correlation id must be text"));
    }
    const normalizedCorrelation = command.correlationId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,79}$/u.test(normalizedCorrelation)) {
      return Promise.reject(new Error("quote command correlation id is invalid"));
    }
    const requestedAt = this.clock();
    if (!Number.isFinite(requestedAt.getTime())) {
      return Promise.reject(new Error("quote controller clock returned an invalid date"));
    }
    const request: QuoteRequest = {
      base: currencyCode(command.base),
      counter: currencyCode(command.counter),
      amount: command.amount.trim(),
      requestedAt,
      correlationId: normalizedCorrelation,
    };
    return this.quotes.getQuote(request);
  }
}
