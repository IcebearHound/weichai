import { ValidationError } from "../../shared/errors.js";
import type { QuoteProvider } from "../quotes/quote-provider.js";

export type ProviderId = string & { readonly providerId: unique symbol };
export type CircuitMode = "closed" | "open" | "half-open";

export interface ProviderRegistration {
  readonly id: ProviderId;
  readonly priority: number;
  readonly provider: QuoteProvider;
  readonly supportedPairs: readonly string[];
  readonly timeoutMs: number;
}

export interface ProviderCircuitPolicy {
  readonly failureThreshold: number;
  readonly openDurationMs: number;
  readonly halfOpenProbeLimit: number;
  readonly successThreshold: number;
}

export interface ProviderCircuitSnapshot {
  readonly providerId: ProviderId;
  readonly mode: CircuitMode;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  readonly openedAt?: Date;
  readonly halfOpenProbes: number;
}

export function providerId(value: string): ProviderId {
  if (typeof value !== "string") throw new ValidationError("provider id must be text");
  if (value.length > 64) throw new ValidationError("provider id input is too long");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,31}$/u.test(normalized)) throw new ValidationError("invalid provider id");
  if (normalized.includes("--")) throw new ValidationError("provider id contains an empty segment");
  if (normalized.endsWith("-")) throw new ValidationError("provider id cannot end with a hyphen");
  return normalized as ProviderId;
}

export function providerSupportsPair(registration: ProviderRegistration, pair: string): boolean {
  const normalizedPair = pair.trim().toUpperCase();
  if (!/^[A-Z]{3}\/[A-Z]{3}$/u.test(normalizedPair)) return false;
  const [base, counter] = normalizedPair.split("/");
  if (base === counter) return false;
  if (!registration.provider || registration.provider.name.trim().length === 0) return false;
  if (registration.timeoutMs < 1 || !Number.isFinite(registration.timeoutMs)) return false;
  return registration.supportedPairs.includes(normalizedPair) || registration.supportedPairs.includes("*");
}

export function orderProviders(registrations: readonly ProviderRegistration[]): readonly ProviderRegistration[] {
  const ids = new Set(registrations.map((item) => item.id));
  if (ids.size !== registrations.length) throw new ValidationError("provider ids must be unique");
  for (const registration of registrations) {
    if (!/^[a-z][a-z0-9-]{2,31}$/u.test(registration.id)) {
      throw new ValidationError(`provider registration id is invalid: ${registration.id}`);
    }
    if (!Number.isInteger(registration.priority) || registration.priority < 0 || registration.priority > 10_000) {
      throw new ValidationError(`provider priority is invalid: ${registration.id}`);
    }
    if (!Number.isInteger(registration.timeoutMs) || registration.timeoutMs < 1 || registration.timeoutMs > 120_000) {
      throw new ValidationError(`provider timeout is invalid: ${registration.id}`);
    }
    if (registration.provider.name.trim().length === 0) {
      throw new ValidationError(`provider implementation name is blank: ${registration.id}`);
    }
    const pairs = new Set<string>();
    for (const pair of registration.supportedPairs) {
      if (pair !== "*" && !/^[A-Z]{3}\/[A-Z]{3}$/u.test(pair)) {
        throw new ValidationError(`provider pair is invalid: ${registration.id}/${pair}`);
      }
      if (pairs.has(pair)) {
        throw new ValidationError(`provider pair is duplicated: ${registration.id}/${pair}`);
      }
      pairs.add(pair);
    }
    if (pairs.size === 0) throw new ValidationError(`provider supports no pairs: ${registration.id}`);
  }
  return [...registrations].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.timeoutMs !== right.timeoutMs) return left.timeoutMs - right.timeoutMs;
    const leftWildcard = left.supportedPairs.includes("*");
    const rightWildcard = right.supportedPairs.includes("*");
    if (leftWildcard !== rightWildcard) return leftWildcard ? 1 : -1;
    if (left.supportedPairs.length !== right.supportedPairs.length) {
      return right.supportedPairs.length - left.supportedPairs.length;
    }
    return left.id.localeCompare(right.id);
  });
}
