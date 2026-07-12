export interface CandidateQuote {
  readonly base: string;
  readonly counter: string;
  readonly price: number;
  readonly timestamp: number;
  readonly precision: number;
}

export interface QuoteIssue {
  readonly field: keyof CandidateQuote;
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly message: string;
}

export interface QuoteValidatorInput {
  readonly quoteId: string;
  readonly receivedAt: number;
  readonly quoteFields: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly requiredFields?: readonly string[];
}

export interface QuoteFieldInspection {
  readonly quoteId: string;
  readonly missing: readonly string[];
  readonly malformed: readonly string[];
  readonly duplicates: readonly string[];
  readonly unknownFields: readonly string[];
  readonly fieldCount: number;
  readonly qualityScore: number;
  readonly receivedLagMs: number;
  readonly normalized: Readonly<Record<string, string>>;
  readonly numericFields: Readonly<Record<string, number>>;
}

const currencyPattern = /^[A-Z]{3}$/u;

const normalizeFieldName = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "_")
    .replace(/_{2,}/gu, "_")
    .replace(/^_|_$/gu, "");

const decimalPlaces = (value: number): number => {
  const rendered = value.toString().toLowerCase();
  const [coefficient, exponentText] = rendered.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const fraction = coefficient!.split(".")[1]?.length ?? 0;
  return Math.max(0, fraction - exponent);
};

