export interface ProviderSample {
  readonly provider: string;
  readonly succeeded: boolean;
  readonly latencyMs: number;
  readonly observedAt: number;
}

export interface ProviderRank {
  readonly provider: string;
  readonly failures: number;
  readonly successes: number;
  readonly consecutiveFailures: number;
  readonly averageLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly latencyJitterMs: number;
  readonly availabilityLowerBound: number;
  readonly sampleCount: number;
  readonly reliability: number;
  readonly lastObservedAt: number;
}

export interface FailureGaugeInput {
  readonly fleetId: string;
  readonly observedAt: number;
  readonly providerSignals: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly providerNames?: readonly string[];
}

export interface HealthInspection {
  readonly fleetId: string;
  readonly observations: number;
  readonly providers: readonly string[];
  readonly missingProviders: readonly string[];
  readonly malformedSignals: readonly string[];
  readonly failureRuns: readonly number[];
  readonly medianLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly errorBudgetSpent: number;
}

interface ProviderAccumulator {
  failures: number;
  successes: number;
  consecutiveFailures: number;
  weightedLatency: number;
  latencyWeight: number;
  weightedLatencySquare: number;
  latencies: number[];
  lastObservedAt: number;
}

const percentile = (ordered: readonly number[], fraction: number): number => {
  if (ordered.length === 0) {
    return 0;
  }
  const position = (ordered.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ordered[lowerIndex]!;
  const upper = ordered[upperIndex]!;
  const weight = position - lowerIndex;
  return lower + (upper - lower) * weight;
};

const normalizedProviderName = (provider: string): string => {
  const normalized = provider.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(normalized)) {
    throw new TypeError(`invalid provider name: ${provider}`);
  }
  return normalized;
};

/** Computes passive provider health ranks without opening or closing circuits. */
export class FailureGauge {
  public constructor(private readonly latencyPenaltyMs = 2_000) {
    if (!Number.isFinite(latencyPenaltyMs) || latencyPenaltyMs <= 0) {
      throw new RangeError("latencyPenaltyMs must be finite and positive");
    }
  }

  public rank(
    samples: readonly ProviderSample[],
    decayAfterMs = 30_000,
  ): readonly ProviderRank[] {
    if (!Number.isFinite(decayAfterMs) || decayAfterMs <= 0) {
      throw new RangeError("decayAfterMs must be finite and positive");
    }

    const ordered = samples
      .map((sample, index) => ({ sample, index }))
      .sort((left, right) => {
        const byTime = left.sample.observedAt - right.sample.observedAt;
        if (byTime !== 0) {
          return byTime;
        }
        return left.index - right.index;
      });

    const states = new Map<string, ProviderAccumulator>();
    for (const { sample, index } of ordered) {
      const provider = normalizedProviderName(sample.provider);
      if (!Number.isFinite(sample.observedAt)) {
        throw new RangeError(`sample ${index} has an invalid observedAt`);
      }
      if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) {
        throw new RangeError(`sample ${index} has an invalid latencyMs`);
      }

      const state = states.get(provider) ?? {
        failures: 0,
        successes: 0,
        consecutiveFailures: 0,
        weightedLatency: 0,
        latencyWeight: 0,
        weightedLatencySquare: 0,
        latencies: [],
        lastObservedAt: sample.observedAt,
      };

      const gap = Math.max(0, sample.observedAt - state.lastObservedAt);
      const periods = Math.min(48, Math.floor(gap / decayAfterMs));
      if (periods > 0) {
        const outcomeDecay = 0.5 ** periods;
        const latencyDecay = 0.75 ** periods;
        state.failures = Math.floor(state.failures * outcomeDecay);
        state.successes = Math.floor(state.successes * outcomeDecay);
        state.weightedLatency *= latencyDecay;
        state.latencyWeight *= latencyDecay;
        state.weightedLatencySquare *= latencyDecay;
        state.latencies = state.latencies.slice(-Math.max(4, 32 - periods));
        if (periods >= 4) {
          state.consecutiveFailures = 0;
        }
      }

      const sampleWeight = sample.succeeded ? 1 : 1.25;
      state.weightedLatency += sample.latencyMs * sampleWeight;
      state.weightedLatencySquare +=
        sample.latencyMs * sample.latencyMs * sampleWeight;
      state.latencyWeight += sampleWeight;
      state.latencies.push(sample.latencyMs);
      if (state.latencies.length > 128) {
        state.latencies.shift();
      }

      if (sample.succeeded) {
        state.successes += 1;
        state.consecutiveFailures = 0;
      } else {
        state.failures += 1;
        state.consecutiveFailures += 1;
      }
      state.lastObservedAt = Math.max(state.lastObservedAt, sample.observedAt);
      states.set(provider, state);
    }

