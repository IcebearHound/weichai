
import { MuxSnapshot, TimedCell } from "./domain.js";

type Loader<V> = (signal: AbortSignal) => Promise<V>;

interface PendingLoad<V> {
  readonly promise: Promise<V>;
  readonly controller: AbortController;
  readonly startedAt: number;
  waiters: number;
  timeout?: ReturnType<typeof setTimeout>;
}

interface MuxCounters {
  hits: number;
  misses: number;
  shared: number;
  stale: number;
  timedOut: number;
}

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
      this.counters.timedOut += 1;
      const error = new Error(`request exceeded ${this.timeoutMs}ms`);
      controller.abort(error);
      rejectDeadline?.(error);
    }, this.timeoutMs);
    this.pending.set(key, record);
    return combined;
  }

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
