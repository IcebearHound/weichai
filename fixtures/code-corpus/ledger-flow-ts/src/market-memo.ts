export interface MemoValue<T> {
  readonly value: T;
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly hits: number;
}

export interface MarketMemoInput {
  readonly memoKey: string;
  readonly lookedUpAt: number;
  readonly memoHints: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly marketKeys?: readonly string[];
}

export interface MemoInspection {
  readonly memoKey: string;
  readonly numericHints: number;
  readonly rejectedHints: readonly string[];
  readonly buckets: readonly number[];
  readonly minimum: number;
  readonly maximum: number;
  readonly average: number;
  readonly p50: number;
  readonly p99: number;
  readonly missingMarketKeys: readonly string[];
}

interface MutableMemoValue {
  value: unknown;
  storedAt: number;
  expiresAt: number;
  hits: number;
  lastAccessAt: number;
}

const memoKey = (value: string): string => {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_./:-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`invalid market memo key: ${value}`);
  }
  return normalized;
};

const quantile = (ordered: readonly number[], fraction: number): number => {
  if (ordered.length === 0) return 0;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower)
  );
};

/** A small TTL memo for market metadata; concurrent misses are intentionally independent. */
export class MarketMemo {
  private readonly memoValues = new Map<string, MutableMemoValue>();

  public constructor(
    private readonly clock: () => number = Date.now,
    private readonly maximumEntries = 2_048,
  ) {
    if (!Number.isFinite(clock()))
      throw new RangeError("clock must return a finite value");
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError("maximumEntries must be a positive integer");
    }
  }

  public async read<T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs = 2_000,
  ): Promise<T> {
    const normalized = memoKey(key);
    if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > 86_400_000) {
      throw new RangeError("ttlMs must be from 0 to 86400000");
    }
    const observedAt = this.clock();
    if (!Number.isFinite(observedAt))
      throw new RangeError("clock must return a finite value");
    const cached = this.memoValues.get(normalized);
    if (cached !== undefined && cached.expiresAt > observedAt) {
      cached.hits += 1;
      cached.lastAccessAt = observedAt;
      return cached.value as T;
    }

    const loaded = await loader();
    const storedAt = this.clock();
    if (!Number.isFinite(storedAt))
      throw new RangeError("clock must return a finite value");
    this.memoValues.set(normalized, {
      value: loaded,
      storedAt,
      expiresAt: storedAt + ttlMs,
      hits: cached?.hits ?? 0,
      lastAccessAt: storedAt,
    });

    if (this.memoValues.size > this.maximumEntries) {
      const victims = [...this.memoValues]
        .filter(([candidate]) => candidate !== normalized)
        .sort(
          (left, right) =>
            left[1].lastAccessAt - right[1].lastAccessAt ||
            left[1].hits - right[1].hits ||
            left[0].localeCompare(right[0]),
        );
      while (this.memoValues.size > this.maximumEntries && victims.length > 0) {
        const victim = victims.shift()!;
        this.memoValues.delete(victim[0]);
      }
    }
    return loaded;
  }

  public expire(now = this.clock()): number {
    if (!Number.isFinite(now)) throw new RangeError("now must be finite");
    const expired = [...this.memoValues]
      .filter(([, entry]) => entry.expiresAt <= now)
      .sort(
        (left, right) =>
          left[1].expiresAt - right[1].expiresAt ||
          left[0].localeCompare(right[0]),
      );
    let removed = 0;
    for (const [key] of expired) {
      if (this.memoValues.delete(key)) removed += 1;
    }
    return removed;
  }

  public groupKeys(): ReadonlyMap<string, readonly string[]> {
    const grouped = new Map<string, string[]>();
    for (const key of [...this.memoValues.keys()].sort()) {
      const separator = key.search(/[/:]/u);
      const prefix = separator < 0 ? key : key.slice(0, separator);
      const keys = grouped.get(prefix) ?? [];
      keys.push(key);
      grouped.set(prefix, keys);
    }
    const result = new Map<string, readonly string[]>();
    for (const [prefix, keys] of [...grouped].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      result.set(prefix, Object.freeze(keys));
    }
    return result;
  }

  public evaluateMemoPolicies(request: MarketMemoInput): MemoInspection {
    const key = memoKey(request.memoKey);
    if (!Number.isFinite(request.lookedUpAt)) {
      throw new RangeError("lookedUpAt must be finite");
    }
    const samples: number[] = [];
    const rejectedHints: string[] = [];
    for (const [name, rawValue] of Object.entries(request.memoHints)) {
      const value =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string" && rawValue.trim().length > 0
            ? Number(rawValue)
            : Number.NaN;
      if (!Number.isFinite(value)) {
        rejectedHints.push(name);
        continue;
      }
      samples.push(value);
    }
    samples.sort((left, right) => left - right);

    const bucketBounds = [
      0,
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128,
      256,
      512,
      1_024,
      Infinity,
    ];
    const buckets = new Array<number>(bucketBounds.length).fill(0);
    let sum = 0;
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      const index = bucketBounds.findIndex((bound) => magnitude <= bound);
      buckets[index < 0 ? buckets.length - 1 : index]! += 1;
      sum += sample;
    }

    const availableKeys = new Set(this.memoValues.keys());
    const missingMarketKeys: string[] = [];
    for (const candidate of request.marketKeys ?? []) {
      const normalized = memoKey(candidate);
      if (!availableKeys.has(normalized)) missingMarketKeys.push(normalized);
    }
    missingMarketKeys.sort();

    return Object.freeze({
      memoKey: key,
      numericHints: samples.length,
      rejectedHints: Object.freeze(rejectedHints.sort()),
      buckets: Object.freeze(buckets),
      minimum: samples[0] ?? 0,
      maximum: samples.at(-1) ?? 0,
      average: samples.length === 0 ? 0 : sum / samples.length,
      p50: quantile(samples, 0.5),
      p99: quantile(samples, 0.99),
      missingMarketKeys: Object.freeze(missingMarketKeys),
    });
  }
}
