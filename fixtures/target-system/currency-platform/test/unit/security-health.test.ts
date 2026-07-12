import assert from "node:assert/strict";
import test from "node:test";
import { compileComplianceScorecard } from "../../src/domain/compliance/compliance-scorecard.js";
import { evaluateIdentityAccess } from "../../src/domain/operations/identity-access-evaluator.js";
import { planIncidentResponse } from "../../src/domain/operations/incident-response-planner.js";
import { compileTelemetryHealth } from "../../src/domain/operations/telemetry-health-compiler.js";

test("compliance scorecard allows a low-risk documented transfer", () => {
  const evaluatedAt = new Date("2026-07-12T08:00:00.000Z");
  const result = compileComplianceScorecard({
    caseId: "case-1",
    subject: {
      subjectId: "subject-1",
      accountId: "ACC-AB12",
      beneficiaryCountry: "US",
      originCountry: "US",
      currency: "USD",
      amount: "100.00",
      accountAgeDays: 365,
      transfersLast24Hours: 1,
      amountLast30Days: "1000.00",
      sanctionsCandidate: false,
      politicallyExposed: false,
      purposeCode: "GOODS",
    },
    evidence: [],
    factors: [{
      factorId: "low-value",
      category: "large-value-transfer",
      weight: 1,
      minimumScore: 0,
      maximumScore: 10,
      requiredEvidenceKinds: [],
      jurisdictions: ["US"],
      currencies: ["USD"],
      hardStop: false,
      explanation: "Low-value domestic transfer baseline.",
    }],
    policy: {
      reviewScore: 20,
      holdScore: 40,
      rejectScore: 60,
      evidenceExpiryGraceMs: 0,
      minimumTrustScore: 50,
      unknownJurisdictionScore: 10,
      missingPurposeScore: 10,
      newAccountScore: 10,
      velocityScore: 10,
      sanctionsHardStop: true,
    },
    evaluatedAt,
  });
  assert.equal(result.action, "allow");
  assert.equal(result.hardStop, false);
});

test("identity access accepts an active role and sufficient credential", () => {
  const requestedAt = new Date("2026-07-12T08:00:00.000Z");
  const result = evaluateIdentityAccess({
    requestId: "access-1",
    principal: {
      principalId: "user-1",
      kind: "user",
      enabled: true,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      homeRegion: "cn-east",
      riskScore: 10,
      attributes: {},
    },
    credentials: [{
      credentialId: "credential-1",
      principalId: "user-1",
      kind: "mfa",
      issuedAt: new Date("2026-07-12T07:00:00.000Z"),
      expiresAt: new Date("2026-07-12T09:00:00.000Z"),
      authenticatedAt: new Date("2026-07-12T07:59:00.000Z"),
      assuranceLevel: 3,
      scopes: ["quote:read"],
      sourceIp: "10.0.0.5",
    }],
    memberships: [{
      membershipId: "membership-1",
      principalId: "user-1",
      roleId: "quote-reader",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      grantedBy: "security-admin",
      regions: ["cn-east"],
      accountIds: [],
    }],
    grants: [{
      grantId: "grant-1",
      subject: "quote-reader",
      subjectKind: "role",
      resourcePattern: "quotes/USD-EUR",
      actions: ["read"],
      effect: "allow",
      priority: 10,
      requiredAssuranceLevel: 2,
      requiredScopes: ["quote:read"],
      allowedRegions: ["cn-east"],
      requireMfa: true,
      sensitive: false,
    }],
    resource: "quotes/USD-EUR",
    action: "read",
    region: "cn-east",
    sourceIp: "10.0.0.5",
    requestedAt,
    emergencyAccess: false,
  }, {
    maximumCredentialAgeMs: 300_000,
    maximumRiskScore: 90,
    challengeRiskScore: 70,
    minimumSensitiveAssurance: 3,
    emergencyRoleId: "emergency",
    trustedCidrs: ["10.0.0.0/8"],
    blockedCidrs: [],
    defaultDeny: true,
    requireRegionalMatch: true,
    maximumDecisionCacheMs: 60_000,
  });
  assert.equal(result.decision, "allowed");
  assert.deepEqual(result.matchedGrantIds, ["grant-1"]);
});

test("incident planner creates containment and recovery steps", () => {
  const result = planIncidentResponse({
    incidentId: "incident-1",
    signals: [{
      signalId: "signal-1",
      componentId: "quote-api",
      detectedAt: new Date("2026-07-12T07:59:00.000Z"),
      kind: "error-rate",
      value: 20,
      threshold: 10,
      customerImpact: true,
      financialImpact: "1000",
      region: "cn-east",
      labels: {},
    }],
    dependencies: [{
      componentId: "quote-api",
      dependsOn: [],
      ownerTeam: "quotes-on-call",
      criticality: "critical",
      regulated: false,
      recoveryRunbook: "runbook-quote-api",
    }],
    policy: {
      sev1SignalCount: 5,
      sev2SignalCount: 2,
      sev1FinancialImpact: "1000000",
      sev2FinancialImpact: "100000",
      customerImpactEscalates: true,
      containmentDeadlineMs: 300_000,
      recoveryDeadlineMs: 900_000,
      verificationDeadlineMs: 1_200_000,
      communicationCadenceMs: { sev1: 300_000, sev2: 600_000, sev3: 900_000, sev4: 1_800_000 },
      executiveEscalationSeverities: ["sev1"],
      notificationRegions: ["eu-west"],
      maximumAffectedComponents: 20,
    },
    plannedAt: new Date("2026-07-12T08:00:00.000Z"),
    acknowledgedSignalIds: [],
    unavailableTeams: [],
  });
  assert.ok(result.steps.some((step) => step.phase === "contain"));
  assert.ok(result.steps.some((step) => step.phase === "recover"));
});

test("telemetry compiler reports a healthy component", () => {
  const sampledAt = new Date("2026-07-12T08:00:00.000Z");
  const samples = [
    { metric: "availability_bps", value: 9_999, unit: "bps" },
    { metric: "latency_ms", value: 20, unit: "ms" },
    { metric: "error_rate_bps", value: 1, unit: "bps" },
  ].map((sample) => ({
    componentId: "quote-api",
    sampledAt,
    region: "cn-east",
    environment: "test",
    labels: {},
    ...sample,
  }));
  const result = compileTelemetryHealth({
    samples,
    components: [{
      componentId: "quote-api",
      requiredMetrics: ["availability_bps", "latency_ms", "error_rate_bps"],
      dependencyIds: [],
      availabilityTargetBps: 9_990,
      maximumLatencyMs: 100,
      maximumErrorRateBps: 100,
      staleAfterMs: 60_000,
      minimumSamples: 1,
      critical: true,
      weight: 1,
    }],
    metricRules: [
      { metric: "availability_bps", unit: "bps", aggregation: "latest", healthyMinimum: 9_990,
        degradedMinimum: 9_900, scoreWeight: 1, invert: false },
      { metric: "latency_ms", unit: "ms", aggregation: "latest", healthyMaximum: 100,
        degradedMaximum: 500, scoreWeight: 1, invert: false },
      { metric: "error_rate_bps", unit: "bps", aggregation: "latest", healthyMaximum: 100,
        degradedMaximum: 500, scoreWeight: 1, invert: false },
    ],
    evaluatedAt: new Date("2026-07-12T08:00:01.000Z"),
    windowMs: 60_000,
    regions: ["cn-east"],
    environment: "test",
    previousHealth: [],
  });
  assert.equal(result.fleetLevel, "healthy");
  assert.equal(result.components[0]?.level, "healthy");
});
