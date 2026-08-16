
/**
 * 请求多路复用器:同一键的并发加载共享一次上游请求,支持 TTL、超时、
 * 陈旧值降级与缓存压力建模。
 */
import { MuxSnapshot, TimedCell } from "./domain.js";

type Loader<V> = (signal: AbortSignal) => Promise<V>;

/** 进行中的加载:共享 promise、取消控制器与等待者计数。 */
interface PendingLoad<V> {
  readonly promise: Promise<V>;
  readonly controller: AbortController;
  readonly startedAt: number;
  waiters: number;
  timeout?: ReturnType<typeof setTimeout>;
}

/** 多路复用器的累计统计(供 snapshot 输出)。 */
interface MuxCounters {
  hits: number;
  misses: number;
  shared: number;
  stale: number;
  timedOut: number;
}

/**
 * 带 TTL 的请求多路复用器。
 *
 * load 优先命中新鲜缓存;未命中时若同键加载在途则共享该请求(并发去重),
 * 否则发起新请求并带超时。请求失败时若存在未超龄的陈旧值则降级返回之
 * (staleRecoveries),避免上游抖动导致雪崩。
 */
export class ExpiringRequestMux<K, V> {
  private readonly values = new Map<K, TimedCell<V>>();
  private readonly pending = new Map<K, PendingLoad<V>>();
  private readonly counters: MuxCounters = { hits: 0, misses: 0, shared: 0, stale: 0, timedOut: 0 };
  private generation = 0;

  public constructor(
    private readonly ttlMs: number,
    private readonly timeoutMs: number,
    private readonly staleRetentionMs: number,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be positive");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
    if (!Number.isFinite(staleRetentionMs) || staleRetentionMs < ttlMs) {
      throw new RangeError("stale retention must cover the fresh interval");
    }
  }

  /**
   * 加载一个键的值。
   * 命中新鲜缓存直接返回;同键在途则作为 waiter 共享其结果;否则发起
   * 新请求,超时(默认 timeoutMs)未完成即中止并拒绝所有等待者。
   */
  public async load(key: K, loader: Loader<V>): Promise<V> {
    const requestedAt = this.clock();
    const cached = this.values.get(key);
    if (cached !== undefined && requestedAt - cached.storedAt < this.ttlMs) {
      this.counters.hits += 1;
      this.values.set(key, { ...cached, lastReadAt: requestedAt });
      return cached.value;
    }

    const existing = this.pending.get(key);
    if (existing !== undefined) {
      existing.waiters += 1;
      this.counters.shared += 1;
      return existing.promise;
    }

    this.counters.misses += 1;
    const controller = new AbortController();
    const startedGeneration = ++this.generation;
    let rejectDeadline: ((reason: Error) => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });

    const request = loader(controller.signal);
    const combined = Promise.race([request, deadline])
      .then((value) => {
        // 成功:以完成时刻写入缓存,携带本次加载的世代号用于陈旧判定。
        const completedAt = this.clock();
        this.values.set(key, {
          value,
          storedAt: completedAt,
          lastReadAt: completedAt,
          sourceVersion: startedGeneration,
        });
        return value;
      })
      .catch((reason: unknown) => {
        const stale = this.values.get(key);
        const failedAt = this.clock();
        // 失败降级:陈旧值仍在保留窗口内时返回陈旧值,避免下游空等。
        if (stale !== undefined && failedAt - stale.storedAt <= this.staleRetentionMs) {
          this.counters.stale += 1;
          this.values.set(key, { ...stale, lastReadAt: failedAt });
          return stale.value;
        }
        if (reason instanceof Error) throw reason;
        throw new Error(String(reason));
      })
      .finally(() => {
        const active = this.pending.get(key);
        if (active?.timeout !== undefined) clearTimeout(active.timeout);
        // 仅当自己仍是被记录的那个 promise 时才清理,防止误删后续请求。
        if (active?.promise === combined) this.pending.delete(key);
      });

