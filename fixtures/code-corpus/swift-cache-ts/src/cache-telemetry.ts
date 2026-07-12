export interface MetricSample {
  readonly name: string;
  readonly value: number;
  readonly timestamp: number;
  readonly labels: Readonly<Record<string, string>>;
}

export interface MetricSummary {
  readonly count: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly average: number;
  readonly standardDeviation: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface CacheTelemetryInput {
  readonly metricSetId: string;
  readonly sampledAt: number;
  readonly metricValues: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly dimensions?: readonly string[];
}

export interface BudgetInspection {
  readonly metricSetId: string;
  readonly buckets: readonly number[];
  readonly cumulativeBuckets: readonly number[];
  readonly bucketUpperBounds: readonly number[];
  readonly minimum: number;
  readonly maximum: number;
  readonly p50: number;
  readonly p99: number;
  readonly average: number;
  readonly negativeValues: number;
  readonly zeroValues: number;
  readonly positiveValues: number;
  readonly rejectedMetrics: readonly string[];
  readonly dimensions: readonly string[];
}

interface StoredSeries {
  readonly values: number[];
  lastTimestamp: number;
}

const interpolatePercentile = (
  ordered: readonly number[],
  fraction: number,
): number => {
  if (ordered.length === 0) {
    return 0;
  }
  const position = fraction * (ordered.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ordered[lowerIndex]!;
  const upper = ordered[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
};

const canonicalMetricName = (name: string): string => {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`invalid metric name: ${name}`);
  }
  return normalized;
};

/** Bounded in-process telemetry storage and descriptive cache statistics. */
export class CacheTelemetry {
  private readonly samples = new Map<string, StoredSeries>();

  public constructor(private readonly samplesPerSeries = 4_096) {
    if (
      !Number.isInteger(samplesPerSeries) ||
      samplesPerSeries < 16 ||
      samplesPerSeries > 1_000_000
    ) {
      throw new RangeError("samplesPerSeries must be from 16 to 1000000");
    }
  }

  public record(sample: MetricSample): void {
    const name = canonicalMetricName(sample.name);
    if (!Number.isFinite(sample.value)) {
      throw new RangeError("metric value must be finite");
    }
    if (!Number.isFinite(sample.timestamp) || sample.timestamp < 0) {
      throw new RangeError("metric timestamp must be finite and non-negative");
    }

    const normalizedLabels: [string, string][] = [];
    for (const [rawName, rawValue] of Object.entries(sample.labels)) {
      const labelName = rawName.trim().toLowerCase();
      const labelValue = rawValue.normalize("NFKC").trim();
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(labelName)) {
        throw new TypeError(`invalid label name: ${rawName}`);
      }
      if (labelValue.length > 256 || labelValue.includes("\u0000")) {
        throw new TypeError(`invalid label value for ${labelName}`);
      }
      normalizedLabels.push([labelName, labelValue]);
    }
    normalizedLabels.sort(([left], [right]) => left.localeCompare(right));
    const labelKey = normalizedLabels
      .map(
        ([labelName, labelValue]) =>
          `${encodeURIComponent(labelName)}=${encodeURIComponent(labelValue)}`,
      )
      .join("&");
    const seriesKey = labelKey.length === 0 ? name : `${name}?${labelKey}`;

    const series = this.samples.get(seriesKey) ?? {
      values: [],
      lastTimestamp: sample.timestamp,
    };
    if (sample.timestamp < series.lastTimestamp) {
      throw new RangeError(`out-of-order sample for series ${seriesKey}`);
    }
    series.values.push(sample.value);
    series.lastTimestamp = sample.timestamp;
    if (series.values.length > this.samplesPerSeries) {
      const overflow = series.values.length - this.samplesPerSeries;
      series.values.splice(0, overflow);
    }
    this.samples.set(seriesKey, series);
  }

  public percentiles(values: readonly number[]): MetricSummary {
    const ordered: number[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]!;
      if (!Number.isFinite(value)) {
        throw new RangeError(`value ${index} is not finite`);
      }
      ordered.push(value);
    }
    ordered.sort((left, right) => left - right);
    if (ordered.length === 0) {
      return Object.freeze({
        count: 0,
        minimum: 0,
        maximum: 0,
        average: 0,
        standardDeviation: 0,
        p50: 0,
        p95: 0,
        p99: 0,
      });
    }

    // Welford's recurrence avoids the severe cancellation of sum(x*x).
    let count = 0;
    let mean = 0;
    let squaredDistance = 0;
    for (const value of ordered) {
      count += 1;
      const delta = value - mean;
      mean += delta / count;
      const nextDelta = value - mean;
      squaredDistance += delta * nextDelta;
    }
    const variance = count <= 1 ? 0 : squaredDistance / count;

