import type { Quote, QuoteRequest } from "./quote-types.js";

export interface QuoteProvider {
  readonly name: string;
  fetch(request: QuoteRequest, signal: AbortSignal): Promise<Quote>;
}
