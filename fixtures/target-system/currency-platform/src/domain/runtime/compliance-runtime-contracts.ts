export type ComplianceScoreAction = "allow" | "review" | "hold" | "reject";
export type EvidenceState = "missing" | "expired" | "unverified" | "verified" | "conflicting";

export interface ComplianceEvidence {
  readonly evidenceId: string;
  readonly kind: string;
  readonly issuedAt: Date;
  readonly expiresAt?: Date;
  readonly verifiedAt?: Date;
  readonly verifiedBy?: string;
  readonly subjectId: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly sourceTrustScore: number;
}

export interface ComplianceRiskFactor {
  readonly factorId: string;
  readonly category: string;
  readonly weight: number;
  readonly minimumScore: number;
  readonly maximumScore: number;
  readonly requiredEvidenceKinds: readonly string[];
  readonly jurisdictions: readonly string[];
  readonly currencies: readonly string[];
  readonly hardStop: boolean;
  readonly explanation: string;
}

export interface ComplianceCaseSubject {
  readonly subjectId: string;
  readonly accountId: string;
  readonly beneficiaryCountry: string;
  readonly originCountry: string;
  readonly currency: string;
  readonly amount: string;
  readonly accountAgeDays: number;
  readonly transfersLast24Hours: number;
  readonly amountLast30Days: string;
  readonly sanctionsCandidate: boolean;
  readonly politicallyExposed: boolean;
  readonly purposeCode?: string;
}

export interface ComplianceScoringPolicy {
  readonly reviewScore: number;
  readonly holdScore: number;
  readonly rejectScore: number;
  readonly evidenceExpiryGraceMs: number;
  readonly minimumTrustScore: number;
  readonly unknownJurisdictionScore: number;
  readonly missingPurposeScore: number;
  readonly newAccountScore: number;
  readonly velocityScore: number;
  readonly sanctionsHardStop: boolean;
}

export interface ComplianceScoringInput {
  readonly caseId: string;
  readonly subject: ComplianceCaseSubject;
  readonly evidence: readonly ComplianceEvidence[];
  readonly factors: readonly ComplianceRiskFactor[];
  readonly policy: ComplianceScoringPolicy;
  readonly evaluatedAt: Date;
  readonly previousDecision?: ComplianceScoreDecision;
}

export interface ComplianceFactorResult {
  readonly factorId: string;
  readonly matched: boolean;
  readonly score: number;
  readonly cappedScore: number;
  readonly hardStop: boolean;
  readonly evidenceStates: Readonly<Record<string, EvidenceState>>;
  readonly reasons: readonly string[];
}

export interface ComplianceScoreDecision {
  readonly caseId: string;
  readonly action: ComplianceScoreAction;
  readonly rawScore: number;
  readonly normalizedScore: number;
  readonly hardStop: boolean;
  readonly factors: readonly ComplianceFactorResult[];
  readonly missingEvidenceKinds: readonly string[];
  readonly expiredEvidenceIds: readonly string[];
  readonly warnings: readonly string[];
  readonly evaluatedAt: Date;
  readonly changedFromPrevious: boolean;
}
