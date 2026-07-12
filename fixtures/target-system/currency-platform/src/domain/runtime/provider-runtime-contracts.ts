export type RuntimeCircuitMode = "closed" | "open" | "half-open";
export type ProviderSignalKind = "success" | "failure" | "timeout" | "probe-request" | "manual-reset";

export interface ProviderSignal {
  readonly providerId: string;
  readonly kind: ProviderSignalKind;
  readonly occurredAt: Date;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly requestId: string;
}

export interface ProviderRecoveryPolicy {
  readonly failureThreshold: number;
  readonly successThreshold: number;
  readonly openDurationMs: number;
  readonly halfOpenProbeLimit: number;
  readonly observationWindowMs: number;
  readonly timeoutWeight: number;
  readonly nonRetryableWeight: number;
  readonly latencyBudgetMs: number;
  readonly minimumSamples: number;
}

export interface ProviderRecoveryState {
  readonly providerId: string;
  readonly mode: RuntimeCircuitMode;
  readonly openedAt?: Date;
  readonly lastTransitionAt: Date;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  readonly weightedFailures: number;
  readonly halfOpenProbesInFlight: number;
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly latencyTotalMs: number;
  readonly lastErrorCode?: string;
  readonly generation: number;
}

export interface ProviderTransition {
  readonly from: RuntimeCircuitMode;
  readonly to: RuntimeCircuitMode;
  readonly at: Date;
  readonly reason: string;
  readonly signalId?: string;
}

export interface ProviderRecoveryInput {
  readonly state: ProviderRecoveryState;
  readonly signals: readonly ProviderSignal[];
  readonly policy: ProviderRecoveryPolicy;
  readonly evaluatedAt: Date;
  readonly activeRequestIds: readonly string[];
}

export interface ProviderRecoveryPlan {
  readonly state: ProviderRecoveryState;
  readonly transitions: readonly ProviderTransition[];
  readonly acceptTraffic: boolean;
  readonly grantProbe: boolean;
  readonly nextEvaluationAt: Date;
  readonly healthScore: number;
  readonly availabilityBps: number;
  readonly averageLatencyMs: number;
  readonly ignoredSignalIds: readonly string[];
  readonly warnings: readonly string[];
}

export interface ProviderFleetRecoveryReport {
  readonly evaluatedAt: Date;
  readonly healthyProviderIds: readonly string[];
  readonly degradedProviderIds: readonly string[];
  readonly unavailableProviderIds: readonly string[];
  readonly probeCandidates: readonly string[];
  readonly fleetAvailabilityBps: number;
}
