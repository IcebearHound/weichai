export type QuotePlanningSeverity = "info" | "warning" | "blocking";
export type QuoteAcquisitionMode = "cache" | "provider" | "stale" | "unavailable";
export type QuoteMarketState = "open" | "thin" | "closed" | "unknown";

export interface QuotePlanningIssue {
  readonly code: string;
  readonly severity: QuotePlanningSeverity;
  readonly field?: string;
  readonly message: string;
}

export interface QuoteCacheObservation {
  readonly pair: string;
  readonly bid: string;
  readonly ask: string;
  readonly providerId: string;
  readonly observedAt: Date;
  readonly storedAt: Date;
  readonly expiresAt: Date;
  readonly staleUntil: Date;
  readonly checksumValid: boolean;
}

export interface QuoteProviderObservation {
  readonly providerId: string;
  readonly priority: number;
  readonly supportedPairs: readonly string[];
  readonly available: boolean;
  readonly circuitMode: "closed" | "open" | "half-open";
  readonly latencyP50Ms: number;
  readonly latencyP99Ms: number;
  readonly failureRateBps: number;
  readonly capacity: number;
  readonly region: string;
}

export interface QuotePlanningPolicy {
  readonly freshTtlMs: number;
  readonly staleTtlMs: number;
  readonly providerTimeoutMs: number;
  readonly maximumSpreadBps: number;
  readonly maximumAmount: string;
  readonly allowInversePair: boolean;
  readonly allowStaleWhenClosed: boolean;
  readonly requiredProviderCapacity: number;
  readonly preferredRegions: readonly string[];
}

export interface QuotePlanningInput {
  readonly base: string;
  readonly counter: string;
  readonly amount: string;
  readonly requestedAt: Date;
  readonly correlationId: string;
  readonly marketState: QuoteMarketState;
  readonly cache: readonly QuoteCacheObservation[];
  readonly providers: readonly QuoteProviderObservation[];
  readonly inFlightPairs: readonly string[];
  readonly policy: QuotePlanningPolicy;
}

export interface QuoteProviderStep {
  readonly providerId: string;
  readonly ordinal: number;
  readonly timeoutMs: number;
  readonly startAfterMs: number;
  readonly halfOpenProbe: boolean;
  readonly regionPreference: number;
  readonly rationale: readonly string[];
}

export interface QuoteCacheDecision {
  readonly key: string;
  readonly usable: boolean;
  readonly fresh: boolean;
  readonly stale: boolean;
  readonly ageMs: number;
  readonly spreadBps?: number;
  readonly rejectionReasons: readonly string[];
}

export interface QuoteAcquisitionPlan {
  readonly pair: string;
  readonly inversePair: string;
  readonly normalizedAmount: string;
  readonly mode: QuoteAcquisitionMode;
  readonly cacheDecision?: QuoteCacheDecision;
  readonly providerSteps: readonly QuoteProviderStep[];
  readonly joinExistingRequest: boolean;
  readonly deadlineAt: Date;
  readonly staleFallbackKey?: string;
  readonly issues: readonly QuotePlanningIssue[];
  readonly diagnostics: Readonly<Record<string, string | number | boolean>>;
}

export interface QuoteLifecycleCheckpoint {
  readonly phase: "received" | "validated" | "cache-read" | "provider-call" | "completed";
  readonly at: Date;
  readonly elapsedMs: number;
  readonly detail: string;
}

export interface QuoteLifecycleTrace {
  readonly correlationId: string;
  readonly pair: string;
  readonly checkpoints: readonly QuoteLifecycleCheckpoint[];
  readonly selectedProvider?: string;
  readonly cacheOutcome?: string;
  readonly finalMode: QuoteAcquisitionMode;
}
