export type RetentionAction = "retain" | "archive" | "delete" | "hold" | "anonymize";
export type IncidentSeverity = "sev1" | "sev2" | "sev3" | "sev4";
export type HealthLevel = "healthy" | "degraded" | "unavailable" | "unknown";

export interface RetentionRecord {
  readonly recordId: string;
  readonly category: string;
  readonly jurisdiction: string;
  readonly createdAt: Date;
  readonly lastAccessedAt?: Date;
  readonly containsPersonalData: boolean;
  readonly immutable: boolean;
  readonly legalHoldIds: readonly string[];
  readonly byteCount: number;
  readonly storageTier: string;
}

export interface RetentionRule {
  readonly ruleId: string;
  readonly category: string;
  readonly jurisdiction: string;
  readonly retainDays: number;
  readonly archiveAfterDays?: number;
  readonly anonymizeAfterDays?: number;
  readonly deleteAllowed: boolean;
  readonly immutable: boolean;
  readonly priority: number;
}

export interface RetentionPlanItem {
  readonly recordId: string;
  readonly action: RetentionAction;
  readonly effectiveAt: Date;
  readonly ruleId?: string;
  readonly destinationTier?: string;
  readonly reasons: readonly string[];
  readonly estimatedBytes: number;
}

export interface RetentionPlan {
  readonly evaluatedAt: Date;
  readonly items: readonly RetentionPlanItem[];
  readonly retainedCount: number;
  readonly archivedCount: number;
  readonly deletedCount: number;
  readonly heldCount: number;
  readonly anonymizedCount: number;
  readonly bytesByAction: Readonly<Record<RetentionAction, number>>;
  readonly warnings: readonly string[];
}

export interface IncidentSignal {
  readonly signalId: string;
  readonly componentId: string;
  readonly detectedAt: Date;
  readonly kind: string;
  readonly value: number;
  readonly threshold: number;
  readonly customerImpact: boolean;
  readonly financialImpact: string;
  readonly region: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface IncidentResponseStep {
  readonly stepId: string;
  readonly phase: "detect" | "contain" | "recover" | "verify" | "communicate";
  readonly ownerTeam: string;
  readonly action: string;
  readonly startsAt: Date;
  readonly deadline: Date;
  readonly dependencies: readonly string[];
  readonly automated: boolean;
  readonly evidenceRequired: readonly string[];
}

export interface IncidentResponsePlan {
  readonly incidentId: string;
  readonly severity: IncidentSeverity;
  readonly title: string;
  readonly affectedComponents: readonly string[];
  readonly affectedRegions: readonly string[];
  readonly steps: readonly IncidentResponseStep[];
  readonly communicationCadenceMs: number;
  readonly executiveEscalation: boolean;
  readonly regulatoryNotification: boolean;
  readonly diagnostics: readonly string[];
}

export interface TelemetrySample {
  readonly componentId: string;
  readonly metric: string;
  readonly sampledAt: Date;
  readonly value: number;
  readonly unit: string;
  readonly region: string;
  readonly environment: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ComponentHealth {
  readonly componentId: string;
  readonly level: HealthLevel;
  readonly score: number;
  readonly availabilityBps: number;
  readonly latencyMs: number;
  readonly errorRateBps: number;
  readonly reasons: readonly string[];
  readonly lastSampleAt?: Date;
}
