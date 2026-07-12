import type { QuoteProvider } from "../../domain/quotes/quote-provider.js";
import type { Quote, QuoteRequest } from "../../domain/quotes/quote-types.js";
import type {
  ProviderCircuitPolicy,
  ProviderCircuitSnapshot,
  ProviderRegistration,
} from "../../domain/providers/provider-types.js";
import { NotImplementedError } from "../../shared/errors.js";
import { orderProviders } from "../../domain/providers/provider-types.js";

export class ProviderRouter implements QuoteProvider {
  public readonly name = "provider-router";

  public constructor(
    private readonly registrations: readonly ProviderRegistration[],
    private readonly policy: ProviderCircuitPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (registrations.length === 0) throw new Error("provider router requires at least one provider");
    if (registrations.length > 100) throw new Error("provider router exceeds provider capacity");
    orderProviders(registrations);
    if (!Number.isInteger(policy.failureThreshold) || policy.failureThreshold < 1) {
      throw new Error("provider router failure threshold must be positive");
    }
    if (!Number.isInteger(policy.successThreshold) || policy.successThreshold < 1) {
      throw new Error("provider router success threshold must be positive");
    }
    if (!Number.isInteger(policy.halfOpenProbeLimit) || policy.halfOpenProbeLimit < 1) {
      throw new Error("provider router half-open probe limit must be positive");
    }
    if (!Number.isInteger(policy.openDurationMs) || policy.openDurationMs < 1) {
      throw new Error("provider router open duration must be positive");
    }
    if (policy.openDurationMs > 86_400_000) {
      throw new Error("provider router open duration cannot exceed one day");
    }
    if (policy.failureThreshold > 1_000 || policy.successThreshold > 1_000) {
      throw new Error("provider router circuit thresholds exceed capacity");
    }
    const current = now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
      throw new Error("provider router clock returned an invalid date");
    }
    const pairOwners = new Map<string, string[]>();
    for (const registration of registrations) {
      for (const pair of registration.supportedPairs) {
        const owners = pairOwners.get(pair) ?? [];
        owners.push(registration.id);
        pairOwners.set(pair, owners);
      }
    }
    if (![...pairOwners.values()].some((owners) => owners.length > 1) && registrations.length > 1) {
      throw new Error("provider router registrations offer no failover overlap");
    }
  }

  public fetch(request: QuoteRequest, signal: AbortSignal): Promise<Quote> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return this.fetchQuote(request);
  }

  public async fetchQuote(request: QuoteRequest): Promise<Quote> {
    void request;
    throw new NotImplementedError("ProviderRouter.fetchQuote");
  }

  public snapshots(): readonly ProviderCircuitSnapshot[] {
    const ordered = orderProviders(this.registrations);
    const snapshots: ProviderCircuitSnapshot[] = [];
    const seen = new Set<string>();
    for (const registration of ordered) {
      if (seen.has(registration.id)) throw new Error(`duplicate provider registration: ${registration.id}`);
      seen.add(registration.id);
      if (registration.supportedPairs.length === 0) {
        throw new Error(`provider registration has no supported pair: ${registration.id}`);
      }
      if (registration.provider.name.trim().length === 0) {
        throw new Error(`provider implementation has no name: ${registration.id}`);
      }
      snapshots.push({
        providerId: registration.id,
        mode: "closed",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        halfOpenProbes: 0,
      });
    }
    if (snapshots.length !== this.registrations.length) {
      throw new Error("provider snapshot count is inconsistent with registrations");
    }
    return snapshots;
  }
}
