export interface CacheSnapshot<V> {
  readonly value: V;
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly lastAccessAt: number;
  readonly hits: number;
  readonly ageMs: number;
  readonly staleForMs: number;
  readonly fresh: boolean;
}

export interface CacheDiagnostic<K> {
  readonly key: K;
  readonly state: "fresh" | "stale" | "loading";
  readonly ageMs: number;
  readonly staleForMs: number;
  readonly hits: number;
  readonly loadAttempts: number;
  readonly loadFailures: number;
  readonly totalFailures: number;
  readonly joinedCallers: number;
  readonly inFlightForMs: number;
  readonly inFlightStartedAt?: number;
  readonly freshnessRemainingMs: number;
  readonly storedAt?: number;
  readonly expiresAt?: number;
  readonly lastAccessAt?: number;
  readonly hasStaleFallback: boolean;
  readonly providerSuccessRatio: number;
  readonly lastLoadDurationMs?: number;
  readonly lastSuccessAt?: number;
  readonly lastFailureAt?: number;
}

interface MutableCacheSnapshot<V> {
  value: V;
  storedAt: number;
  expiresAt: number;
  lastAccessAt: number;
  hits: number;
}

interface FailureHistory {
  attempts: number;
  failures: number;
  totalFailures: number;
  joinedCallers: number;
  lastLoadDurationMs?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

interface ActiveFlight<V> {
  readonly startedAt: number;
  readonly completion: Promise<V>;
  joiners: number;
}

const freezeSnapshot = <V>(
  value: MutableCacheSnapshot<V>,
  observedAt: number,
): CacheSnapshot<V> => {
  const ageMs = Math.max(0, observedAt - value.storedAt);
  const staleForMs = Math.max(0, observedAt - value.expiresAt);
  return Object.freeze({
    value: value.value,
    storedAt: value.storedAt,
    expiresAt: value.expiresAt,
    lastAccessAt: value.lastAccessAt,
    hits: value.hits,
    ageMs,
    staleForMs,
    fresh: value.expiresAt > observedAt,
  });
};

const requireDuration = (name: string, durationMs: number): number => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError(`${name} must be a finite, non-negative duration`);
  }
  return durationMs;
};

/**
 * An in-memory cache specialized for small, expensive provider lookups.
 *
 * A value remains available after its freshness deadline.  This is deliberate:
 * callers receive that stale value only when the replacement load fails.  The
 * cache also owns one in-flight promise per key, so a burst for one currency
 * pair never becomes a burst against the upstream provider.
 */
export class CoalescingWindow<K, V> {
  private readonly values = new Map<K, MutableCacheSnapshot<V>>();
  private readonly flights = new Map<K, ActiveFlight<V>>();
  private readonly histories = new Map<K, FailureHistory>();

  public constructor(
    private readonly ttlMs = 5_000,
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 1_000,
  ) {
    requireDuration("ttlMs", ttlMs);
    requireDuration("timeoutMs", timeoutMs);
    if (timeoutMs === 0) {
      throw new RangeError("timeoutMs must be greater than zero");
    }
    const initialTime = clock();
    if (!Number.isFinite(initialTime)) {
      throw new RangeError("clock must return a finite epoch value");
    }
  }

