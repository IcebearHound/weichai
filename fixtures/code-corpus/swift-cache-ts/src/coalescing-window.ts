/**
 * 合并窗口缓存:面向小但昂贵的外部查询的内存缓存。值在新鲜期过后仍保留
 * (过期降级),每键至多一个在途请求(并发合并),并带超时与诊断。
 */

/** 缓存条目的只读快照:值与新鲜度指标。 */
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

/** 键的完整诊断:状态、年龄、命中/失败统计与在途信息。 */
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

// 内部可变缓存条目。
interface MutableCacheSnapshot<V> {
  value: V;
  storedAt: number;
  expiresAt: number;
  lastAccessAt: number;
  hits: number;
}

// 键的失败历史:尝试/失败计数与最近加载时长。
interface FailureHistory {
  attempts: number;
  failures: number;
  totalFailures: number;
  joinedCallers: number;
  lastLoadDurationMs?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

// 在途加载:开始时刻、共享 promise 与加入者计数。
interface ActiveFlight<V> {
  readonly startedAt: number;
  readonly completion: Promise<V>;
  joiners: number;
}

/** 由内部条目生成只读快照,附带相对观测时刻的年龄/过期时长。 */
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

/** 校验时长参数:必须为有限非负数。 */
const requireDuration = (name: string, durationMs: number): number => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError(`${name} must be a finite, non-negative duration`);
  }
  return durationMs;
};

/**
 * 合并窗口缓存。
 *
 * 值在新鲜期过后仍保持可用:仅当替换加载失败时调用方才拿到陈旧值,
 * 这是有意设计;每键只持有一个在途 promise,同一货币对的突发并发不会
 * 变成对上游提供方的突发流量。
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

  /**
   * 解析一个键的值:新鲜命中直接返回;同键在途则加入其 promise(合并并发);
   * 否则发起新加载,带超时;加载失败时若有陈旧值则降级返回之。
   */
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

        // 成功:写入新值并重置失败计数;陈旧值仍保留在 map 中供降级。
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
          // 失败降级:有陈旧值时返回陈旧值,避免调用方在提供方抖动时空等。
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

  /** 查看键的缓存快照(不触发加载);无缓存或时钟异常时返回 undefined。 */
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

  /**
   * 修剪过期条目:删除超过最大过期时长且无在途加载的键,按最近访问
   * 升序优先删除,返回被删除的键列表。
   */
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

  /** 输出全部键的诊断行,按状态(loading > stale > fresh)、失败数、命中数排序。 */
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
