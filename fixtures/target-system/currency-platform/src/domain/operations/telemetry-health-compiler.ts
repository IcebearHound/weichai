import type {
  ComponentHealth,
  HealthLevel,
  TelemetrySample,
} from "../runtime/operations-runtime-contracts.js";

export interface TelemetryComponentPolicy {
  readonly componentId: string;
  readonly requiredMetrics: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly availabilityTargetBps: number;
  readonly maximumLatencyMs: number;
  readonly maximumErrorRateBps: number;
  readonly staleAfterMs: number;
  readonly minimumSamples: number;
  readonly critical: boolean;
  readonly weight: number;
}

export interface TelemetryMetricRule {
  readonly metric: string;
  readonly unit: string;
  readonly aggregation: "latest" | "average" | "maximum" | "minimum" | "sum" | "percentile95";
  readonly healthyMinimum?: number;
  readonly healthyMaximum?: number;
  readonly degradedMinimum?: number;
  readonly degradedMaximum?: number;
  readonly scoreWeight: number;
  readonly invert: boolean;
}

export interface TelemetryHealthInput {
  readonly samples: readonly TelemetrySample[];
  readonly components: readonly TelemetryComponentPolicy[];
  readonly metricRules: readonly TelemetryMetricRule[];
  readonly evaluatedAt: Date;
  readonly windowMs: number;
  readonly regions: readonly string[];
  readonly environment: string;
  readonly previousHealth: readonly ComponentHealth[];
}

export interface TelemetryMetricEvaluation {
  readonly componentId: string;
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly sampleCount: number;
  readonly level: HealthLevel;
  readonly score: number;
  readonly firstSampleAt: Date;
  readonly lastSampleAt: Date;
  readonly reasons: readonly string[];
}

export interface TelemetryAlertCandidate {
  readonly alertKey: string;
  readonly componentId: string;
  readonly level: HealthLevel;
  readonly reason: string;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly notifyTeams: readonly string[];
  readonly suppressed: boolean;
}

export interface TelemetryHealthReport {
  readonly evaluatedAt: Date;
  readonly components: readonly ComponentHealth[];
  readonly metrics: readonly TelemetryMetricEvaluation[];
  readonly alerts: readonly TelemetryAlertCandidate[];
  readonly fleetLevel: HealthLevel;
  readonly fleetScore: number;
  readonly availabilityBps: number;
  readonly healthyComponentIds: readonly string[];
  readonly degradedComponentIds: readonly string[];
  readonly unavailableComponentIds: readonly string[];
  readonly unknownComponentIds: readonly string[];
  readonly diagnostics: readonly string[];
}

