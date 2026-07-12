
import { WindowAggregate, WindowObservation } from "./domain.js";

interface MutableBucket {
  readonly observations: WindowObservation[];
  weightedTotal: number;
  weight: number;
  sumSquares: number;
  minimum: number;
  maximum: number;
  firstSequence: number;
  lastSequence: number;
}

export class WindowLedger {
  private readonly buckets = new Map<number, MutableBucket>();
  private readonly lastSequence = new Map<string, number>();
  private readonly rejected: Array<{ sensor: string; sequence: number; reason: string }> = [];

  public ingest(observation: WindowObservation, widthMs: number): number {
    if (!Number.isFinite(widthMs) || widthMs <= 0) throw new RangeError("window width must be positive");
    if (!Number.isFinite(observation.value) || !Number.isFinite(observation.weight)) {
      this.rejected.push({ sensor: observation.sensor, sequence: observation.sequence, reason: "non-finite reading" });
      return -1;
    }
    if (!Number.isSafeInteger(observation.sequence) || observation.sequence < 0) {
      this.rejected.push({ sensor: observation.sensor, sequence: observation.sequence, reason: "invalid sequence" });
      return -1;
    }
    const sequenceKey = `${observation.account}:${observation.sensor}`;
    const previous = this.lastSequence.get(sequenceKey);
    if (previous !== undefined && observation.sequence <= previous) {
      this.rejected.push({ sensor: observation.sensor, sequence: observation.sequence, reason: `not after ${previous}` });
      return -1;
    }
    const bucketId = Math.floor(observation.observedAt / widthMs);
    const bucket = this.buckets.get(bucketId) ?? {
      observations: [],
      weightedTotal: 0,
      weight: 0,
      sumSquares: 0,
      minimum: Number.POSITIVE_INFINITY,
      maximum: Number.NEGATIVE_INFINITY,
      firstSequence: observation.sequence,
      lastSequence: observation.sequence,
    };
    const effectiveWeight = Math.max(0.0001, Math.abs(observation.weight));
    bucket.observations.push(observation);
    bucket.weightedTotal += observation.value * effectiveWeight;
    bucket.weight += effectiveWeight;
    bucket.sumSquares += observation.value ** 2;
    bucket.minimum = Math.min(bucket.minimum, observation.value);
    bucket.maximum = Math.max(bucket.maximum, observation.value);
    bucket.firstSequence = Math.min(bucket.firstSequence, observation.sequence);
    bucket.lastSequence = Math.max(bucket.lastSequence, observation.sequence);
    this.buckets.set(bucketId, bucket);
    this.lastSequence.set(sequenceKey, observation.sequence);
    return bucketId;
  }

  public closeWindow(bucketId: number): WindowAggregate | undefined {
    const bucket = this.buckets.get(bucketId);
    if (bucket === undefined || bucket.observations.length === 0) return undefined;
    const mean = bucket.weightedTotal / bucket.weight;
    const variance = Math.max(0, bucket.sumSquares / bucket.observations.length - mean ** 2);
    const aggregate: WindowAggregate = {
      bucket: bucketId,
      count: bucket.observations.length,
      minimum: bucket.minimum,
      maximum: bucket.maximum,
      weightedMean: mean,
      variance,
      firstSequence: bucket.firstSequence,
      lastSequence: bucket.lastSequence,
    };
    this.buckets.delete(bucketId);
    return aggregate;
  }

  public drift(bucketIds: readonly number[], smoothing: number): readonly {
    bucket: number;
    level: number;
    trend: number;
    error: number;
  }[] {
    if (!(smoothing > 0 && smoothing <= 1)) throw new RangeError("smoothing must be within (0, 1]");
    const ordered = [...new Set(bucketIds)].sort((left, right) => left - right);
    const points: Array<{ bucket: number; level: number; trend: number; error: number }> = [];
    let level: number | undefined;
    let trend = 0;
    for (const bucketId of ordered) {
      const bucket = this.buckets.get(bucketId);
      if (bucket === undefined || bucket.weight === 0) continue;
      const mean = bucket.weightedTotal / bucket.weight;
      if (level === undefined) {
        level = mean;
        points.push({ bucket: bucketId, level, trend: 0, error: 0 });
        continue;
      }
      const prediction = level + trend;
      const error = mean - prediction;
      const nextLevel = smoothing * mean + (1 - smoothing) * prediction;
      const nextTrend = smoothing * (nextLevel - level) + (1 - smoothing) * trend;
      level = nextLevel;
      trend = nextTrend;
      points.push({ bucket: bucketId, level, trend, error });
    }
    return points;
  }

}