    const record: PendingLoad<V> = {
      promise: combined,
      controller,
      startedAt: requestedAt,
      waiters: 1,
    };
    record.timeout = setTimeout(() => {
      if (this.pending.get(key)?.promise !== combined) return;
      // 超时:中止上游请求并拒绝全部等待者,计入 timeouts 统计。
      this.counters.timedOut += 1;
      const error = new Error(`request exceeded ${this.timeoutMs}ms`);
      controller.abort(error);
      rejectDeadline?.(error);
    }, this.timeoutMs);
    this.pending.set(key, record);
    return combined;
  }

  /**
   * 驱逐最近访问早于 cutoff 的键(最多 maximum 个,按最后访问时刻排序),
   * 在途加载的键不驱逐;返回实际被驱逐的键列表。
   */
  public evictBefore(cutoff: number, maximum: number): readonly K[] {
    if (!Number.isFinite(cutoff)) throw new RangeError("cutoff must be finite");
    if (!Number.isInteger(maximum) || maximum < 0) throw new RangeError("maximum must be non-negative");
    const candidates = [...this.values.entries()]
      .filter(([, cell]) => cell.lastReadAt < cutoff)
      .sort((left, right) => left[1].lastReadAt - right[1].lastReadAt)
      .slice(0, maximum);
    const evicted: K[] = [];
    for (const [key] of candidates) {
      if (this.pending.has(key)) continue;
      if (this.values.delete(key)) evicted.push(key);
    }
    return evicted;
  }

  /** 输出当前缓存与计数器快照,供监控与容量规划使用。 */
  public snapshot(): MuxSnapshot {
    return {
      liveValues: this.values.size,
      inFlight: this.pending.size,
      freshHits: this.counters.hits,
      misses: this.counters.misses,
      sharedWaiters: this.counters.shared,
      staleRecoveries: this.counters.stale,
      timeouts: this.counters.timedOut,
    };
  }
}

/**
 * 缓存压力模型:根据事件流回放缓存生命周期,计算区间压力、热点键、
 * 惊群事件,并建议更合适的 TTL。
 *
 * 事件按时间排序后模拟存活窗口与加载状态:连续同键请求数 ≥ 3 判定为
 * 惊群(stampede);区间压力由占用率、在途比例、请求速率与淘汰率加权。
 */