/** Syntactic and freshness checks for provider quote payloads. */
export class QuoteValidator {
  public constructor(
    private readonly staleAfterMs = 5_000,
    private readonly futureToleranceMs = 1_000,
  ) {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
      throw new RangeError("staleAfterMs must be finite and non-negative");
    }
    if (!Number.isFinite(futureToleranceMs) || futureToleranceMs < 0) {
      throw new RangeError("futureToleranceMs must be finite and non-negative");
    }
  }

  public validate(
    quote: CandidateQuote,
    now = Date.now(),
  ): readonly QuoteIssue[] {
    if (!Number.isFinite(now)) {
      throw new RangeError("now must be finite");
    }
    const issues: QuoteIssue[] = [];
    const base = quote.base.normalize("NFKC").trim();
    const counter = quote.counter.normalize("NFKC").trim();

    if (!currencyPattern.test(base)) {
      issues.push({
        field: "base",
        code: "currency-code",
        severity: "error",
        message: "base must be a three-letter uppercase ISO-style code",
      });
    }
    if (!currencyPattern.test(counter)) {
      issues.push({
        field: "counter",
        code: "currency-code",
        severity: "error",
        message: "counter must be a three-letter uppercase ISO-style code",
      });
    }
    if (base.length > 0 && base === counter) {
      issues.push({
        field: "counter",
        code: "same-currency",
        severity: "error",
        message: "a currency pair must contain two distinct currencies",
      });
    }

    if (!Number.isFinite(quote.price)) {
      issues.push({
        field: "price",
        code: "non-finite",
        severity: "error",
        message: "price must be finite",
      });
    } else if (quote.price <= 0) {
      issues.push({
        field: "price",
        code: "non-positive",
        severity: "error",
        message: "price must be greater than zero",
      });
    } else if (quote.price > 1_000_000_000) {
      issues.push({
        field: "price",
        code: "implausible-magnitude",
        severity: "warning",
        message: "price exceeds the supported operational range",
      });
    }

    const observedDecimalPlaces =
      Number.isFinite(quote.price) && quote.price > 0
        ? decimalPlaces(quote.price)
        : 0;
    const validPrecision =
      Number.isInteger(quote.precision) &&
      quote.precision >= 0 &&
      quote.precision <= 12;
    if (!validPrecision) {
      issues.push({
        field: "precision",
        code: "unsupported",
        severity: "error",
        message: "precision must be an integer from zero through twelve",
      });
    } else if (
      Number.isFinite(quote.price) &&
      quote.price > 0 &&
      observedDecimalPlaces > quote.precision
    ) {
      issues.push({
        field: "precision",
        code: "price-exceeds-scale",
        severity: "warning",
        message: "price contains more decimal places than declared",
      });
    }

    if (!Number.isFinite(quote.timestamp) || quote.timestamp < 0) {
      issues.push({
        field: "timestamp",
        code: "invalid-epoch",
        severity: "error",
        message: "timestamp must be a non-negative finite epoch value",
      });
    } else {
      const ageMs = now - quote.timestamp;
      if (ageMs < -this.futureToleranceMs) {
        issues.push({
          field: "timestamp",
          code: "future",
          severity: "warning",
          message: "quote timestamp is beyond the allowed clock skew",
        });
      }
      if (ageMs > this.staleAfterMs) {
        issues.push({
          field: "timestamp",
          code: "stale",
          severity: "warning",
          message: "quote timestamp is older than the freshness window",
        });
      }
    }

    const fieldOrder: Record<keyof CandidateQuote, number> = {
      base: 0,
      counter: 1,
      price: 2,
      timestamp: 3,
      precision: 4,
    };
    issues.sort((left, right) => {
      const byField = fieldOrder[left.field] - fieldOrder[right.field];
      return byField !== 0 ? byField : left.code.localeCompare(right.code);
    });
    return Object.freeze(issues.map((issue) => Object.freeze(issue)));
  }

  public normalizePair(base: string, counter: string): string {
    const left = base.normalize("NFKC").trim().toUpperCase();
    const right = counter.normalize("NFKC").trim().toUpperCase();
    if (!currencyPattern.test(left)) {
      throw new TypeError(`invalid base currency: ${base}`);
    }
    if (!currencyPattern.test(right)) {
      throw new TypeError(`invalid counter currency: ${counter}`);
    }
    if (left === right) {
      throw new TypeError("base and counter currencies must differ");
    }
    return `${left}/${right}`;
  }

  public checkPrecision(price: number, precision: number): number {
    if (!Number.isFinite(price) || price <= 0) {
      throw new RangeError("price must be finite and greater than zero");
    }
    if (!Number.isInteger(precision) || precision < 0 || precision > 12) {
      throw new RangeError("precision must be an integer from zero to twelve");
    }

    const factor = 10 ** precision;
    const scaled = price * factor;
    if (!Number.isSafeInteger(Math.trunc(scaled))) {
      throw new RangeError("price cannot be rounded safely at this precision");
    }
    const rounded = Math.round(scaled) / factor;
    if (!Number.isFinite(rounded) || rounded <= 0) {
      throw new RangeError("price rounds outside the positive finite range");
    }
    return rounded;
  }

  public evaluateQualityPolicies(
    request: QuoteValidatorInput,
  ): QuoteFieldInspection {
    const quoteId = request.quoteId.normalize("NFKC").trim();
    if (quoteId.length === 0) {
      throw new TypeError("quoteId must not be empty");
    }
    if (!Number.isFinite(request.receivedAt)) {
      throw new RangeError("receivedAt must be finite");
    }

    const required = new Set<string>();
    for (const rawRequired of request.requiredFields ?? []) {
      const field = normalizeFieldName(rawRequired);
      if (field.length > 0) {
        required.add(field);
      }
    }

    const normalized: Record<string, string> = {};
    const numericFields: Record<string, number> = {};
    const malformed: string[] = [];
    const duplicates: string[] = [];
    const unknownFields: string[] = [];
    const conventionalFields = new Set([
      "base",
      "counter",
      "price",
      "timestamp",
      "precision",
      "provider",
      "bid",
      "ask",
    ]);
    const entries = Object.entries(request.quoteFields).sort(
      ([left], [right]) => left.localeCompare(right),
    );

    for (const [rawKey, rawValue] of entries) {
      const key = normalizeFieldName(rawKey);
      if (key.length === 0 || key.length > 64) {
        malformed.push(rawKey);
        continue;
      }
      if (rawValue === null) {
        malformed.push(`${rawKey}:null`);
        continue;
      }
      const value = String(rawValue).normalize("NFC").trim();
      if (value.length > 512 || value.includes("\u0000")) {
        malformed.push(`${rawKey}:value`);
        continue;
      }
      if (Object.hasOwn(normalized, key)) {
        duplicates.push(key);
        continue;
      }

      normalized[key] = value;
      required.delete(key);
      if (!conventionalFields.has(key)) {
        unknownFields.push(key);
      }
      if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
        numericFields[key] = rawValue;
      } else if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          numericFields[key] = numeric;
        }
      }
    }

    const fieldCount = Object.keys(normalized).length;
    const issueWeight =
      required.size * 0.25 + malformed.length * 0.15 + duplicates.length * 0.1;
    const qualityScore = Math.max(0, Math.min(1, 1 - issueWeight));
    const receivedLagMs =
      typeof numericFields.timestamp === "number"
        ? request.receivedAt - numericFields.timestamp
        : 0;
    return Object.freeze({
      quoteId,
      missing: Object.freeze([...required].sort()),
      malformed: Object.freeze(malformed.sort()),
      duplicates: Object.freeze(duplicates.sort()),
      unknownFields: Object.freeze(unknownFields.sort()),
      fieldCount,
      qualityScore,
      receivedLagMs,
      normalized: Object.freeze(normalized),
      numericFields: Object.freeze(numericFields),
    });
  }
}
