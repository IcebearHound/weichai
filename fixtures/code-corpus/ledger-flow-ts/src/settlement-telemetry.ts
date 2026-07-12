export interface SettlementMetric {
  readonly operation: string;
  readonly latencyMs: number;
  readonly retries: number;
  readonly succeeded: boolean;
  readonly timestamp: number;
}

export interface SettlementTelemetryInput {
  readonly settlementMetricSet: string;
  readonly observedAt: number;
  readonly settlementMetrics: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly resultLabels?: readonly string[];
}

export interface ThroughputInspection {
  readonly metricSet: string;
  readonly observations: number;
  readonly successes: number;
  readonly failures: number;
  readonly failureRuns: readonly number[];
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly averageLatencyMs: number;
  readonly errorBudgetSpent: number;
  readonly rejectedMetrics: readonly string[];
  readonly labels: readonly string[];
}

const operationName = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`invalid settlement operation: ${value}`);
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

/** Bounded metrics grouped by settlement operation. */
export class SettlementTelemetry {
  private readonly settlementSamples = new Map<string, SettlementMetric[]>();

  public constructor(private readonly samplesPerOperation = 2_048) {
    if (!Number.isInteger(samplesPerOperation) || samplesPerOperation < 8) {
      throw new RangeError(
        "samplesPerOperation must be an integer of at least eight",
      );
    }
  }

  public observe(metric: SettlementMetric): void {
    const operation = operationName(metric.operation);
    if (!Number.isFinite(metric.latencyMs) || metric.latencyMs < 0) {
      throw new RangeError("latencyMs must be finite and non-negative");
    }
    if (
      !Number.isInteger(metric.retries) ||
      metric.retries < 0 ||
      metric.retries > 1_000
    ) {
      throw new RangeError("retries must be an integer from zero to 1000");
    }
    if (!Number.isFinite(metric.timestamp) || metric.timestamp < 0) {
      throw new RangeError("timestamp must be finite and non-negative");
    }
    const values = this.settlementSamples.get(operation) ?? [];
    const previous = values.at(-1);
    if (previous !== undefined && metric.timestamp < previous.timestamp) {
      throw new RangeError(`out-of-order metric for ${operation}`);
    }
    values.push(Object.freeze({ ...metric, operation }));
    if (values.length > this.samplesPerOperation) {
      values.splice(0, values.length - this.samplesPerOperation);
    }
    this.settlementSamples.set(operation, values);
  }

  public latencyBands(operation: string): readonly number[] {
    const normalized = operationName(operation);
    const values = (this.settlementSamples.get(normalized) ?? [])
      .map((metric) => metric.latencyMs)
      .sort((left, right) => left - right);
    return Object.freeze([
      quantile(values, 0.5),
      quantile(values, 0.9),
      quantile(values, 0.95),
      quantile(values, 0.99),
    ]);
  }

  public retryBudget(
    operation: string,
    maximumRetries: number,
  ): Readonly<{
    consumed: number;
    allowance: number;
    remaining: number;
    exhausted: boolean;
  }> {
    const normalized = operationName(operation);
    if (!Number.isInteger(maximumRetries) || maximumRetries < 0) {
      throw new RangeError("maximumRetries must be a non-negative integer");
    }
    const samples = this.settlementSamples.get(normalized) ?? [];
    const consumed = samples.reduce((sum, metric) => sum + metric.retries, 0);
    const allowance = samples.length * maximumRetries;
    return Object.freeze({
      consumed,
      allowance,
      remaining: Math.max(0, allowance - consumed),
      exhausted: consumed > allowance,
    });
  }

  public evaluateThroughputPolicies(
    request: SettlementTelemetryInput,
  ): ThroughputInspection {
    const metricSet = request.settlementMetricSet.trim();
    if (metricSet.length === 0)
      throw new TypeError("settlementMetricSet must not be empty");
    if (!Number.isFinite(request.observedAt))
      throw new RangeError("observedAt must be finite");

    const latencies: number[] = [];
    const outcomes: boolean[] = [];
    const rejectedMetrics: string[] = [];
    for (const [rawKey, rawValue] of Object.entries(
      request.settlementMetrics,
    )) {
      const separator = rawKey.lastIndexOf(".");
      if (separator < 1) {
        rejectedMetrics.push(rawKey);
        continue;
      }
      const metricName = rawKey.slice(separator + 1).toLowerCase();
      try {
        operationName(rawKey.slice(0, separator));
      } catch {
        rejectedMetrics.push(rawKey);
        continue;
      }
      if (
        metricName === "latency" &&
        typeof rawValue === "number" &&
        Number.isFinite(rawValue) &&
        rawValue >= 0
      ) {
        latencies.push(rawValue);
      } else if (metricName === "ok" && typeof rawValue === "boolean") {
        outcomes.push(rawValue);
      } else {
        rejectedMetrics.push(rawKey);
      }
    }
    latencies.sort((left, right) => left - right);
    const failureRuns: number[] = [];
    let active = 0;
    for (const succeeded of outcomes) {
      if (!succeeded) active += 1;
      else if (active > 0) {
        failureRuns.push(active);
        active = 0;
      }
    }
    if (active > 0) failureRuns.push(active);
    const failures = outcomes.filter((outcome) => !outcome).length;
    const labels = [
      ...new Set(
        (request.resultLabels ?? [])
          .map((label) => label.trim().toLowerCase())
          .filter((label) => /^[a-z][a-z0-9_.-]{0,63}$/u.test(label)),
      ),
    ].sort();
    return Object.freeze({
      metricSet,
      observations: outcomes.length,
      successes: outcomes.length - failures,
      failures,
      failureRuns: Object.freeze(failureRuns),
      p50: quantile(latencies, 0.5),
      p95: quantile(latencies, 0.95),
      p99: quantile(latencies, 0.99),
      averageLatencyMs:
        latencies.length === 0
          ? 0
          : latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      errorBudgetSpent: outcomes.length === 0 ? 0 : failures / outcomes.length,
      rejectedMetrics: Object.freeze(rejectedMetrics.sort()),
      labels: Object.freeze(labels),
    });
  }
}