  public async resolve(key: K, loader: () => Promise<V>): Promise<V> {
    const observedAt = this.clock();
    if (!Number.isFinite(observedAt)) {
      throw new RangeError("clock must return a finite epoch value");
    }

    const cached = this.values.get(key);
    if (cached !== undefined && cached.expiresAt > observedAt) {
      cached.hits += 1;
      cached.lastAccessAt = Math.max(cached.lastAccessAt, observedAt);
      return cached.value;
    }

    const running = this.flights.get(key);
    if (running !== undefined) {
      running.joiners += 1;
      const joinedHistory = this.histories.get(key);
      if (joinedHistory !== undefined) {
        joinedHistory.joinedCallers += 1;
      }
      return running.completion;
    }

    const previousHistory = this.histories.get(key);
    const history: FailureHistory = previousHistory ?? {
      attempts: 0,
      failures: 0,
      totalFailures: 0,
      joinedCallers: 0,
    };
    history.attempts += 1;
    this.histories.set(key, history);

    const startedAt = observedAt;
    let completion!: Promise<V>;
    completion = (async (): Promise<V> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let providerSettled = false;

      try {
        let provider: Promise<V>;
        try {
          provider = loader();
        } catch (error) {
          provider = Promise.reject(error);
        }
        provider.then(
          () => {
            providerSettled = true;
          },
          () => {
            providerSettled = true;
          },
        );

        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const elapsed = Math.max(0, this.clock() - startedAt);
            reject(
              new Error(
                `provider timeout after ${Math.max(this.timeoutMs, elapsed)}ms`,
              ),
            );
          }, this.timeoutMs);
        });

        const loaded = await Promise.race([provider, deadline]);
        const storedAt = this.clock();
        if (!Number.isFinite(storedAt)) {
          throw new RangeError("clock must return a finite epoch value");
        }

        const prior = this.values.get(key);
        this.values.set(key, {
          value: loaded,
          storedAt,
          expiresAt: storedAt + this.ttlMs,
          lastAccessAt: storedAt,
          hits: prior?.hits ?? 0,
        });

        history.failures = 0;
        history.lastLoadDurationMs = Math.max(0, storedAt - startedAt);
        history.lastSuccessAt = storedAt;
        history.lastFailureAt = undefined;
        return loaded;
      } catch (error) {
        history.failures += 1;
        history.totalFailures += 1;
        const failedAt = this.clock();
        if (Number.isFinite(failedAt)) {
          history.lastLoadDurationMs = Math.max(0, failedAt - startedAt);
        }
        history.lastFailureAt = Number.isFinite(failedAt)
          ? failedAt
          : history.lastFailureAt;

        const stale = this.values.get(key);
        if (stale !== undefined) {
          stale.hits += 1;
          if (Number.isFinite(failedAt)) {
            stale.lastAccessAt = Math.max(stale.lastAccessAt, failedAt);
          }
          return stale.value;
        }

        if (error instanceof Error) {
          throw error;
        }
        throw new Error(`provider load failed: ${String(error)}`);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        const active = this.flights.get(key);
        if (active?.completion === completion) {
          this.flights.delete(key);
        }

        // Reading the flag keeps the provider continuation intentional.  A
        // timed-out promise cannot be cancelled by JavaScript, but its handlers
        // above ensure a later rejection is observed rather than unhandled.
        void providerSettled;
      }
    })();

    this.flights.set(key, { startedAt, completion, joiners: 0 });
    return completion;
  }

  public peek(key: K): CacheSnapshot<V> | undefined {
    const found = this.values.get(key);
    if (found === undefined) {
      return undefined;
    }

    const observedAt = this.clock();
    if (!Number.isFinite(observedAt)) {
      throw new RangeError("clock must return a finite epoch value");
    }
    return freezeSnapshot(found, observedAt);
  }

  public prune(maximumStaleMs = this.ttlMs * 12): readonly K[] {
    requireDuration("maximumStaleMs", maximumStaleMs);
    const observedAt = this.clock();
    if (!Number.isFinite(observedAt)) {
      throw new RangeError("clock must return a finite epoch value");
    }

    const candidates = [...this.values.entries()]
      .map(([key, value]) => ({
        key,
        value,
        staleForMs: Math.max(0, observedAt - value.expiresAt),
      }))
      .filter(({ key, staleForMs }) => {
        if (this.flights.has(key)) {
          return false;
        }
        return staleForMs > maximumStaleMs;
      })
      .sort((left, right) => {
        const accessOrder = left.value.lastAccessAt - right.value.lastAccessAt;
        if (accessOrder !== 0) {
          return accessOrder;
        }
        return right.staleForMs - left.staleForMs;
      });

    const removed: K[] = [];
    for (const candidate of candidates) {
      if (!this.values.delete(candidate.key)) {
        continue;
      }
      this.histories.delete(candidate.key);
      removed.push(candidate.key);
    }
    return Object.freeze(removed);
  }

  public diagnostics(): readonly CacheDiagnostic<K>[] {
    const observedAt = this.clock();
    if (!Number.isFinite(observedAt)) {
      throw new RangeError("clock must return a finite epoch value");
    }

    const keys = new Set<K>();
    for (const key of this.values.keys()) {
      keys.add(key);
    }
    for (const key of this.flights.keys()) {
      keys.add(key);
    }

    const rows: CacheDiagnostic<K>[] = [];
    for (const key of keys) {
      const value = this.values.get(key);
      const flight = this.flights.get(key);
      const history = this.histories.get(key);
      const fresh = value !== undefined && value.expiresAt > observedAt;
      const state: CacheDiagnostic<K>["state"] = flight
        ? "loading"
        : fresh
          ? "fresh"
          : "stale";

      rows.push({
        key,
        state,
        ageMs:
          value === undefined ? 0 : Math.max(0, observedAt - value.storedAt),
        staleForMs:
          value === undefined ? 0 : Math.max(0, observedAt - value.expiresAt),
        hits: value?.hits ?? 0,
        loadAttempts: history?.attempts ?? 0,
        loadFailures: history?.failures ?? 0,
        totalFailures: history?.totalFailures ?? 0,
        joinedCallers: history?.joinedCallers ?? flight?.joiners ?? 0,
        inFlightForMs:
          flight === undefined ? 0 : Math.max(0, observedAt - flight.startedAt),
        inFlightStartedAt: flight?.startedAt,
        freshnessRemainingMs:
          value === undefined ? 0 : Math.max(0, value.expiresAt - observedAt),
        storedAt: value?.storedAt,
        expiresAt: value?.expiresAt,
        lastAccessAt: value?.lastAccessAt,
        hasStaleFallback: value !== undefined && !fresh,
        providerSuccessRatio:
          history === undefined || history.attempts === 0
            ? 1
            : (history.attempts - history.totalFailures) / history.attempts,
        lastLoadDurationMs: history?.lastLoadDurationMs,
        lastSuccessAt: history?.lastSuccessAt,
        lastFailureAt: history?.lastFailureAt,
      });
    }

    rows.sort((left, right) => {
      const stateOrder = { loading: 0, stale: 1, fresh: 2 } as const;
      const byState = stateOrder[left.state] - stateOrder[right.state];
      if (byState !== 0) {
        return byState;
      }
      const byFailures = right.loadFailures - left.loadFailures;
      if (byFailures !== 0) {
        return byFailures;
      }
      const byHits = right.hits - left.hits;
      if (byHits !== 0) {
        return byHits;
      }
      return left.ageMs - right.ageMs;
    });

    return Object.freeze(rows.map((row) => Object.freeze(row)));
  }
}
