/**
 * 结算遥测:按结算操作分组的有界指标采集器,提供延迟分位、重试预算与
 * 吞吐策略评估。
 */

/** 单条结算指标:操作名、延迟、重试次数、成功标志与采集时刻。 */
export interface SettlementMetric {
  readonly operation: string;
  readonly latencyMs: number;
  readonly retries: number;
  readonly succeeded: boolean;
  readonly timestamp: number;
}

/** 吞吐策略评估的入参:指标集 ID、观测时刻、指标键值表与可选结果标签。 */
export interface SettlementTelemetryInput {
  readonly settlementMetricSet: string;
  readonly observedAt: number;
  readonly settlementMetrics: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly resultLabels?: readonly string[];
}

/** 吞吐策略评估的结果:观测/成功/失败计数、失败连续段、延迟分位与错误预算。 */
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

/** 校验并规范化操作名:小写后必须匹配 [a-z][a-z0-9_.-]{0,127}。 */
const operationName = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`invalid settlement operation: ${value}`);
  }
  return normalized;
};

/** 对有序样本做线性插值分位数(延迟 p50/p95/p99 使用)。 */
const quantile = (ordered: readonly number[], fraction: number): number => {
  if (ordered.length === 0) return 0;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower)
  );
};

/**
 * 结算遥测采集器。
 *
 * 指标按操作分组存储,每组有容量上限(samplesPerOperation,超出丢弃最旧);
 * latencyBands 给出延迟分位带,retryBudget 核算重试配额,evaluateThroughput
 * Policies 评估吞吐与错误预算消耗。
 */
export class SettlementTelemetry {
  private readonly settlementSamples = new Map<string, SettlementMetric[]>();

  public constructor(private readonly samplesPerOperation = 2_048) {
    if (!Number.isInteger(samplesPerOperation) || samplesPerOperation < 8) {
      throw new RangeError(
        "samplesPerOperation must be an integer of at least eight",
      );
    }
  }

  /**
   * 采集一条结算指标:强制同一操作内时间戳单调递增;超过容量上限时丢弃
   * 最旧样本(有界窗口语义)。
   */
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

  /** 返回某操作的延迟分位带 [p50, p90, p95, p99]。 */
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

  /**
   * 核算某操作的重试预算:已消耗 = 样本重试次数之和,配额 = 样本数 ×
   * 每样本上限;返回剩余配额与是否超支。
   */
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

  /**
   * 评估吞吐策略:解析 "operation.latency"/"operation.ok" 键,统计成功率、
   * 失败连续段、延迟分位与错误预算消耗比例。
   */
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
    // 扫描成败序列,统计连续失败段长度(用于识别故障是否成簇)。
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
