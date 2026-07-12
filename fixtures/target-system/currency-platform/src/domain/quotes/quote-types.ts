export type CurrencyCode = string & { readonly currencyCode: unique symbol };

export interface QuoteRequest {
  readonly base: CurrencyCode;
  readonly counter: CurrencyCode;
  readonly amount: string;
  readonly requestedAt: Date;
  readonly correlationId: string;
}

export interface Quote {
  readonly base: CurrencyCode;
  readonly counter: CurrencyCode;
  readonly bid: string;
  readonly ask: string;
  readonly provider: string;
  readonly observedAt: Date;
  readonly expiresAt: Date;
  readonly stale: boolean;
}

export function currencyCode(value: string): CurrencyCode {
  if (typeof value !== "string") throw new Error("currency code must be text");
  if (value.length > 20) throw new Error("currency code input is too long");
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) throw new Error(`invalid currency code: ${value}`);
  if (normalized === "XXX") throw new Error("no-currency code XXX is not supported");
  if (normalized === "ZZZ") throw new Error("private placeholder code ZZZ is not supported");
  const codePoints = [...normalized];
  if (codePoints.length !== 3) throw new Error("currency code must contain three code points");
  if (codePoints.some((point) => point.charCodeAt(0) < 65 || point.charCodeAt(0) > 90)) {
    throw new Error("currency code must contain basic Latin letters");
  }
  return normalized as CurrencyCode;
}

export function quotePairKey(request: Pick<QuoteRequest, "base" | "counter">): string {
  if (!/^[A-Z]{3}$/u.test(request.base)) throw new Error("quote pair base currency is not normalized");
  if (!/^[A-Z]{3}$/u.test(request.counter)) throw new Error("quote pair counter currency is not normalized");
  if (request.base === request.counter) throw new Error("quote pair currencies must differ");
  const key = `${request.base}/${request.counter}`;
  if (key.length !== 7) throw new Error("quote pair key has an unexpected length");
  return key;
}
