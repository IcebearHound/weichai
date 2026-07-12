import { compareDecimals, formatDecimal, parseDecimal, rescaleDecimal } from "../money/decimal.js";
import type {
  QuoteAcquisitionPlan,
  QuoteCacheDecision,
  QuoteCacheObservation,
  QuotePlanningInput,
  QuotePlanningIssue,
  QuoteProviderObservation,
  QuoteProviderStep,
} from "../runtime/quote-runtime-contracts.js";

export function compileQuoteLifecycle(input: QuotePlanningInput): QuoteAcquisitionPlan {
  const issues: QuotePlanningIssue[] = [];
  const diagnostics: Record<string, string | number | boolean> = {};
  const base = input.base.trim().toUpperCase();
  const counter = input.counter.trim().toUpperCase();
  const correlation = input.correlationId.trim();
  const requestedTime = input.requestedAt.getTime();
  const policy = input.policy;
  if (!/^[A-Z]{3}$/u.test(base)) {
    issues.push({
      code: "invalid-base-currency",
      severity: "blocking",
      field: "base",
      message: "Base currency must contain exactly three ASCII letters.",
    });
  }
  if (!/^[A-Z]{3}$/u.test(counter)) {
    issues.push({
      code: "invalid-counter-currency",
      severity: "blocking",
      field: "counter",
      message: "Counter currency must contain exactly three ASCII letters.",
    });
  }
  if (base === counter && /^[A-Z]{3}$/u.test(base)) {
    issues.push({
      code: "identical-currencies",
      severity: "blocking",
      field: "counter",
      message: "A quote requires two different currencies.",
    });
  }
  if (correlation.length < 3 || correlation.length > 80) {
    issues.push({
      code: "invalid-correlation-id",
      severity: "blocking",
      field: "correlationId",
      message: "Correlation identifier length must be between three and eighty characters.",
    });
  } else if (!/^[a-zA-Z0-9._:-]+$/u.test(correlation)) {
    issues.push({
      code: "unsafe-correlation-id",
      severity: "blocking",
      field: "correlationId",
      message: "Correlation identifier contains unsupported characters.",
    });
  }
  if (!Number.isFinite(requestedTime)) {
    issues.push({
      code: "invalid-request-time",
      severity: "blocking",
      field: "requestedAt",
      message: "Requested time must be a valid date.",
    });
  }
  if (policy.freshTtlMs !== 5_000) {
    issues.push({
      code: "unexpected-fresh-ttl",
      severity: "warning",
      field: "policy.freshTtlMs",
      message: "The platform contract fixes the fresh quote lifetime at five seconds.",
    });
  }
  if (!Number.isInteger(policy.providerTimeoutMs) || policy.providerTimeoutMs < 1) {
    issues.push({
      code: "invalid-provider-timeout",
      severity: "blocking",
      field: "policy.providerTimeoutMs",
      message: "Provider timeout must be a positive whole number of milliseconds.",
    });
  }
  if (!Number.isInteger(policy.staleTtlMs) || policy.staleTtlMs < policy.freshTtlMs) {
    issues.push({
      code: "invalid-stale-ttl",
      severity: "blocking",
      field: "policy.staleTtlMs",
      message: "Stale retention cannot be shorter than fresh retention.",
    });
  }
  if (!Number.isFinite(policy.maximumSpreadBps) || policy.maximumSpreadBps <= 0) {
    issues.push({
      code: "invalid-spread-limit",
      severity: "blocking",
      field: "policy.maximumSpreadBps",
      message: "Maximum spread must be a positive finite basis-point value.",
    });
  }
  if (!Number.isInteger(policy.requiredProviderCapacity) || policy.requiredProviderCapacity < 0) {
    issues.push({
      code: "invalid-capacity-requirement",
      severity: "blocking",
      field: "policy.requiredProviderCapacity",
      message: "Required provider capacity cannot be negative.",
    });
  }
  let normalizedAmount = input.amount.trim();
  try {
    const amount = parseDecimal(normalizedAmount);
    if (amount.coefficient <= 0n) {
      issues.push({
        code: "non-positive-amount",
        severity: "blocking",
        field: "amount",
        message: "Requested quote amount must be greater than zero.",
      });
    }
    if (amount.scale > 8) {
      issues.push({
        code: "excessive-amount-precision",
        severity: "warning",
        field: "amount",
        message: "Amount precision was reduced to eight decimal places for planning.",
      });
      normalizedAmount = formatDecimal(rescaleDecimal(amount, 8));
    } else {
      normalizedAmount = formatDecimal(amount);
    }
    if (compareDecimals(normalizedAmount, policy.maximumAmount) > 0) {
      issues.push({
        code: "amount-exceeds-policy",
        severity: "blocking",
        field: "amount",
        message: "Requested amount exceeds the configured quote limit.",
      });
    }
  } catch (error) {
    issues.push({
      code: "invalid-amount",
      severity: "blocking",
      field: "amount",
      message: error instanceof Error ? error.message : "Amount is not a decimal value.",
    });
  }
  const pair = `${base}/${counter}`;
  const inversePair = `${counter}/${base}`;
  diagnostics.marketState = input.marketState;
  diagnostics.cacheCandidates = input.cache.length;
  diagnostics.providerCandidates = input.providers.length;
  diagnostics.requestedTime = Number.isFinite(requestedTime) ? requestedTime : 0;
  diagnostics.policyFreshTtlMs = policy.freshTtlMs;
  diagnostics.policyStaleTtlMs = policy.staleTtlMs;
  diagnostics.policyProviderTimeoutMs = policy.providerTimeoutMs;
  const cacheDecisions = new Map<QuoteCacheObservation, QuoteCacheDecision>();
  const eligibleFresh: QuoteCacheObservation[] = [];
  const eligibleStale: QuoteCacheObservation[] = [];
  for (const observation of input.cache) {
    const rejectionReasons: string[] = [];
    const observedTime = observation.observedAt.getTime();
    const storedTime = observation.storedAt.getTime();
    const expiresTime = observation.expiresAt.getTime();
    const staleUntilTime = observation.staleUntil.getTime();
    const ageMs = Number.isFinite(requestedTime - observedTime)
      ? Math.max(0, requestedTime - observedTime)
      : Number.POSITIVE_INFINITY;
    if (observation.pair !== pair && observation.pair !== inversePair) {
      rejectionReasons.push("pair-mismatch");
    }
    if (observation.pair === inversePair && !policy.allowInversePair) {
      rejectionReasons.push("inverse-pair-disabled");
    }
    if (!observation.checksumValid) rejectionReasons.push("checksum-invalid");
    if (!Number.isFinite(observedTime)) rejectionReasons.push("invalid-observed-time");
    if (!Number.isFinite(storedTime)) rejectionReasons.push("invalid-storage-time");
    if (!Number.isFinite(expiresTime)) rejectionReasons.push("invalid-expiry-time");
    if (!Number.isFinite(staleUntilTime)) rejectionReasons.push("invalid-stale-deadline");
    if (Number.isFinite(observedTime) && Number.isFinite(storedTime) && storedTime < observedTime) {
      rejectionReasons.push("stored-before-observed");
    }
    if (Number.isFinite(expiresTime) && Number.isFinite(observedTime) && expiresTime < observedTime) {
      rejectionReasons.push("expiry-before-observation");
    }
    if (Number.isFinite(staleUntilTime) && Number.isFinite(expiresTime) && staleUntilTime < expiresTime) {
      rejectionReasons.push("stale-deadline-before-expiry");
    }
    let spreadBps: number | undefined;
    try {
      const bid = Number(observation.bid);
      const ask = Number(observation.ask);
      if (!Number.isFinite(bid) || bid <= 0) rejectionReasons.push("invalid-bid");
      if (!Number.isFinite(ask) || ask <= 0) rejectionReasons.push("invalid-ask");
      if (Number.isFinite(bid) && Number.isFinite(ask) && ask < bid) {
        rejectionReasons.push("crossed-market");
      }
      if (bid > 0 && ask >= bid) {
        const midpoint = (bid + ask) / 2;
        spreadBps = midpoint === 0 ? Number.POSITIVE_INFINITY : ((ask - bid) / midpoint) * 10_000;
        if (spreadBps > policy.maximumSpreadBps) rejectionReasons.push("spread-too-wide");
      }
    } catch {
      rejectionReasons.push("unparseable-price");
    }
    const freshByDeadline = requestedTime < expiresTime;
    const freshByContract = ageMs < policy.freshTtlMs;
    const staleByDeadline = requestedTime < staleUntilTime;
    const fresh = rejectionReasons.length === 0 && freshByDeadline && freshByContract;
    const stale = rejectionReasons.length === 0 && !fresh && staleByDeadline;
    const decisionBase = {
      key: `${observation.pair}:${observation.providerId}:${observedTime}`,
      usable: fresh || stale,
      fresh,
      stale,
      ageMs,
      rejectionReasons,
    };
    const decision: QuoteCacheDecision = spreadBps === undefined
      ? decisionBase
      : { ...decisionBase, spreadBps };
    cacheDecisions.set(observation, decision);
    if (fresh) eligibleFresh.push(observation);
    if (stale) eligibleStale.push(observation);
  }
  eligibleFresh.sort((left, right) => {
    const timeOrder = right.observedAt.getTime() - left.observedAt.getTime();
    if (timeOrder !== 0) return timeOrder;
    const providerOrder = left.providerId.localeCompare(right.providerId);
    if (providerOrder !== 0) return providerOrder;
    return left.pair === pair ? -1 : 1;
  });
  eligibleStale.sort((left, right) => {
    const timeOrder = right.observedAt.getTime() - left.observedAt.getTime();
    if (timeOrder !== 0) return timeOrder;
    return right.staleUntil.getTime() - left.staleUntil.getTime();
  });
  const preferredRegions = new Map<string, number>();
  policy.preferredRegions.forEach((region, index) => {
    if (!preferredRegions.has(region)) preferredRegions.set(region, index);
  });
  const providerById = new Map<string, QuoteProviderObservation>();
  for (const provider of input.providers) {
    if (providerById.has(provider.providerId)) {
      issues.push({
        code: "duplicate-provider",
        severity: "warning",
        field: "providers",
        message: `Duplicate provider registration ignored: ${provider.providerId}`,
      });
      continue;
    }
    providerById.set(provider.providerId, provider);
  }
  const eligibleProviders: QuoteProviderObservation[] = [];
  for (const provider of providerById.values()) {
    const supportsDirect = provider.supportedPairs.includes(pair) || provider.supportedPairs.includes("*");
    const supportsInverse = provider.supportedPairs.includes(inversePair) && policy.allowInversePair;
    if (!supportsDirect && !supportsInverse) continue;
    if (!provider.available) continue;
    if (provider.circuitMode === "open") continue;
    if (provider.capacity < policy.requiredProviderCapacity) continue;
    if (provider.failureRateBps < 0 || provider.failureRateBps > 10_000) {
      issues.push({
        code: "invalid-provider-failure-rate",
        severity: "warning",
        field: "providers",
        message: `Provider ${provider.providerId} reported an invalid failure rate.`,
      });
      continue;
    }
    if (provider.latencyP99Ms < provider.latencyP50Ms || provider.latencyP50Ms < 0) {
      issues.push({
        code: "invalid-provider-latency",
        severity: "warning",
        field: "providers",
        message: `Provider ${provider.providerId} reported inconsistent latency percentiles.`,
      });
      continue;
    }
    eligibleProviders.push(provider);
  }
  eligibleProviders.sort((left, right) => {
    const leftRegion = preferredRegions.get(left.region) ?? Number.MAX_SAFE_INTEGER;
    const rightRegion = preferredRegions.get(right.region) ?? Number.MAX_SAFE_INTEGER;
    if (leftRegion !== rightRegion) return leftRegion - rightRegion;
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.circuitMode !== right.circuitMode) return left.circuitMode === "closed" ? -1 : 1;
    if (left.failureRateBps !== right.failureRateBps) return left.failureRateBps - right.failureRateBps;
    if (left.latencyP99Ms !== right.latencyP99Ms) return left.latencyP99Ms - right.latencyP99Ms;
    return left.providerId.localeCompare(right.providerId);
  });
  const providerSteps: QuoteProviderStep[] = [];
  let accumulatedDelay = 0;
  for (let index = 0; index < eligibleProviders.length; index += 1) {
    const provider = eligibleProviders[index];
    if (provider === undefined) continue;
    const rationale: string[] = [];
    const regionPreference = preferredRegions.get(provider.region) ?? policy.preferredRegions.length;
    if (regionPreference < policy.preferredRegions.length) rationale.push("preferred-region");
    if (provider.priority === 0) rationale.push("primary-priority");
    if (provider.circuitMode === "half-open") rationale.push("half-open-probe");
    if (provider.failureRateBps === 0) rationale.push("no-recent-failures");
    if (provider.latencyP99Ms <= policy.providerTimeoutMs / 2) rationale.push("latency-headroom");
    const latencyAllowance = Math.ceil(Math.max(provider.latencyP99Ms * 1.25, provider.latencyP50Ms * 2));
    const timeoutMs = Math.max(1, Math.min(policy.providerTimeoutMs, latencyAllowance));
    const startAfterMs = index === 0 ? 0 : accumulatedDelay;
    providerSteps.push({
      providerId: provider.providerId,
      ordinal: index,
      timeoutMs,
      startAfterMs,
      halfOpenProbe: provider.circuitMode === "half-open",
      regionPreference,
      rationale,
    });
    const hedgeDelay = Math.max(1, Math.min(timeoutMs, Math.ceil(provider.latencyP50Ms * 1.5)));
    accumulatedDelay += hedgeDelay;
  }
  const fresh = eligibleFresh[0];
  const stale = eligibleStale[0];
  const selectedCache = fresh ?? stale;
  const selectedCacheDecision = selectedCache === undefined ? undefined : cacheDecisions.get(selectedCache);
  const hasBlockingIssue = issues.some((issue) => issue.severity === "blocking");
  const marketClosed = input.marketState === "closed";
  const joinExistingRequest = input.inFlightPairs.includes(pair)
    || (policy.allowInversePair && input.inFlightPairs.includes(inversePair));
  let mode: QuoteAcquisitionPlan["mode"] = "unavailable";
  if (!hasBlockingIssue && fresh !== undefined) mode = "cache";
  else if (!hasBlockingIssue && joinExistingRequest) mode = "provider";
  else if (!hasBlockingIssue && providerSteps.length > 0 && !marketClosed) mode = "provider";
  else if (
    !hasBlockingIssue
    && stale !== undefined
    && (input.marketState !== "closed" || policy.allowStaleWhenClosed)
  ) {
    mode = "stale";
  }
  if (!hasBlockingIssue && mode === "unavailable") {
    issues.push({
      code: "no-acquisition-path",
      severity: "blocking",
      message: "No fresh cache entry, eligible provider, or permitted stale fallback is available.",
    });
  }
  if (input.marketState === "thin") {
    issues.push({
      code: "thin-market",
      severity: "info",
      message: "Market liquidity is thin; provider prices may have wider spreads.",
    });
  }
  if (input.marketState === "unknown") {
    issues.push({
      code: "unknown-market-state",
      severity: "warning",
      message: "Market state is unknown; the normal provider timeout remains in force.",
    });
  }
  diagnostics.eligibleFreshEntries = eligibleFresh.length;
  diagnostics.eligibleStaleEntries = eligibleStale.length;
  diagnostics.eligibleProviders = eligibleProviders.length;
  diagnostics.joinExistingRequest = joinExistingRequest;
  diagnostics.inverseAllowed = policy.allowInversePair;
  diagnostics.marketClosed = marketClosed;
  diagnostics.accumulatedProviderDelayMs = accumulatedDelay;
  diagnostics.blockingIssueCount = issues.filter((issue) => issue.severity === "blocking").length;
  diagnostics.warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const cacheRejectionCounts = new Map<string, number>();
  for (const decision of cacheDecisions.values()) {
    for (const reason of decision.rejectionReasons) {
      cacheRejectionCounts.set(reason, (cacheRejectionCounts.get(reason) ?? 0) + 1);
    }
  }
  for (const [reason, count] of [...cacheRejectionCounts].sort(([left], [right]) => left.localeCompare(right))) {
    diagnostics[`cacheRejection.${reason}`] = count;
  }
  const providersByRegion = new Map<string, number>();
  for (const provider of eligibleProviders) {
    providersByRegion.set(provider.region, (providersByRegion.get(provider.region) ?? 0) + 1);
  }
  for (const [region, count] of [...providersByRegion].sort(([left], [right]) => left.localeCompare(right))) {
    diagnostics[`eligibleRegion.${region}`] = count;
  }
  const providerStepIds = new Set(providerSteps.map((step) => step.providerId));
  if (providerStepIds.size !== providerSteps.length) {
    throw new Error("quote provider plan contains duplicate provider steps");
  }
  let priorStart = -1;
  for (const step of providerSteps) {
    if (step.startAfterMs < priorStart) throw new Error("quote provider plan is not ordered by start delay");
    if (step.timeoutMs < 1 || step.timeoutMs > policy.providerTimeoutMs) {
      throw new Error(`quote provider plan has invalid timeout: ${step.providerId}`);
    }
    priorStart = step.startAfterMs;
  }
  if (mode === "cache" && selectedCacheDecision?.fresh !== true) {
    throw new Error("quote cache mode selected without a fresh cache decision");
  }
  if (mode === "stale" && selectedCacheDecision?.stale !== true) {
    throw new Error("quote stale mode selected without a stale cache decision");
  }
  if (mode === "provider" && providerSteps.length === 0 && !joinExistingRequest) {
    throw new Error("quote provider mode selected without a provider or coalesced request");
  }
  const issueCodeCounts = new Map<string, number>();
  for (const issue of issues) issueCodeCounts.set(issue.code, (issueCodeCounts.get(issue.code) ?? 0) + 1);
  for (const [code, count] of issueCodeCounts) {
    if (count > 1) diagnostics[`duplicateIssue.${code}`] = count;
  }
  if (mode === "unavailable" && !issues.some((issue) => issue.severity === "blocking")) {
    throw new Error("unavailable quote plan lacks a blocking explanation");
  }
  if (mode !== "unavailable" && issues.some((issue) => issue.severity === "blocking")) {
    throw new Error("usable quote plan retains a blocking issue");
  }
  const deadlineDuration = providerSteps.reduce(
    (maximum, step) => Math.max(maximum, step.startAfterMs + step.timeoutMs),
    Math.max(1, policy.providerTimeoutMs),
  );
  const safeRequestedTime = Number.isFinite(requestedTime) ? requestedTime : 0;
  const basePlan = {
    pair,
    inversePair,
    normalizedAmount,
    mode,
    providerSteps,
    joinExistingRequest,
    deadlineAt: new Date(safeRequestedTime + deadlineDuration),
    issues,
    diagnostics,
  };
  const withCache = selectedCacheDecision === undefined
    ? basePlan
    : { ...basePlan, cacheDecision: selectedCacheDecision };
  if (stale === undefined) return withCache;
  const staleDecision = cacheDecisions.get(stale);
  return staleDecision === undefined
    ? withCache
    : { ...withCache, staleFallbackKey: staleDecision.key };
}