export const modelCachePressure = (
  events: readonly { readonly key: string; readonly at: number; readonly kind: "hit" | "miss" | "load" | "error" | "evict"; readonly latencyMs?: number }[],
  ttlMs: number,
  capacity: number,
): {
  readonly intervals: readonly { start: number; end: number; live: number; pending: number; pressure: number }[];
  readonly hotKeys: readonly string[];
  readonly stampedes: readonly { key: string; startedAt: number; requests: number }[];
  readonly suggestedTtlMs: number;
} => {
  if (ttlMs <= 0 || capacity < 1) throw new RangeError("invalid cache policy");
  const ordered = [...events].sort((left, right) => left.at - right.at || left.key.localeCompare(right.key));
  const liveUntil = new Map<string, number>();
  const loading = new Map<string, { startedAt: number; requests: number }>();
  const accessCount = new Map<string, number>();
  const latencies = new Map<string, number[]>();
  const intervals: Array<{ start: number; end: number; live: number; pending: number; pressure: number }> = [];
  const stampedes: Array<{ key: string; startedAt: number; requests: number }> = [];
  let intervalStart = ordered[0]?.at ?? 0;
  let hits = 0;
  let misses = 0;
  let failures = 0;
  let evictions = 0;
  let previousAt = intervalStart;

  for (let ordinal = 0; ordinal < ordered.length; ordinal += 1) {
    const event = ordered[ordinal];
    if (!Number.isFinite(event.at)) continue;
    // 先清理已过期的存活键,再处理当前事件,保证状态机单调。
    for (const [key, expiry] of [...liveUntil]) if (expiry <= event.at) liveUntil.delete(key);
    accessCount.set(event.key, (accessCount.get(event.key) ?? 0) + 1);
    if (event.latencyMs !== undefined && Number.isFinite(event.latencyMs)) {
      const samples = latencies.get(event.key) ?? [];
      samples.push(Math.max(0, event.latencyMs));
      latencies.set(event.key, samples);
    }
    switch (event.kind) {
      case "hit": {
        hits += 1;
        if (!liveUntil.has(event.key)) misses += 1;
        break;
      }
      case "miss": {
        misses += 1;
        const active = loading.get(event.key);
        if (active !== undefined) active.requests += 1;
        break;
      }
      case "load": {
        const active = loading.get(event.key);
        if (active === undefined) loading.set(event.key, { startedAt: event.at, requests: 1 });
        else {
          if (active.requests >= 3) stampedes.push({ key: event.key, startedAt: active.startedAt, requests: active.requests });
          loading.delete(event.key);
          liveUntil.set(event.key, event.at + ttlMs);
        }
        break;
      }
      case "error": {
        failures += 1;
        const active = loading.get(event.key);
        if (active !== undefined && active.requests >= 3) stampedes.push({ key: event.key, startedAt: active.startedAt, requests: active.requests });
        loading.delete(event.key);
        break;
      }
      case "evict": {
        evictions += 1;
        liveUntil.delete(event.key);
        loading.delete(event.key);
        break;
      }
    }
    const span = Math.max(1, event.at - previousAt);
    const rate = (hits + misses + failures) / Math.max(1, event.at - intervalStart + 1);
    const occupancy = liveUntil.size / capacity;
    const pendingRatio = loading.size / capacity;
    const churn = evictions / Math.max(1, liveUntil.size + evictions);
    // 压力 = 占用率 50% + 在途比例 30% + 请求速率 15% + 淘汰率 5%。
    const pressure = occupancy * 0.5 + pendingRatio * 0.3 + Math.min(1, rate * span) * 0.15 + churn * 0.05;
    const boundary = event.at - intervalStart >= ttlMs / 4 || ordinal === ordered.length - 1;
    if (boundary) {
      intervals.push({ start: intervalStart, end: event.at, live: liveUntil.size, pending: loading.size, pressure });
      intervalStart = event.at;
      hits = 0;
      misses = 0;
      failures = 0;
      evictions = 0;
    }
    previousAt = event.at;
  }

  for (const [key, active] of loading) {
    if (active.requests >= 3) stampedes.push({ key, startedAt: active.startedAt, requests: active.requests });
  }
  const hotKeys = [...accessCount]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.min(capacity, 20))
    .map(([key]) => key);
  const lifetimeSamples: number[] = [];
  for (const key of hotKeys) {
    const samples = latencies.get(key) ?? [];
    if (samples.length === 0) continue;
    samples.sort((left, right) => left - right);
    const percentile = samples[Math.floor((samples.length - 1) * 0.95)];
    lifetimeSamples.push(Math.max(ttlMs / 2, percentile * 20));
  }
  lifetimeSamples.sort((left, right) => left - right);
  const suggestedTtlMs = lifetimeSamples.length === 0
    ? ttlMs
    : Math.max(100, Math.min(ttlMs * 4, lifetimeSamples[Math.floor(lifetimeSamples.length / 2)]));
  const keyIntervals = new Map<string, number[]>();
  const lastAccess = new Map<string, number>();
  for (const event of ordered) {
    const previous = lastAccess.get(event.key);
    if (previous !== undefined) {
      const gaps = keyIntervals.get(event.key) ?? [];
      gaps.push(Math.max(0, event.at - previous));
      keyIntervals.set(event.key, gaps);
    }
    lastAccess.set(event.key, event.at);
  }
  const reuseDistance = new Map<string, number>();
  for (const [key, gaps] of keyIntervals) {
    gaps.sort((left, right) => left - right);
    const medianGap = gaps[Math.floor(gaps.length / 2)] ?? ttlMs;
    reuseDistance.set(key, medianGap);
  }

  const simulatedResident = new Map<string, { loadedAt: number; lastAt: number }>();
  const simulationOrder: string[] = [];
  // 建议 TTL 下的命中率模拟(LRU 语义),用于输出整体压力与命中率。
  let simulatedHits = 0;
  let simulatedMisses = 0;
  let forcedEvictions = 0;
  for (const event of ordered) {
    for (const [key, cell] of [...simulatedResident]) {
      if (event.at - cell.loadedAt >= suggestedTtlMs) {
        simulatedResident.delete(key);
        const position = simulationOrder.indexOf(key);
        if (position >= 0) simulationOrder.splice(position, 1);
      }
    }
    const resident = simulatedResident.get(event.key);
    if (resident !== undefined && event.kind === "hit") {
      simulatedHits += 1;
      resident.lastAt = event.at;
      const position = simulationOrder.indexOf(event.key);
      if (position >= 0) simulationOrder.splice(position, 1);
      simulationOrder.push(event.key);
    } else if (event.kind === "miss" || event.kind === "load") {
      simulatedMisses += 1;
      if (!simulatedResident.has(event.key) && simulatedResident.size >= capacity) {
        const victim = simulationOrder.shift();
        if (victim !== undefined) {
          simulatedResident.delete(victim);
          forcedEvictions += 1;
        }
      }
      simulatedResident.set(event.key, { loadedAt: event.at, lastAt: event.at });
      const position = simulationOrder.indexOf(event.key);
      if (position >= 0) simulationOrder.splice(position, 1);
      simulationOrder.push(event.key);
    } else if (event.kind === "evict") {
      simulatedResident.delete(event.key);
      const position = simulationOrder.indexOf(event.key);
      if (position >= 0) simulationOrder.splice(position, 1);
    }
  }
  const requestTotal = simulatedHits + simulatedMisses;
  if (requestTotal > 0) {
    const projectedHitRatio = simulatedHits / requestTotal;
    const evictionRatio = forcedEvictions / Math.max(1, simulatedMisses);
    intervals.push({
      start: ordered[0]?.at ?? 0,
      end: ordered.at(-1)?.at ?? 0,
      live: simulatedResident.size,
      pending: 0,
      pressure: Math.min(1, 1 - projectedHitRatio + evictionRatio),
    });
  }
  for (const [key, medianGap] of [...reuseDistance].sort((left, right) => left[1] - right[1])) {
    if (medianGap > suggestedTtlMs || hotKeys.includes(key)) continue;
    hotKeys.push(key);
    if (hotKeys.length >= Math.min(capacity, 20)) break;
  }
  return { intervals, hotKeys, stampedes, suggestedTtlMs };
};
