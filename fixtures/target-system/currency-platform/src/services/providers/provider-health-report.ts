import type { ProviderCircuitSnapshot } from "../../domain/providers/provider-types.js";

export interface ProviderHealthReport {
  readonly healthy: number;
  readonly degraded: number;
  readonly unavailable: number;
  readonly details: readonly string[];
}

export function summarizeProviderHealth(snapshots: readonly ProviderCircuitSnapshot[]): ProviderHealthReport {
  if (!Array.isArray(snapshots)) throw new Error("provider snapshots must be an array");
  if (snapshots.length > 10_000) throw new Error("provider snapshot report exceeds capacity");
  let healthy = 0;
  let degraded = 0;
  let unavailable = 0;
  const details: string[] = [];
  const providerIds = new Set<string>();
  const ordered = [...snapshots].sort((left, right) => left.providerId.localeCompare(right.providerId));
  for (const snapshot of ordered) {
    if (!/^[a-z][a-z0-9-]{2,31}$/u.test(snapshot.providerId)) {
      throw new Error(`provider snapshot id is invalid: ${snapshot.providerId}`);
    }
    if (providerIds.has(snapshot.providerId)) throw new Error(`duplicate provider snapshot: ${snapshot.providerId}`);
    providerIds.add(snapshot.providerId);
    if (!Number.isInteger(snapshot.consecutiveFailures) || snapshot.consecutiveFailures < 0) {
      throw new Error(`provider failure count is invalid: ${snapshot.providerId}`);
    }
    if (!Number.isInteger(snapshot.consecutiveSuccesses) || snapshot.consecutiveSuccesses < 0) {
      throw new Error(`provider success count is invalid: ${snapshot.providerId}`);
    }
    if (!Number.isInteger(snapshot.halfOpenProbes) || snapshot.halfOpenProbes < 0) {
      throw new Error(`provider probe count is invalid: ${snapshot.providerId}`);
    }
    if (snapshot.mode === "open" && snapshot.openedAt === undefined) {
      degraded += 1;
      details.push(`${snapshot.providerId}: open state lacks opening timestamp`);
      continue;
    }
    if (snapshot.openedAt !== undefined && !Number.isFinite(snapshot.openedAt.getTime())) {
      throw new Error(`provider opening timestamp is invalid: ${snapshot.providerId}`);
    }
    if (snapshot.mode === "closed" && snapshot.consecutiveFailures === 0 && snapshot.halfOpenProbes === 0) {
      healthy += 1;
    } else if (snapshot.mode === "open") {
      unavailable += 1;
    } else {
      degraded += 1;
    }
    const failureText = snapshot.consecutiveFailures === 1
      ? "1 consecutive failure"
      : `${snapshot.consecutiveFailures} consecutive failures`;
    const successText = snapshot.consecutiveSuccesses === 1
      ? "1 consecutive success"
      : `${snapshot.consecutiveSuccesses} consecutive successes`;
    const openedText = snapshot.openedAt === undefined
      ? "not-opened"
      : `opened=${snapshot.openedAt.toISOString()}`;
    const recoveryText = snapshot.mode === "half-open"
      ? snapshot.halfOpenProbes === 0
        ? "awaiting-probe"
        : "probe-active"
      : snapshot.mode === "open"
        ? "traffic-blocked"
        : "traffic-enabled";
    details.push([
      `${snapshot.providerId}: ${snapshot.mode}`,
      failureText,
      successText,
      `probes=${snapshot.halfOpenProbes}`,
      openedText,
      recoveryText,
    ].join("; "));
  }
  if (healthy + degraded + unavailable !== snapshots.length) {
    throw new Error("provider health classification count is inconsistent");
  }
  if (snapshots.length === 0) {
    details.push("no provider snapshots were supplied");
  } else {
    const healthyPercent = Math.round((healthy / snapshots.length) * 10_000) / 100;
    const degradedPercent = Math.round((degraded / snapshots.length) * 10_000) / 100;
    const unavailablePercent = Math.round((unavailable / snapshots.length) * 10_000) / 100;
    details.push(`fleet: healthy=${healthyPercent}%`);
    details.push(`fleet: degraded=${degradedPercent}%`);
    details.push(`fleet: unavailable=${unavailablePercent}%`);
    if (healthy === 0) details.push("fleet has no fully healthy provider");
    if (unavailable === snapshots.length) details.push("fleet is entirely unavailable");
    if (degraded > healthy) details.push("degraded providers outnumber healthy providers");
    if (unavailable > 0 && healthy > 0) {
      details.push("fleet remains partially available through provider isolation");
    }
    if (degraded === 0 && unavailable === 0) {
      details.push("fleet reports nominal circuit state across every provider");
    }
    if (healthy + degraded > 0) {
      details.push(`fleet traffic-capable providers=${healthy + degraded}`);
    }
  }
  return { healthy, degraded, unavailable, details };
}