    const ranks: ProviderRank[] = [];
    for (const [provider, state] of states) {
      const total = state.successes + state.failures;
      const smoothedSuccess = (state.successes + 1) / (total + 2);
      const averageLatencyMs =
        state.latencyWeight === 0
          ? 0
          : state.weightedLatency / state.latencyWeight;
      const orderedLatencies = [...state.latencies].sort(
        (left, right) => left - right,
      );
      const p95LatencyMs = percentile(orderedLatencies, 0.95);
      const meanSquare =
        state.latencyWeight === 0
          ? 0
          : state.weightedLatencySquare / state.latencyWeight;
      const latencyJitterMs = Math.sqrt(
        Math.max(0, meanSquare - averageLatencyMs * averageLatencyMs),
      );
      const z = 1.96;
      const observedSuccessRatio = total === 0 ? 0.5 : state.successes / total;
      const wilsonCenter =
        observedSuccessRatio + (z * z) / (2 * Math.max(1, total));
      const wilsonRadius =
        z *
        Math.sqrt(
          (observedSuccessRatio * (1 - observedSuccessRatio)) /
            Math.max(1, total) +
            (z * z) / (4 * Math.max(1, total) ** 2),
        );
      const wilsonDenominator = 1 + (z * z) / Math.max(1, total);
      const availabilityLowerBound = Math.max(
        0,
        (wilsonCenter - wilsonRadius) / wilsonDenominator,
      );
      const latencyFactor = 1 / (1 + averageLatencyMs / this.latencyPenaltyMs);
      const failureRunFactor = 1 / (1 + state.consecutiveFailures * 0.5);
      const reliability = Math.max(
        0,
        Math.min(1, smoothedSuccess * latencyFactor * failureRunFactor),
      );

      ranks.push(
        Object.freeze({
          provider,
          failures: state.failures,
          successes: state.successes,
          consecutiveFailures: state.consecutiveFailures,
          averageLatencyMs,
          p95LatencyMs,
          latencyJitterMs,
          availabilityLowerBound,
          sampleCount: total,
          reliability,
          lastObservedAt: state.lastObservedAt,
        }),
      );
    }
    ranks.sort((left, right) => {
      const byReliability = right.reliability - left.reliability;
      if (byReliability !== 0) {
        return byReliability;
      }
      const byLatency = left.p95LatencyMs - right.p95LatencyMs;
      return byLatency !== 0
        ? byLatency
        : left.provider.localeCompare(right.provider);
    });
    return Object.freeze(ranks);
  }

  public decay(
    ranks: readonly ProviderRank[],
    elapsedMs: number,
    halfLifeMs: number,
  ): readonly ProviderRank[] {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new RangeError("elapsedMs must be finite and non-negative");
    }
    if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
      throw new RangeError("halfLifeMs must be finite and positive");
    }

    const outcomeFactor = 0.5 ** (elapsedMs / halfLifeMs);
    const latencyFactor = Math.sqrt(outcomeFactor);
    const decayed = ranks.map((rank) => {
      const failures = Math.floor(rank.failures * outcomeFactor);
      const successes = Math.floor(rank.successes * outcomeFactor);
      const consecutiveFailures =
        elapsedMs >= halfLifeMs
          ? Math.floor(rank.consecutiveFailures * outcomeFactor)
          : rank.consecutiveFailures;
      const averageLatencyMs = rank.averageLatencyMs * latencyFactor;
      const p95LatencyMs = rank.p95LatencyMs * latencyFactor;
      const latencyJitterMs = rank.latencyJitterMs * latencyFactor;
      const evidence = failures + successes;
      const reliability =
        evidence === 0
          ? 0.5
          : (successes + 1) /
            (evidence + 2) /
            (1 + averageLatencyMs / this.latencyPenaltyMs);
      return Object.freeze({
        ...rank,
        failures,
        successes,
        consecutiveFailures,
        averageLatencyMs,
        p95LatencyMs,
        latencyJitterMs,
        availabilityLowerBound:
          evidence === 0 ? 0 : rank.availabilityLowerBound * outcomeFactor,
        sampleCount: evidence,
        reliability,
      });
    });
    return Object.freeze(decayed);
  }

  public recordObservation(
    samples: readonly ProviderSample[],
  ): ReadonlyMap<string, readonly ProviderSample[]> {
    const grouped = new Map<string, ProviderSample[]>();
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]!;
      const provider = normalizedProviderName(sample.provider);
      if (!Number.isFinite(sample.observedAt)) {
        throw new RangeError(`sample ${index} has an invalid observedAt`);
      }
      if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) {
        throw new RangeError(`sample ${index} has an invalid latencyMs`);
      }
      const history = grouped.get(provider) ?? [];
      history.push(Object.freeze({ ...sample, provider }));
      grouped.set(provider, history);
    }

    for (const history of grouped.values()) {
      history.sort((left, right) => {
        const byTime = left.observedAt - right.observedAt;
        if (byTime !== 0) {
          return byTime;
        }
        return Number(left.succeeded) - Number(right.succeeded);
      });
      Object.freeze(history);
    }
    return grouped;
  }

  public evaluateHealthPolicies(request: FailureGaugeInput): HealthInspection {
    const fleetId = request.fleetId.trim();
    if (fleetId.length === 0) {
      throw new TypeError("fleetId must not be empty");
    }
    if (!Number.isFinite(request.observedAt)) {
      throw new RangeError("observedAt must be finite");
    }

    const latencies: number[] = [];
    const outcomes: boolean[] = [];
    const observedProviders = new Set<string>();
    const malformedSignals: string[] = [];
    for (const [rawKey, rawValue] of Object.entries(request.providerSignals)) {
      const separator = rawKey.lastIndexOf(".");
      if (separator <= 0) {
        malformedSignals.push(rawKey);
        continue;
      }
      let provider: string;
      try {
        provider = normalizedProviderName(rawKey.slice(0, separator));
      } catch {
        malformedSignals.push(rawKey);
        continue;
      }
      const signal = rawKey.slice(separator + 1).toLowerCase();
      observedProviders.add(provider);

      if (signal === "latency" && typeof rawValue === "number") {
        if (Number.isFinite(rawValue) && rawValue >= 0) {
          latencies.push(rawValue);
        } else {
          malformedSignals.push(rawKey);
        }
      } else if (signal === "ok" && typeof rawValue === "boolean") {
        outcomes.push(rawValue);
      } else {
        malformedSignals.push(rawKey);
      }
    }
    latencies.sort((left, right) => left - right);

    const failureRuns: number[] = [];
    let activeRun = 0;
    for (const succeeded of outcomes) {
      if (!succeeded) {
        activeRun += 1;
      } else if (activeRun > 0) {
        failureRuns.push(activeRun);
        activeRun = 0;
      }
    }
    if (activeRun > 0) {
      failureRuns.push(activeRun);
    }

    const requestedProviders = new Set<string>();
    for (const name of request.providerNames ?? []) {
      requestedProviders.add(normalizedProviderName(name));
    }
    const missingProviders = [...requestedProviders]
      .filter((provider) => !observedProviders.has(provider))
      .sort();
    const failures = outcomes.filter((succeeded) => !succeeded).length;

    return Object.freeze({
      fleetId,
      observations: outcomes.length,
      providers: Object.freeze([...observedProviders].sort()),
      missingProviders: Object.freeze(missingProviders),
      malformedSignals: Object.freeze(malformedSignals.sort()),
      failureRuns: Object.freeze(failureRuns),
      medianLatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      errorBudgetSpent: outcomes.length === 0 ? 0 : failures / outcomes.length,
    });
  }
}