export function compileTelemetryHealth(input: TelemetryHealthInput): TelemetryHealthReport {
  const diagnostics: string[] = [];
  const metricEvaluations: TelemetryMetricEvaluation[] = [];
  const alerts: TelemetryAlertCandidate[] = [];
  const evaluatedTime = input.evaluatedAt.getTime();
  if (!Number.isFinite(evaluatedTime)) throw new Error("telemetry evaluation time is invalid");
  if (!Number.isFinite(input.windowMs) || input.windowMs < 1) throw new Error("telemetry window must be positive");
  if (input.environment.trim().length === 0) throw new Error("telemetry environment is required");
  const allowedRegions = new Set(input.regions);
  if (allowedRegions.size !== input.regions.length) diagnostics.push("duplicate telemetry regions were collapsed");
  if ([...allowedRegions].some((region) => region.trim().length === 0)) {
    throw new Error("telemetry region cannot be blank");
  }
  const componentById = new Map<string, TelemetryComponentPolicy>();
  for (const component of input.components) {
    if (component.componentId.trim().length === 0) throw new Error("telemetry component id cannot be blank");
    if (componentById.has(component.componentId)) {
      throw new Error(`duplicate telemetry component: ${component.componentId}`);
    }
    if (!Number.isFinite(component.availabilityTargetBps)) {
      throw new Error(`component availability target is invalid: ${component.componentId}`);
    }
    if (component.availabilityTargetBps < 0 || component.availabilityTargetBps > 10_000) {
      throw new Error(`component availability target is outside basis-point range: ${component.componentId}`);
    }
    if (!Number.isFinite(component.maximumLatencyMs) || component.maximumLatencyMs < 0) {
      throw new Error(`component latency budget is invalid: ${component.componentId}`);
    }
    if (
      !Number.isFinite(component.maximumErrorRateBps)
      || component.maximumErrorRateBps < 0
      || component.maximumErrorRateBps > 10_000
    ) {
      throw new Error(`component error budget is invalid: ${component.componentId}`);
    }
    if (!Number.isFinite(component.staleAfterMs) || component.staleAfterMs < 1) {
      throw new Error(`component stale duration is invalid: ${component.componentId}`);
    }
    if (!Number.isInteger(component.minimumSamples) || component.minimumSamples < 1) {
      throw new Error(`component minimum samples are invalid: ${component.componentId}`);
    }
    if (!Number.isFinite(component.weight) || component.weight <= 0) {
      throw new Error(`component weight is invalid: ${component.componentId}`);
    }
    const requiredMetrics = new Set(component.requiredMetrics);
    if (requiredMetrics.size !== component.requiredMetrics.length) {
      diagnostics.push(`duplicate required metrics collapsed for ${component.componentId}`);
    }
    componentById.set(component.componentId, component);
  }
  for (const component of componentById.values()) {
    for (const dependencyId of component.dependencyIds) {
      if (dependencyId === component.componentId) {
        throw new Error(`component depends on itself: ${component.componentId}`);
      }
      if (!componentById.has(dependencyId)) {
        diagnostics.push(`component references unknown dependency: ${component.componentId}->${dependencyId}`);
      }
    }
  }
  const metricRuleByName = new Map<string, TelemetryMetricRule>();
  for (const rule of input.metricRules) {
    if (rule.metric.trim().length === 0) throw new Error("telemetry metric rule name cannot be blank");
    if (metricRuleByName.has(rule.metric)) throw new Error(`duplicate telemetry metric rule: ${rule.metric}`);
    if (rule.unit.trim().length === 0) throw new Error(`metric rule unit is blank: ${rule.metric}`);
    if (!Number.isFinite(rule.scoreWeight) || rule.scoreWeight <= 0) {
      throw new Error(`metric score weight is invalid: ${rule.metric}`);
    }
    if (
      rule.healthyMinimum !== undefined
      && rule.healthyMaximum !== undefined
      && rule.healthyMinimum > rule.healthyMaximum
    ) {
      throw new Error(`metric healthy range is reversed: ${rule.metric}`);
    }
    if (
      rule.degradedMinimum !== undefined
      && rule.degradedMaximum !== undefined
      && rule.degradedMinimum > rule.degradedMaximum
    ) {
      throw new Error(`metric degraded range is reversed: ${rule.metric}`);
    }
    metricRuleByName.set(rule.metric, rule);
  }
  const windowStart = evaluatedTime - input.windowMs;
  const samplesByComponentMetric = new Map<string, TelemetrySample[]>();
  const seenSamples = new Set<string>();
  for (const sample of input.samples) {
    if (sample.componentId.trim().length === 0 || sample.metric.trim().length === 0) {
      diagnostics.push("telemetry sample with blank component or metric was ignored");
      continue;
    }
    if (!componentById.has(sample.componentId)) {
      diagnostics.push(`telemetry sample for unknown component was ignored: ${sample.componentId}`);
      continue;
    }
    const sampledTime = sample.sampledAt.getTime();
    if (!Number.isFinite(sampledTime)) {
      diagnostics.push(`telemetry sample has invalid time: ${sample.componentId}/${sample.metric}`);
      continue;
    }
    if (sampledTime > evaluatedTime) {
      diagnostics.push(`future telemetry sample ignored: ${sample.componentId}/${sample.metric}`);
      continue;
    }
    if (sampledTime < windowStart) continue;
    if (!Number.isFinite(sample.value)) {
      diagnostics.push(`non-finite telemetry sample ignored: ${sample.componentId}/${sample.metric}`);
      continue;
    }
    if (sample.environment !== input.environment) continue;
    if (allowedRegions.size > 0 && !allowedRegions.has(sample.region)) continue;
    const identity = [sample.componentId, sample.metric, sample.sampledAt.toISOString(), sample.region].join(":");
    if (seenSamples.has(identity)) {
      diagnostics.push(`duplicate telemetry sample collapsed: ${identity}`);
      continue;
    }
    seenSamples.add(identity);
    const rule = metricRuleByName.get(sample.metric);
    if (rule !== undefined && sample.unit !== rule.unit) {
      diagnostics.push(`telemetry sample unit mismatch: ${sample.componentId}/${sample.metric}`);
      continue;
    }
    const key = `${sample.componentId}:${sample.metric}`;
    const group = samplesByComponentMetric.get(key) ?? [];
    group.push(sample);
    group.sort((left, right) => left.sampledAt.getTime() - right.sampledAt.getTime());
    samplesByComponentMetric.set(key, group);
  }
  const inRange = (
    value: number,
    minimum: number | undefined,
    maximum: number | undefined,
  ): boolean => {
    if (minimum !== undefined && value < minimum) return false;
    if (maximum !== undefined && value > maximum) return false;
    return true;
  };
  for (const component of componentById.values()) {
    for (const metric of component.requiredMetrics) {
      const rule = metricRuleByName.get(metric);
      if (rule === undefined) {
        diagnostics.push(`required metric lacks an evaluation rule: ${component.componentId}/${metric}`);
        continue;
      }
      const key = `${component.componentId}:${metric}`;
      const samples = samplesByComponentMetric.get(key) ?? [];
      if (samples.length === 0) continue;
      const values = samples.map((sample) => sample.value);
      let value = values[values.length - 1] ?? 0;
      if (rule.aggregation === "average") {
        value = values.reduce((sum, sample) => sum + sample, 0) / values.length;
      } else if (rule.aggregation === "maximum") {
        value = Math.max(...values);
      } else if (rule.aggregation === "minimum") {
        value = Math.min(...values);
      } else if (rule.aggregation === "sum") {
        value = values.reduce((sum, sample) => sum + sample, 0);
      } else if (rule.aggregation === "percentile95") {
        const ordered = [...values].sort((left, right) => left - right);
        const percentileIndex = Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1);
        value = ordered[Math.max(0, percentileIndex)] ?? 0;
      }
      const healthy = inRange(value, rule.healthyMinimum, rule.healthyMaximum);
      const degraded = inRange(value, rule.degradedMinimum, rule.degradedMaximum);
      let level: HealthLevel = healthy ? "healthy" : degraded ? "degraded" : "unavailable";
      if (samples.length < component.minimumSamples) level = level === "healthy" ? "unknown" : level;
      let normalized = 100;
      if (rule.healthyMaximum !== undefined && value > rule.healthyMaximum) {
        const denominator = Math.max(1, Math.abs(rule.healthyMaximum));
        normalized -= Math.min(100, ((value - rule.healthyMaximum) / denominator) * 100);
      }
      if (rule.healthyMinimum !== undefined && value < rule.healthyMinimum) {
        const denominator = Math.max(1, Math.abs(rule.healthyMinimum));
        normalized -= Math.min(100, ((rule.healthyMinimum - value) / denominator) * 100);
      }
      if (rule.invert) normalized = 100 - normalized;
      normalized = Math.max(0, Math.min(100, normalized));
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (first === undefined || last === undefined) continue;
      const metricReasons: string[] = [];
      if (!healthy) metricReasons.push("outside-healthy-range");
      if (!degraded && !healthy) metricReasons.push("outside-degraded-range");
      if (samples.length < component.minimumSamples) metricReasons.push("insufficient-samples");
      metricReasons.push(`aggregation:${rule.aggregation}`);
      metricEvaluations.push({
        componentId: component.componentId,
        metric,
        value,
        unit: rule.unit,
        sampleCount: samples.length,
        level,
        score: Math.round(normalized * 100) / 100,
        firstSampleAt: first.sampledAt,
        lastSampleAt: last.sampledAt,
        reasons: metricReasons,
      });
    }
  }
  const previousByComponent = new Map(input.previousHealth.map((health) => [health.componentId, health]));
  const healthByComponent = new Map<string, ComponentHealth>();
  for (const component of componentById.values()) {
    const metrics = metricEvaluations.filter((metric) => metric.componentId === component.componentId);
    const requiredSet = new Set(component.requiredMetrics);
    const presentSet = new Set(metrics.map((metric) => metric.metric));
    const missingMetrics = [...requiredSet].filter((metric) => !presentSet.has(metric));
    const reasons: string[] = missingMetrics.map((metric) => `missing-metric:${metric}`);
    const latestSampleAt = metrics.reduce(
      (maximum, metric) => Math.max(maximum, metric.lastSampleAt.getTime()),
      Number.NEGATIVE_INFINITY,
    );
    const stale = !Number.isFinite(latestSampleAt) || evaluatedTime - latestSampleAt > component.staleAfterMs;
    if (stale) reasons.push("component-telemetry-stale");
    const weightedScoreNumerator = metrics.reduce((sum, metric) => {
      const weight = metricRuleByName.get(metric.metric)?.scoreWeight ?? 1;
      return sum + metric.score * weight;
    }, 0);
    const weightedScoreDenominator = metrics.reduce(
      (sum, metric) => sum + (metricRuleByName.get(metric.metric)?.scoreWeight ?? 1),
      0,
    );
    let score = weightedScoreDenominator === 0 ? 0 : weightedScoreNumerator / weightedScoreDenominator;
    if (missingMetrics.length > 0) score -= Math.min(50, missingMetrics.length * 10);
    if (stale) score = Math.min(score, 25);
    const availabilityMetric = metrics.find((metric) => metric.metric === "availability_bps");
    const latencyMetric = metrics.find((metric) => metric.metric === "latency_ms");
    const errorMetric = metrics.find((metric) => metric.metric === "error_rate_bps");
    const availabilityBps = availabilityMetric?.value ?? 0;
    const latencyMs = latencyMetric?.value ?? 0;
    const errorRateBps = errorMetric?.value ?? 10_000;
    if (availabilityBps < component.availabilityTargetBps) {
      reasons.push("availability-target-missed");
      score -= Math.min(40, (component.availabilityTargetBps - availabilityBps) / 100);
    }
    if (latencyMs > component.maximumLatencyMs) {
      reasons.push("latency-budget-exceeded");
      score -= Math.min(30, ((latencyMs - component.maximumLatencyMs) / Math.max(1, component.maximumLatencyMs)) * 30);
    }
    if (errorRateBps > component.maximumErrorRateBps) {
      reasons.push("error-budget-exceeded");
      score -= Math.min(40, (errorRateBps - component.maximumErrorRateBps) / 100);
    }
    score = Math.max(0, Math.min(100, score));
    let level: HealthLevel = "healthy";
    if (stale || metrics.length === 0) level = "unknown";
    else if (metrics.some((metric) => metric.level === "unavailable") || score < 30) level = "unavailable";
    else if (metrics.some((metric) => metric.level !== "healthy") || score < 80) level = "degraded";
    const previous = previousByComponent.get(component.componentId);
    if (previous !== undefined && previous.level !== level) {
      reasons.push(`health-transition:${previous.level}->${level}`);
    }
    const baseHealth = {
      componentId: component.componentId,
      level,
      score: Math.round(score * 100) / 100,
      availabilityBps: Math.max(0, Math.min(10_000, availabilityBps)),
      latencyMs: Math.max(0, latencyMs),
      errorRateBps: Math.max(0, Math.min(10_000, errorRateBps)),
      reasons,
    };
    healthByComponent.set(
      component.componentId,
      Number.isFinite(latestSampleAt) ? { ...baseHealth, lastSampleAt: new Date(latestSampleAt) } : baseHealth,
    );
  }
  const levelRank: Readonly<Record<HealthLevel, number>> = {
    healthy: 0,
    unknown: 1,
    degraded: 2,
    unavailable: 3,
  };
  let propagationChanged = true;
  let propagationPasses = 0;
  while (propagationChanged && propagationPasses <= componentById.size) {
    propagationChanged = false;
    propagationPasses += 1;
    for (const component of componentById.values()) {
      const health = healthByComponent.get(component.componentId);
      if (health === undefined) continue;
      const dependencyHealth = component.dependencyIds
        .map((dependencyId) => healthByComponent.get(dependencyId))
        .filter((candidate): candidate is ComponentHealth => candidate !== undefined);
      const worstDependency = dependencyHealth.sort((left, right) => levelRank[right.level] - levelRank[left.level])[0];
      if (worstDependency === undefined) continue;
      let propagatedLevel = health.level;
      let propagatedScore = health.score;
      const propagatedReasons = [...health.reasons];
      if (worstDependency.level === "unavailable" && levelRank[health.level] < levelRank.degraded) {
        propagatedLevel = component.critical ? "unavailable" : "degraded";
        propagatedScore = Math.min(propagatedScore, component.critical ? 20 : 60);
        propagatedReasons.push(`dependency-unavailable:${worstDependency.componentId}`);
      } else if (worstDependency.level === "degraded" && health.level === "healthy") {
        propagatedLevel = "degraded";
        propagatedScore = Math.min(propagatedScore, 75);
        propagatedReasons.push(`dependency-degraded:${worstDependency.componentId}`);
      } else if (worstDependency.level === "unknown" && health.level === "healthy" && component.critical) {
        propagatedLevel = "unknown";
        propagatedScore = Math.min(propagatedScore, 50);
        propagatedReasons.push(`dependency-unknown:${worstDependency.componentId}`);
      }
      if (propagatedLevel !== health.level || propagatedScore !== health.score) {
        healthByComponent.set(component.componentId, {
          ...health,
          level: propagatedLevel,
          score: propagatedScore,
          reasons: propagatedReasons,
        });
        propagationChanged = true;
      }
    }
  }
  if (propagationChanged) diagnostics.push("dependency health propagation stopped at cycle guard");
  const components = [...healthByComponent.values()].sort((left, right) => {
    const levelOrder = levelRank[right.level] - levelRank[left.level];
    if (levelOrder !== 0) return levelOrder;
    if (left.score !== right.score) return left.score - right.score;
    return left.componentId.localeCompare(right.componentId);
  });
  for (const health of components) {
    const previous = previousByComponent.get(health.componentId);
    const changed = previous === undefined || previous.level !== health.level;
    if (health.level === "healthy") continue;
    const componentPolicy = componentById.get(health.componentId);
    const notifyTeams = componentPolicy?.critical
      ? ["platform-on-call", "incident-command"]
      : ["platform-on-call"];
    const suppressed = !changed && previous !== undefined && previous.level === health.level;
    alerts.push({
      alertKey: `health:${input.environment}:${health.componentId}:${health.level}`,
      componentId: health.componentId,
      level: health.level,
      reason: health.reasons.join(";"),
      firstObservedAt: previous?.lastSampleAt ?? input.evaluatedAt,
      lastObservedAt: health.lastSampleAt ?? input.evaluatedAt,
      notifyTeams,
      suppressed,
    });
  }
  const healthyComponentIds = components
    .filter((health) => health.level === "healthy")
    .map((health) => health.componentId);
  const degradedComponentIds = components
    .filter((health) => health.level === "degraded")
    .map((health) => health.componentId);
  const unavailableComponentIds = components
    .filter((health) => health.level === "unavailable")
    .map((health) => health.componentId);
  const unknownComponentIds = components
    .filter((health) => health.level === "unknown")
    .map((health) => health.componentId);
  const weightedScoreTotal = components.reduce((sum, health) => {
    const weight = componentById.get(health.componentId)?.weight ?? 1;
    return sum + health.score * weight;
  }, 0);
  const totalWeight = components.reduce(
    (sum, health) => sum + (componentById.get(health.componentId)?.weight ?? 1),
    0,
  );
  const fleetScore = totalWeight === 0 ? 0 : Math.round((weightedScoreTotal / totalWeight) * 100) / 100;
  const availabilityWeight = components.reduce((sum, health) => {
    const weight = componentById.get(health.componentId)?.weight ?? 1;
    return sum + health.availabilityBps * weight;
  }, 0);
  const availabilityBps = totalWeight === 0 ? 0 : Math.round(availabilityWeight / totalWeight);
  let fleetLevel: HealthLevel = "healthy";
  if (components.length === 0 || unknownComponentIds.length === components.length) fleetLevel = "unknown";
  else if (unavailableComponentIds.some((componentId) => componentById.get(componentId)?.critical)) {
    fleetLevel = "unavailable";
  } else if (unavailableComponentIds.length > 0 || degradedComponentIds.length > 0 || unknownComponentIds.length > 0) {
    fleetLevel = "degraded";
  }
  diagnostics.push(`telemetry-samples-accepted:${seenSamples.size}`);
  diagnostics.push(`metric-evaluations:${metricEvaluations.length}`);
  diagnostics.push(`dependency-propagation-passes:${propagationPasses}`);
  diagnostics.push(`fleet-score:${fleetScore}`);
  diagnostics.push(`fleet-availability-bps:${availabilityBps}`);
  const classifiedCount = healthyComponentIds.length
    + degradedComponentIds.length
    + unavailableComponentIds.length
    + unknownComponentIds.length;
  if (classifiedCount !== components.length) {
    throw new Error("telemetry component classification count is inconsistent");
  }
  if (fleetLevel === "healthy" && components.some((component) => component.level !== "healthy")) {
    throw new Error("healthy fleet level conflicts with a non-healthy component");
  }
  if (fleetLevel === "unavailable" && unavailableComponentIds.length === 0) {
    throw new Error("unavailable fleet level has no unavailable component");
  }
  const alertKeys = new Set(alerts.map((alert) => alert.alertKey));
  if (alertKeys.size !== alerts.length) throw new Error("telemetry report contains duplicate alert keys");
  const metricsByComponent = new Map<string, number>();
  for (const metric of metricEvaluations) {
    metricsByComponent.set(metric.componentId, (metricsByComponent.get(metric.componentId) ?? 0) + 1);
  }
  for (const component of components) {
    const metricCount = metricsByComponent.get(component.componentId) ?? 0;
    diagnostics.push(`component-metric-count:${component.componentId}:${metricCount}`);
  }
  const acceptedSamples = [...samplesByComponentMetric.values()].flat();
  const samplesByRegion = new Map<string, number>();
  const samplesByMetric = new Map<string, number>();
  for (const sample of acceptedSamples) {
    samplesByRegion.set(sample.region, (samplesByRegion.get(sample.region) ?? 0) + 1);
    samplesByMetric.set(sample.metric, (samplesByMetric.get(sample.metric) ?? 0) + 1);
  }
  for (const [region, count] of [...samplesByRegion].sort(([left], [right]) => left.localeCompare(right))) {
    diagnostics.push(`accepted-samples-region:${region}:${count}`);
  }
  for (const [metric, count] of [...samplesByMetric].sort(([left], [right]) => left.localeCompare(right))) {
    diagnostics.push(`accepted-samples-metric:${metric}:${count}`);
  }
  for (const region of allowedRegions) {
    if (!samplesByRegion.has(region)) diagnostics.push(`configured-region-has-no-samples:${region}`);
  }
  const criticalComponents = input.components.filter((component) => component.critical);
  const criticalUnknown = criticalComponents.filter((component) =>
    healthByComponent.get(component.componentId)?.level === "unknown",
  );
  if (criticalUnknown.length > 0) {
    const criticalIds = criticalUnknown.map((item) => item.componentId).join(",");
    diagnostics.push(`critical-components-with-unknown-health:${criticalIds}`);
  }
  return {
    evaluatedAt: input.evaluatedAt,
    components,
    metrics: metricEvaluations,
    alerts,
    fleetLevel,
    fleetScore,
    availabilityBps,
    healthyComponentIds,
    degradedComponentIds,
    unavailableComponentIds,
    unknownComponentIds,
    diagnostics,
  };
}
