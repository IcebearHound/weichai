import type {
  ProviderRecoveryInput,
  ProviderRecoveryPlan,
  ProviderRecoveryState,
  ProviderSignal,
  ProviderTransition,
} from "../runtime/provider-runtime-contracts.js";

export function planProviderRecovery(input: ProviderRecoveryInput): ProviderRecoveryPlan {
  const warnings: string[] = [];
  const ignoredSignalIds: string[] = [];
  const transitions: ProviderTransition[] = [];
  const evaluatedTime = input.evaluatedAt.getTime();
  const policy = input.policy;
  if (!Number.isFinite(evaluatedTime)) throw new Error("provider recovery evaluation time is invalid");
  if (!Number.isInteger(policy.failureThreshold) || policy.failureThreshold < 1) {
    throw new Error("failure threshold must be a positive integer");
  }
  if (!Number.isInteger(policy.successThreshold) || policy.successThreshold < 1) {
    throw new Error("success threshold must be a positive integer");
  }
  if (!Number.isInteger(policy.halfOpenProbeLimit) || policy.halfOpenProbeLimit < 1) {
    throw new Error("half-open probe limit must be a positive integer");
  }
  if (!Number.isFinite(policy.openDurationMs) || policy.openDurationMs < 1) {
    throw new Error("open duration must be positive");
  }
  if (!Number.isFinite(policy.observationWindowMs) || policy.observationWindowMs < policy.openDurationMs) {
    throw new Error("observation window must be at least the open duration");
  }
  if (!Number.isFinite(policy.timeoutWeight) || policy.timeoutWeight < 1) {
    throw new Error("timeout weight must be at least one");
  }
  if (!Number.isFinite(policy.nonRetryableWeight) || policy.nonRetryableWeight < 1) {
    throw new Error("non-retryable weight must be at least one");
  }
  if (!Number.isFinite(policy.latencyBudgetMs) || policy.latencyBudgetMs < 1) {
    throw new Error("latency budget must be positive");
  }
  if (!Number.isInteger(policy.minimumSamples) || policy.minimumSamples < 0) {
    throw new Error("minimum samples cannot be negative");
  }
  const initial = input.state;
  if (initial.providerId.trim().length === 0) throw new Error("provider id is required");
  if (!Number.isFinite(initial.lastTransitionAt.getTime())) throw new Error("last transition time is invalid");
  if (initial.consecutiveFailures < 0 || initial.consecutiveSuccesses < 0) {
    throw new Error("consecutive counters cannot be negative");
  }
  if (initial.weightedFailures < 0 || initial.halfOpenProbesInFlight < 0) {
    throw new Error("failure and probe counters cannot be negative");
  }
  if (initial.successfulRequests > initial.totalRequests) {
    throw new Error("successful request count cannot exceed total request count");
  }
  if (initial.latencyTotalMs < 0) throw new Error("latency total cannot be negative");
  if (initial.mode === "open" && initial.openedAt === undefined) {
    warnings.push("open state had no opening timestamp; last transition time was used");
  }
  if (initial.mode !== "open" && initial.openedAt !== undefined) {
    warnings.push("opening timestamp was ignored outside open mode");
  }
  const activeRequests = new Set(input.activeRequestIds);
  if (activeRequests.size !== input.activeRequestIds.length) {
    warnings.push("duplicate active request identifiers were collapsed");
  }
  const seenSignals = new Set<string>();
  const orderedSignals = [...input.signals].sort((left, right) => {
    const timeOrder = left.occurredAt.getTime() - right.occurredAt.getTime();
    if (timeOrder !== 0) return timeOrder;
    const requestOrder = left.requestId.localeCompare(right.requestId);
    if (requestOrder !== 0) return requestOrder;
    return left.kind.localeCompare(right.kind);
  });
  let mode = initial.mode;
  let openedAt = initial.openedAt;
  let lastTransitionAt = initial.lastTransitionAt;
  let consecutiveFailures = initial.consecutiveFailures;
  let consecutiveSuccesses = initial.consecutiveSuccesses;
  let weightedFailures = initial.weightedFailures;
  let halfOpenProbesInFlight = initial.halfOpenProbesInFlight;
  let totalRequests = initial.totalRequests;
  let successfulRequests = initial.successfulRequests;
  let latencyTotalMs = initial.latencyTotalMs;
  let lastErrorCode = initial.lastErrorCode;
  let generation = initial.generation;
  const windowStart = evaluatedTime - policy.observationWindowMs;
  const openingReference = openedAt?.getTime() ?? lastTransitionAt.getTime();
  if (mode === "open" && evaluatedTime - openingReference >= policy.openDurationMs) {
    transitions.push({
      from: "open",
      to: "half-open",
      at: input.evaluatedAt,
      reason: "open-duration-elapsed",
    });
    mode = "half-open";
    consecutiveSuccesses = 0;
    halfOpenProbesInFlight = 0;
    lastTransitionAt = input.evaluatedAt;
    generation += 1;
  }
  for (const signal of orderedSignals) {
    const signalTime = signal.occurredAt.getTime();
    const signalIdentity = `${signal.requestId}:${signal.kind}:${signalTime}`;
    if (seenSignals.has(signalIdentity)) {
      ignoredSignalIds.push(signalIdentity);
      continue;
    }
    seenSignals.add(signalIdentity);
    if (signal.providerId !== initial.providerId) {
      ignoredSignalIds.push(signalIdentity);
      warnings.push(`signal for another provider was ignored: ${signal.providerId}`);
      continue;
    }
    if (!Number.isFinite(signalTime)) {
      ignoredSignalIds.push(signalIdentity);
      warnings.push(`signal with invalid timestamp was ignored: ${signal.requestId}`);
      continue;
    }
    if (signalTime < windowStart) {
      ignoredSignalIds.push(signalIdentity);
      continue;
    }
    if (signalTime > evaluatedTime) {
      ignoredSignalIds.push(signalIdentity);
      warnings.push(`future signal was ignored: ${signal.requestId}`);
      continue;
    }
    if (signal.kind !== "probe-request" && signal.kind !== "manual-reset") {
      if (!activeRequests.has(signal.requestId)) {
        warnings.push(`terminal signal had no active request: ${signal.requestId}`);
      }
      activeRequests.delete(signal.requestId);
    }
    if (signal.kind === "manual-reset") {
      if (mode !== "closed") {
        transitions.push({
          from: mode,
          to: "closed",
          at: signal.occurredAt,
          reason: "manual-reset",
          signalId: signalIdentity,
        });
      }
      mode = "closed";
      openedAt = undefined;
      consecutiveFailures = 0;
      consecutiveSuccesses = 0;
      weightedFailures = 0;
      halfOpenProbesInFlight = 0;
      lastErrorCode = undefined;
      lastTransitionAt = signal.occurredAt;
      generation += 1;
      continue;
    }
    if (signal.kind === "probe-request") {
      if (mode !== "half-open") {
        ignoredSignalIds.push(signalIdentity);
        continue;
      }
      if (halfOpenProbesInFlight >= policy.halfOpenProbeLimit) {
        ignoredSignalIds.push(signalIdentity);
        warnings.push(`half-open probe limit reached for ${initial.providerId}`);
        continue;
      }
      halfOpenProbesInFlight += 1;
      activeRequests.add(signal.requestId);
      continue;
    }
    if (signal.kind === "success") {
      totalRequests += 1;
      successfulRequests += 1;
      consecutiveSuccesses += 1;
      consecutiveFailures = 0;
      if (signal.latencyMs === undefined || !Number.isFinite(signal.latencyMs) || signal.latencyMs < 0) {
        warnings.push(`success signal omitted valid latency: ${signal.requestId}`);
      } else {
        latencyTotalMs += signal.latencyMs;
        if (signal.latencyMs > policy.latencyBudgetMs) {
          warnings.push(`provider exceeded latency budget: ${signal.requestId}`);
        }
      }
      if (mode === "half-open") {
        halfOpenProbesInFlight = Math.max(0, halfOpenProbesInFlight - 1);
        if (consecutiveSuccesses >= policy.successThreshold) {
          transitions.push({
            from: "half-open",
            to: "closed",
            at: signal.occurredAt,
            reason: "recovery-success-threshold",
            signalId: signalIdentity,
          });
          mode = "closed";
          openedAt = undefined;
          weightedFailures = 0;
          consecutiveFailures = 0;
          consecutiveSuccesses = 0;
          halfOpenProbesInFlight = 0;
          lastErrorCode = undefined;
          lastTransitionAt = signal.occurredAt;
          generation += 1;
        }
      }
      continue;
    }
    totalRequests += 1;
    consecutiveFailures += 1;
    consecutiveSuccesses = 0;
    const failureWeight = signal.kind === "timeout"
      ? policy.timeoutWeight
      : signal.retryable === false
        ? policy.nonRetryableWeight
        : 1;
    weightedFailures += failureWeight;
    lastErrorCode = signal.errorCode ?? (signal.kind === "timeout" ? "timeout" : "provider-failure");
    if (mode === "half-open") {
      halfOpenProbesInFlight = Math.max(0, halfOpenProbesInFlight - 1);
      transitions.push({
        from: "half-open",
        to: "open",
        at: signal.occurredAt,
        reason: "half-open-probe-failed",
        signalId: signalIdentity,
      });
      mode = "open";
      openedAt = signal.occurredAt;
      lastTransitionAt = signal.occurredAt;
      generation += 1;
      continue;
    }
    if (mode === "closed" && weightedFailures >= policy.failureThreshold) {
      transitions.push({
        from: "closed",
        to: "open",
        at: signal.occurredAt,
        reason: "weighted-failure-threshold",
        signalId: signalIdentity,
      });
      mode = "open";
      openedAt = signal.occurredAt;
      halfOpenProbesInFlight = 0;
      lastTransitionAt = signal.occurredAt;
      generation += 1;
    }
  }
  const effectiveOpeningTime = openedAt?.getTime() ?? lastTransitionAt.getTime();
  const remainingOpenMs = mode === "open"
    ? Math.max(0, policy.openDurationMs - (evaluatedTime - effectiveOpeningTime))
    : 0;
  const nextEvaluationAt = mode === "open"
    ? new Date(evaluatedTime + remainingOpenMs)
    : mode === "half-open"
      ? new Date(evaluatedTime + Math.max(1, Math.floor(policy.openDurationMs / 4)))
      : new Date(evaluatedTime + policy.observationWindowMs);
  const averageLatencyMs = successfulRequests === 0 ? 0 : latencyTotalMs / successfulRequests;
  const availabilityBps = totalRequests === 0
    ? 10_000
    : Math.max(0, Math.min(10_000, Math.round((successfulRequests / totalRequests) * 10_000)));
  const availabilityScore = availabilityBps / 100;
  const latencyPenalty = averageLatencyMs <= policy.latencyBudgetMs
    ? 0
    : Math.min(40, ((averageLatencyMs - policy.latencyBudgetMs) / policy.latencyBudgetMs) * 40);
  const modePenalty = mode === "closed" ? 0 : mode === "half-open" ? 25 : 70;
  const samplePenalty = totalRequests < policy.minimumSamples
    ? Math.min(15, policy.minimumSamples - totalRequests)
    : 0;
  const failurePenalty = Math.min(25, weightedFailures * 2);
  const healthScore = Math.max(
    0,
    Math.min(
      100,
      Math.round((availabilityScore - latencyPenalty - modePenalty - samplePenalty - failurePenalty) * 100) / 100,
    ),
  );
  const acceptTraffic = mode === "closed";
  const grantProbe = mode === "half-open" && halfOpenProbesInFlight < policy.halfOpenProbeLimit;
  const stateBase = {
    providerId: initial.providerId,
    mode,
    lastTransitionAt,
    consecutiveFailures,
    consecutiveSuccesses,
    weightedFailures,
    halfOpenProbesInFlight,
    totalRequests,
    successfulRequests,
    latencyTotalMs,
    generation,
  };
  let state: ProviderRecoveryState;
  if (openedAt !== undefined && lastErrorCode !== undefined) {
    state = { ...stateBase, openedAt, lastErrorCode };
  } else if (openedAt !== undefined) {
    state = { ...stateBase, openedAt };
  } else if (lastErrorCode !== undefined) {
    state = { ...stateBase, lastErrorCode };
  } else {
    state = stateBase;
  }
  if (state.successfulRequests > state.totalRequests) {
    throw new Error("provider recovery state has more successes than requests");
  }
  if (state.mode === "open" && state.openedAt === undefined) {
    throw new Error("provider recovery open state lacks an opening timestamp");
  }
  if (state.mode !== "half-open" && state.halfOpenProbesInFlight !== 0) {
    warnings.push("provider has half-open probes outside half-open mode");
  }
  if (acceptTraffic && state.mode !== "closed") {
    throw new Error("provider recovery accepted traffic outside closed mode");
  }
  if (grantProbe && state.mode !== "half-open") {
    throw new Error("provider recovery granted a probe outside half-open mode");
  }
  let priorTransitionTime = initial.lastTransitionAt.getTime();
  let expectedMode = initial.mode;
  for (const transition of transitions) {
    if (transition.at.getTime() < priorTransitionTime) {
      throw new Error("provider recovery transitions are not chronological");
    }
    if (transition.from !== expectedMode) {
      warnings.push(`provider transition chain changed from unexpected mode: ${transition.from}`);
    }
    expectedMode = transition.to;
    priorTransitionTime = transition.at.getTime();
  }
  if (transitions.length > 0 && expectedMode !== state.mode) {
    throw new Error("provider recovery transition chain does not reach final state");
  }
  const signalKindCounts = new Map<ProviderSignal["kind"], number>();
  for (const signal of orderedSignals) {
    signalKindCounts.set(signal.kind, (signalKindCounts.get(signal.kind) ?? 0) + 1);
  }
  for (const [kind, count] of signalKindCounts) {
    if (count > 10_000) warnings.push(`unusually high provider signal count for ${kind}`);
  }
  const ignoredRatio = orderedSignals.length === 0 ? 0 : ignoredSignalIds.length / orderedSignals.length;
  if (ignoredRatio > 0.5) warnings.push("more than half of provider recovery signals were ignored");
  if (state.totalRequests === 0 && state.successfulRequests !== 0) {
    throw new Error("provider recovery state records success without requests");
  }
  if (averageLatencyMs < 0 || !Number.isFinite(averageLatencyMs)) {
    throw new Error("provider recovery average latency is invalid");
  }
  if (availabilityBps < 0 || availabilityBps > 10_000) {
    throw new Error("provider recovery availability is outside basis-point range");
  }
  if (healthScore < 0 || healthScore > 100) {
    throw new Error("provider recovery health score is outside percentage range");
  }
  return {
    state,
    transitions,
    acceptTraffic,
    grantProbe,
    nextEvaluationAt,
    healthScore,
    availabilityBps,
    averageLatencyMs,
    ignoredSignalIds,
    warnings,
  };
}