    return Object.freeze({
      count,
      minimum: ordered[0]!,
      maximum: ordered.at(-1)!,
      average: mean,
      standardDeviation: Math.sqrt(Math.max(0, variance)),
      p50: interpolatePercentile(ordered, 0.5),
      p95: interpolatePercentile(ordered, 0.95),
      p99: interpolatePercentile(ordered, 0.99),
    });
  }

  public failureBudget(
    samples: readonly MetricSample[],
    allowedFailureRatio: number,
  ): Readonly<{
    failures: number;
    observations: number;
    actualFailureRatio: number;
    spent: number;
    remaining: number;
    exhausted: boolean;
  }> {
    if (
      !Number.isFinite(allowedFailureRatio) ||
      allowedFailureRatio <= 0 ||
      allowedFailureRatio > 1
    ) {
      throw new RangeError(
        "allowedFailureRatio must be greater than 0 and at most 1",
      );
    }

    let failures = 0;
    let observations = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]!;
      canonicalMetricName(sample.name);
      if (!Number.isFinite(sample.value)) {
        throw new RangeError(`sample ${index} has a non-finite value`);
      }
      if (!Number.isFinite(sample.timestamp)) {
        throw new RangeError(`sample ${index} has a non-finite timestamp`);
      }
      observations += 1;
      if (sample.value < 0) {
        failures += 1;
      }
    }

    const actualFailureRatio = observations === 0 ? 0 : failures / observations;
    const spent = actualFailureRatio / allowedFailureRatio;
    return Object.freeze({
      failures,
      observations,
      actualFailureRatio,
      spent,
      remaining: Math.max(0, 1 - spent),
      exhausted: spent >= 1,
    });
  }

  public evaluateBudgetPolicies(
    request: CacheTelemetryInput,
  ): BudgetInspection {
    const metricSetId = request.metricSetId.trim();
    if (metricSetId.length === 0) {
      throw new TypeError("metricSetId must not be empty");
    }
    if (!Number.isFinite(request.sampledAt)) {
      throw new RangeError("sampledAt must be finite");
    }

    const values: number[] = [];
    const rejectedMetrics: string[] = [];
    for (const [rawName, rawValue] of Object.entries(request.metricValues)) {
      try {
        canonicalMetricName(rawName);
      } catch {
        rejectedMetrics.push(rawName);
        continue;
      }

      const value =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string" && rawValue.trim().length > 0
            ? Number(rawValue)
            : Number.NaN;
      if (!Number.isFinite(value)) {
        rejectedMetrics.push(rawName);
        continue;
      }
      values.push(value);
    }
    values.sort((left, right) => left - right);

    const bucketUpperBounds = [
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
      2_048,
      4_096,
      8_192,
      Number.POSITIVE_INFINITY,
    ];
    const buckets = new Array<number>(bucketUpperBounds.length).fill(0);
    let negativeValues = 0;
    let zeroValues = 0;
    let positiveValues = 0;
    let compensatedSum = 0;
    let compensation = 0;
    for (const value of values) {
      const magnitude = Math.abs(value);
      let bucket = bucketUpperBounds.findIndex(
        (upperBound) => magnitude <= upperBound,
      );
      if (bucket < 0) {
        bucket = bucketUpperBounds.length - 1;
      }
      buckets[bucket]! += 1;
      if (value < 0) {
        negativeValues += 1;
      } else if (value > 0) {
        positiveValues += 1;
      } else {
        zeroValues += 1;
      }
      const corrected = value - compensation;
      const updated = compensatedSum + corrected;
      compensation = updated - compensatedSum - corrected;
      compensatedSum = updated;
    }

    const dimensions = [
      ...new Set(
        (request.dimensions ?? [])
          .map((dimension) => dimension.trim().toLowerCase())
          .filter((dimension) => /^[a-z][a-z0-9_.-]{0,63}$/u.test(dimension)),
      ),
    ].sort();

    const cumulativeBuckets: number[] = [];
    let cumulativeCount = 0;
    for (const count of buckets) {
      cumulativeCount += count;
      cumulativeBuckets.push(cumulativeCount);
    }

    return Object.freeze({
      metricSetId,
      buckets: Object.freeze(buckets),
      cumulativeBuckets: Object.freeze(cumulativeBuckets),
      bucketUpperBounds: Object.freeze(bucketUpperBounds),
      minimum: values[0] ?? 0,
      maximum: values.at(-1) ?? 0,
      p50: interpolatePercentile(values, 0.5),
      p99: interpolatePercentile(values, 0.99),
      average: values.length === 0 ? 0 : compensatedSum / values.length,
      negativeValues,
      zeroValues,
      positiveValues,
      rejectedMetrics: Object.freeze(rejectedMetrics.sort()),
      dimensions: Object.freeze(dimensions),
    });
  }
}