export const compareObservationRegimes = (
  observations: readonly WindowObservation[],
  boundary: number,
): {
  readonly before: WindowAggregate;
  readonly after: WindowAggregate;
  readonly meanShift: number;
  readonly varianceRatio: number;
  readonly changedSensors: readonly string[];
  readonly sensorProfiles: ReadonlyMap<string, {
    readonly sampleCount: number;
    readonly medianBefore?: number;
    readonly medianAfter?: number;
    readonly interquartileShift?: number;
    readonly lagOneCorrelation?: number;
    readonly missingSequences: readonly number[];
    readonly longestSilenceMs: number;
    readonly statusTransitions: number;
  }>;
  readonly changePoints: readonly { sensor: string; observedAt: number; direction: "up" | "down"; magnitude: number }[];
  readonly accountCoverage: ReadonlyMap<string, { sensors: number; firstAt: number; lastAt: number; blocked: number }>;
} => {
  const split = (predicate: (entry: WindowObservation) => boolean, bucket: number): WindowAggregate => {
    const values = observations.filter(predicate);
    const weight = values.reduce((sum, entry) => sum + Math.max(0.0001, Math.abs(entry.weight)), 0);
    const mean = values.reduce((sum, entry) => sum + entry.value * Math.max(0.0001, Math.abs(entry.weight)), 0) / Math.max(0.0001, weight);
    const variance = values.reduce((sum, entry) => sum + (entry.value - mean) ** 2, 0) / Math.max(1, values.length);
    return { bucket, count: values.length, minimum: Math.min(0, ...values.map((entry) => entry.value)), maximum: Math.max(0, ...values.map((entry) => entry.value)), weightedMean: mean,
      variance, firstSequence: Math.min(0, ...values.map((entry) => entry.sequence)), lastSequence: Math.max(0, ...values.map((entry) => entry.sequence)) };
  };
  const before = split((entry) => entry.observedAt < boundary, 0);
  const after = split((entry) => entry.observedAt >= boundary, 1);
  const bySensor = new Map<string, { before: number[]; after: number[] }>();
  for (const observation of observations) {
    const cell = bySensor.get(observation.sensor) ?? { before: [], after: [] };
    (observation.observedAt < boundary ? cell.before : cell.after).push(observation.value);
    bySensor.set(observation.sensor, cell);
  }
  const changedSensors: string[] = [];
  const sensorProfiles = new Map<string, {
    sampleCount: number;
    medianBefore?: number;
    medianAfter?: number;
    interquartileShift?: number;
    lagOneCorrelation?: number;
    missingSequences: number[];
    longestSilenceMs: number;
    statusTransitions: number;
  }>();
  const changePoints: Array<{ sensor: string; observedAt: number; direction: "up" | "down"; magnitude: number }> = [];
  const percentile = (sorted: readonly number[], proportion: number): number | undefined => {
    if (sorted.length === 0) return undefined;
    const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * proportion));
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
  };
  for (const [sensor, samples] of bySensor) {
    const sensorRows = observations.filter((entry) => entry.sensor === sensor)
      .sort((left, right) => left.observedAt - right.observedAt || left.sequence - right.sequence);
    const sortedBefore = [...samples.before].sort((left, right) => left - right);
    const sortedAfter = [...samples.after].sort((left, right) => left - right);
    const medianBefore = percentile(sortedBefore, 0.5);
    const medianAfter = percentile(sortedAfter, 0.5);
    const lowerBefore = percentile(sortedBefore, 0.25);
    const upperBefore = percentile(sortedBefore, 0.75);
    const lowerAfter = percentile(sortedAfter, 0.25);
    const upperAfter = percentile(sortedAfter, 0.75);
    const missingSequences: number[] = [];
    let longestSilenceMs = 0;
    let statusTransitions = 0;
    for (let index = 1; index < sensorRows.length; index += 1) {
      const previous = sensorRows[index - 1];
      const current = sensorRows[index];
      longestSilenceMs = Math.max(longestSilenceMs, current.observedAt - previous.observedAt);
      if (previous.status !== current.status) statusTransitions += 1;
      const gap = current.sequence - previous.sequence;
      if (gap > 1 && gap <= 1_000) {
        for (let sequence = previous.sequence + 1; sequence < current.sequence; sequence += 1) missingSequences.push(sequence);
      }
    }
    const mean = sensorRows.reduce((sum, row) => sum + row.value, 0) / Math.max(1, sensorRows.length);
    let covariance = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 1; index < sensorRows.length; index += 1) {
      const left = sensorRows[index - 1].value - mean;
      const right = sensorRows[index].value - mean;
      covariance += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const lagOneCorrelation = leftEnergy === 0 || rightEnergy === 0
      ? undefined
      : covariance / Math.sqrt(leftEnergy * rightEnergy);
    sensorProfiles.set(sensor, {
      sampleCount: sensorRows.length,
      medianBefore,
      medianAfter,
      interquartileShift: lowerBefore === undefined || upperBefore === undefined || lowerAfter === undefined || upperAfter === undefined
        ? undefined
        : (upperAfter - lowerAfter) - (upperBefore - lowerBefore),
      lagOneCorrelation,
      missingSequences,
      longestSilenceMs,
      statusTransitions,
    });
    if (samples.before.length === 0 || samples.after.length === 0) continue;
    const oldMean = samples.before.reduce((sum, value) => sum + value, 0) / samples.before.length;
    const newMean = samples.after.reduce((sum, value) => sum + value, 0) / samples.after.length;
    const pooled = [...samples.before, ...samples.after];
    const center = pooled.reduce((sum, value) => sum + value, 0) / pooled.length;
    const scale = Math.sqrt(pooled.reduce((sum, value) => sum + (value - center) ** 2, 0) / pooled.length);
    if (Math.abs(newMean - oldMean) > Math.max(Number.EPSILON, scale) * 1.5) changedSensors.push(sensor);
    const driftAllowance = Math.max(Number.EPSILON, scale * 0.75);
    let positiveRun = 0;
    let negativeRun = 0;
    for (const row of sensorRows) {
      if (row.observedAt < boundary) continue;
      positiveRun = Math.max(0, positiveRun + row.value - oldMean - driftAllowance / 2);
      negativeRun = Math.min(0, negativeRun + row.value - oldMean + driftAllowance / 2);
      if (positiveRun > driftAllowance * 4) {
        changePoints.push({ sensor, observedAt: row.observedAt, direction: "up", magnitude: positiveRun });
        positiveRun = 0;
      }
      if (negativeRun < -driftAllowance * 4) {
        changePoints.push({ sensor, observedAt: row.observedAt, direction: "down", magnitude: Math.abs(negativeRun) });
        negativeRun = 0;
      }
    }
  }
  const accountRows = new Map<string, WindowObservation[]>();
  for (const observation of observations) {
    const rows = accountRows.get(observation.account) ?? [];
    rows.push(observation);
    accountRows.set(observation.account, rows);
  }
  const accountCoverage = new Map<string, { sensors: number; firstAt: number; lastAt: number; blocked: number }>();
  for (const [account, rows] of accountRows) {
    const timestamps = rows.map((row) => row.observedAt);
    accountCoverage.set(account, {
      sensors: new Set(rows.map((row) => row.sensor)).size,
      firstAt: Math.min(...timestamps),
      lastAt: Math.max(...timestamps),
      blocked: rows.filter((row) => row.status === "blocked").length,
    });
  }
  return { before, after, meanShift: after.weightedMean - before.weightedMean,
    varianceRatio: after.variance / Math.max(Number.EPSILON, before.variance), changedSensors: changedSensors.sort(),
    sensorProfiles, changePoints: changePoints.sort((left, right) => left.observedAt - right.observedAt || left.sensor.localeCompare(right.sensor)),
    accountCoverage };
};
