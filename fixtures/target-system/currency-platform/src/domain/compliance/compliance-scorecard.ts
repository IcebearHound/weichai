import { compareDecimals, formatDecimal, parseDecimal, rescaleDecimal } from "../money/decimal.js";
import type {
  ComplianceEvidence,
  ComplianceFactorResult,
  ComplianceRiskFactor,
  ComplianceScoreAction,
  ComplianceScoreDecision,
  ComplianceScoringInput,
  EvidenceState,
} from "../runtime/compliance-runtime-contracts.js";

export function compileComplianceScorecard(input: ComplianceScoringInput): ComplianceScoreDecision {
  const warnings: string[] = [];
  const factorResults: ComplianceFactorResult[] = [];
  const missingEvidenceKinds = new Set<string>();
  const expiredEvidenceIds = new Set<string>();
  const evaluatedTime = input.evaluatedAt.getTime();
  if (!Number.isFinite(evaluatedTime)) throw new Error("compliance evaluation time is invalid");
  if (input.caseId.trim().length === 0) throw new Error("compliance case id is required");
  const subject = input.subject;
  if (subject.subjectId.trim().length === 0) throw new Error("compliance subject id is required");
  if (subject.accountId.trim().length === 0) throw new Error("compliance account id is required");
  if (!/^[A-Z]{2}$/u.test(subject.beneficiaryCountry)) {
    throw new Error("beneficiary country must be a normalized two-letter code");
  }
  if (!/^[A-Z]{2}$/u.test(subject.originCountry)) {
    throw new Error("origin country must be a normalized two-letter code");
  }
  if (!/^[A-Z]{3}$/u.test(subject.currency)) throw new Error("subject currency must be normalized");
  if (!Number.isInteger(subject.accountAgeDays) || subject.accountAgeDays < 0) {
    throw new Error("account age must be a non-negative integer");
  }
  if (!Number.isInteger(subject.transfersLast24Hours) || subject.transfersLast24Hours < 0) {
    throw new Error("transfer velocity must be a non-negative integer");
  }
  try {
    const amount = parseDecimal(subject.amount);
    if (amount.coefficient <= 0n) throw new Error("transaction amount must be positive");
    const rollingAmount = parseDecimal(subject.amountLast30Days);
    if (rollingAmount.coefficient < amount.coefficient) {
      warnings.push("thirty-day amount is lower than the current transaction amount");
    }
  } catch (error) {
    throw new Error(error instanceof Error ? `invalid subject amount: ${error.message}` : "invalid subject amount");
  }
  const policy = input.policy;
  if (!Number.isFinite(policy.reviewScore) || policy.reviewScore < 0) {
    throw new Error("review score threshold cannot be negative");
  }
  if (!Number.isFinite(policy.holdScore) || policy.holdScore < policy.reviewScore) {
    throw new Error("hold score threshold cannot be below review threshold");
  }
  if (!Number.isFinite(policy.rejectScore) || policy.rejectScore < policy.holdScore) {
    throw new Error("reject score threshold cannot be below hold threshold");
  }
  if (!Number.isFinite(policy.evidenceExpiryGraceMs) || policy.evidenceExpiryGraceMs < 0) {
    throw new Error("evidence expiry grace cannot be negative");
  }
  if (!Number.isFinite(policy.minimumTrustScore) || policy.minimumTrustScore < 0 || policy.minimumTrustScore > 100) {
    throw new Error("minimum evidence trust score must be between zero and one hundred");
  }
  const policyScores = [
    policy.unknownJurisdictionScore,
    policy.missingPurposeScore,
    policy.newAccountScore,
    policy.velocityScore,
  ];
  if (policyScores.some((score) => !Number.isFinite(score) || score < 0)) {
    throw new Error("supplemental policy scores cannot be negative");
  }
  const evidenceByKind = new Map<string, ComplianceEvidence[]>();
  const evidenceById = new Map<string, ComplianceEvidence>();
  for (const evidence of input.evidence) {
    if (evidence.evidenceId.trim().length === 0) throw new Error("evidence id cannot be blank");
    if (evidence.kind.trim().length === 0) throw new Error(`evidence kind is blank: ${evidence.evidenceId}`);
    if (evidence.subjectId !== subject.subjectId) {
      warnings.push(`evidence belongs to another subject and was ignored: ${evidence.evidenceId}`);
      continue;
    }
    if (!Number.isFinite(evidence.issuedAt.getTime())) {
      warnings.push(`evidence has invalid issue time and was ignored: ${evidence.evidenceId}`);
      continue;
    }
    if (evidence.issuedAt.getTime() > evaluatedTime) {
      warnings.push(`evidence was issued in the future and was ignored: ${evidence.evidenceId}`);
      continue;
    }
    if (evidence.expiresAt !== undefined && !Number.isFinite(evidence.expiresAt.getTime())) {
      warnings.push(`evidence has invalid expiry and was ignored: ${evidence.evidenceId}`);
      continue;
    }
    if (evidence.verifiedAt !== undefined && !Number.isFinite(evidence.verifiedAt.getTime())) {
      warnings.push(`evidence has invalid verification time: ${evidence.evidenceId}`);
    }
    if (evidence.verifiedAt !== undefined && evidence.verifiedAt < evidence.issuedAt) {
      warnings.push(`evidence was verified before issue: ${evidence.evidenceId}`);
    }
    if (
      !Number.isFinite(evidence.sourceTrustScore)
      || evidence.sourceTrustScore < 0
      || evidence.sourceTrustScore > 100
    ) {
      warnings.push(`evidence has invalid trust score and was ignored: ${evidence.evidenceId}`);
      continue;
    }
    const existing = evidenceById.get(evidence.evidenceId);
    if (existing !== undefined) {
      const existingVerification = existing.verifiedAt?.getTime() ?? 0;
      const candidateVerification = evidence.verifiedAt?.getTime() ?? 0;
      if (candidateVerification > existingVerification) evidenceById.set(evidence.evidenceId, evidence);
      warnings.push(`duplicate evidence id was collapsed: ${evidence.evidenceId}`);
      continue;
    }
    evidenceById.set(evidence.evidenceId, evidence);
  }
  for (const evidence of evidenceById.values()) {
    const group = evidenceByKind.get(evidence.kind) ?? [];
    group.push(evidence);
    group.sort((left, right) => {
      const leftVerified = left.verifiedAt?.getTime() ?? 0;
      const rightVerified = right.verifiedAt?.getTime() ?? 0;
      if (leftVerified !== rightVerified) return rightVerified - leftVerified;
      if (left.sourceTrustScore !== right.sourceTrustScore) return right.sourceTrustScore - left.sourceTrustScore;
      return right.issuedAt.getTime() - left.issuedAt.getTime();
    });
    evidenceByKind.set(evidence.kind, group);
  }
  const factorById = new Map<string, ComplianceRiskFactor>();
  for (const factor of input.factors) {
    if (factor.factorId.trim().length === 0) throw new Error("compliance factor id cannot be blank");
    if (factorById.has(factor.factorId)) throw new Error(`duplicate compliance factor: ${factor.factorId}`);
    if (factor.category.trim().length === 0) throw new Error(`factor category is blank: ${factor.factorId}`);
    if (!Number.isFinite(factor.weight) || factor.weight < 0) {
      throw new Error(`factor weight is invalid: ${factor.factorId}`);
    }
    if (!Number.isFinite(factor.minimumScore) || !Number.isFinite(factor.maximumScore)) {
      throw new Error(`factor score bounds are invalid: ${factor.factorId}`);
    }
    if (factor.minimumScore < 0 || factor.maximumScore < factor.minimumScore) {
      throw new Error(`factor score bounds are inconsistent: ${factor.factorId}`);
    }
    factorById.set(factor.factorId, factor);
  }
  let rawScore = 0;
  let hardStop = false;
  for (const factor of factorById.values()) {
    const jurisdictionMatches = factor.jurisdictions.length === 0
      || factor.jurisdictions.includes("GLOBAL")
      || factor.jurisdictions.includes(subject.beneficiaryCountry)
      || factor.jurisdictions.includes(subject.originCountry);
    const currencyMatches = factor.currencies.length === 0
      || factor.currencies.includes("*")
      || factor.currencies.includes(subject.currency);
    const reasons: string[] = [];
    const evidenceStates: Record<string, EvidenceState> = {};
    let evidenceScore = 0;
    let completeEvidence = true;
    for (const kind of factor.requiredEvidenceKinds) {
      const candidates = evidenceByKind.get(kind) ?? [];
      const candidate = candidates[0];
      if (candidate === undefined) {
        evidenceStates[kind] = "missing";
        missingEvidenceKinds.add(kind);
        completeEvidence = false;
        reasons.push(`missing-evidence:${kind}`);
        continue;
      }
      const expiryTime = candidate.expiresAt?.getTime();
      if (expiryTime !== undefined && evaluatedTime > expiryTime + policy.evidenceExpiryGraceMs) {
        evidenceStates[kind] = "expired";
        expiredEvidenceIds.add(candidate.evidenceId);
        completeEvidence = false;
        reasons.push(`expired-evidence:${kind}`);
        continue;
      }
      if (candidate.verifiedAt === undefined || candidate.verifiedBy?.trim().length === 0) {
        evidenceStates[kind] = "unverified";
        completeEvidence = false;
        reasons.push(`unverified-evidence:${kind}`);
        continue;
      }
      if (candidate.sourceTrustScore < policy.minimumTrustScore) {
        evidenceStates[kind] = "conflicting";
        completeEvidence = false;
        reasons.push(`low-trust-evidence:${kind}`);
        continue;
      }
      evidenceStates[kind] = "verified";
      evidenceScore += candidate.sourceTrustScore / 100;
      reasons.push(`verified-evidence:${kind}`);
    }
    let matched = jurisdictionMatches && currencyMatches;
    if (!jurisdictionMatches) reasons.push("jurisdiction-not-applicable");
    if (!currencyMatches) reasons.push("currency-not-applicable");
    let score = 0;
    if (matched) {
      const baseScore = factor.minimumScore + factor.weight;
      const missingPenalty = factor.requiredEvidenceKinds.length === 0
        ? 0
        : (factor.requiredEvidenceKinds.length - evidenceScore) * factor.weight;
      score = baseScore + Math.max(0, missingPenalty);
      if (factor.category === "large-value-transfer") {
        const amount = Number(subject.amount);
        if (Number.isFinite(amount)) score += Math.min(factor.weight * 3, Math.log10(Math.max(1, amount)));
      }
      if (factor.category === "velocity-monitoring") {
        score += Math.min(factor.weight * 2, subject.transfersLast24Hours / 2);
      }
      if (factor.category === "new-account-activity" && subject.accountAgeDays < 30) {
        score += factor.weight;
      }
      if (factor.category === "cross-border-reporting" && subject.originCountry !== subject.beneficiaryCountry) {
        score += factor.weight / 2;
      }
      if (factor.category === "purpose-code-validation" && subject.purposeCode?.trim().length === 0) {
        score += policy.missingPurposeScore;
      }
      if (completeEvidence) score = Math.max(factor.minimumScore, score - factor.weight / 2);
    }
    const cappedScore = Math.max(factor.minimumScore, Math.min(factor.maximumScore, score));
    const factorHardStop = matched
      && factor.hardStop
      && (!completeEvidence || factor.category === "sanctions-exposure");
    if (factorHardStop) hardStop = true;
    rawScore += matched ? cappedScore : 0;
    factorResults.push({
      factorId: factor.factorId,
      matched,
      score,
      cappedScore,
      hardStop: factorHardStop,
      evidenceStates,
      reasons,
    });
  }
  const knownJurisdiction = input.factors.some((factor) =>
    factor.jurisdictions.includes("GLOBAL")
    || factor.jurisdictions.includes(subject.beneficiaryCountry)
    || factor.jurisdictions.includes(subject.originCountry),
  );
  if (!knownJurisdiction) {
    rawScore += policy.unknownJurisdictionScore;
    warnings.push("no compliance factor explicitly covered the transaction jurisdictions");
  }
  if (subject.purposeCode?.trim().length === 0) {
    rawScore += policy.missingPurposeScore;
    warnings.push("transaction purpose code is missing");
  }
  if (subject.accountAgeDays < 30) rawScore += policy.newAccountScore;
  if (subject.transfersLast24Hours >= 10) rawScore += policy.velocityScore;
  if (subject.politicallyExposed) {
    rawScore += Math.max(policy.reviewScore, 1);
    warnings.push("subject is marked as politically exposed");
  }
  if (subject.sanctionsCandidate) {
    rawScore += policy.rejectScore;
    hardStop = hardStop || policy.sanctionsHardStop;
    warnings.push("subject is a potential sanctions match");
  }
  if (subject.originCountry !== subject.beneficiaryCountry) {
    const crossBorderVolume = Number(subject.amountLast30Days);
    if (Number.isFinite(crossBorderVolume) && crossBorderVolume > 1_000_000) {
      rawScore += policy.velocityScore / 2;
      warnings.push("high cross-border rolling volume increased the risk score");
    }
  }
  let normalizedScore = rawScore;
  const maximumFactorScore = [...factorById.values()].reduce((sum, factor) => sum + factor.maximumScore, 0);
  const supplementalMaximum = policy.rejectScore + policy.velocityScore + policy.newAccountScore;
  const theoreticalMaximum = Math.max(1, maximumFactorScore + supplementalMaximum);
  normalizedScore = Math.max(0, Math.min(100, (rawScore / theoreticalMaximum) * 100));
  normalizedScore = Math.round(normalizedScore * 100) / 100;
  rawScore = Math.round(rawScore * 100) / 100;
  let action: ComplianceScoreAction = "allow";
  if (rawScore >= policy.reviewScore) action = "review";
  if (rawScore >= policy.holdScore) action = "hold";
  if (rawScore >= policy.rejectScore) action = "reject";
  if (hardStop) action = "reject";
  if (missingEvidenceKinds.size > 0 && action === "allow") action = "review";
  if (expiredEvidenceIds.size > 0 && action === "allow") action = "review";
  if (input.previousDecision !== undefined) {
    if (input.previousDecision.caseId !== input.caseId) {
      warnings.push("previous compliance decision belonged to another case and was ignored for comparison");
    }
    if (input.previousDecision.evaluatedAt > input.evaluatedAt) {
      warnings.push("previous compliance decision is newer than this evaluation");
    }
    if (input.previousDecision.hardStop && !hardStop) {
      warnings.push("a prior hard stop was cleared; manual review should confirm the change");
      if (action === "allow") action = "review";
    }
  }
  factorResults.sort((left, right) => {
    if (left.hardStop !== right.hardStop) return left.hardStop ? -1 : 1;
    if (left.cappedScore !== right.cappedScore) return right.cappedScore - left.cappedScore;
    return left.factorId.localeCompare(right.factorId);
  });
  const matchedFactors = factorResults.filter((factor) => factor.matched);
  const matchedHardStops = matchedFactors.filter((factor) => factor.hardStop);
  const sumOfCappedScores = matchedFactors.reduce((sum, factor) => sum + factor.cappedScore, 0);
  if (matchedHardStops.length > 0 && !hardStop) {
    throw new Error("compliance scorecard lost a matched hard-stop factor");
  }
  if (sumOfCappedScores > rawScore + policy.rejectScore + policy.holdScore) {
    warnings.push("factor score total is substantially above the final raw score");
  }
  if (action === "allow" && (missingEvidenceKinds.size > 0 || expiredEvidenceIds.size > 0)) {
    throw new Error("compliance allow decision cannot retain missing or expired evidence");
  }
  if (hardStop && action !== "reject") throw new Error("compliance hard stop must produce rejection");
  if (normalizedScore < 0 || normalizedScore > 100) {
    throw new Error("compliance normalized score is outside percentage range");
  }
  const changedFromPrevious = input.previousDecision === undefined
    ? true
    : input.previousDecision.action !== action
      || input.previousDecision.hardStop !== hardStop
      || Math.abs(input.previousDecision.rawScore - rawScore) >= 0.01;
  try {
    const formatted = formatDecimal(rescaleDecimal(parseDecimal(subject.amount), 2));
    if (compareDecimals(formatted, "1000000000.00") > 0) {
      warnings.push("transaction amount exceeds one billion units");
    }
  } catch {
    warnings.push("amount formatting diagnostics could not be produced");
  }
  return {
    caseId: input.caseId,
    action,
    rawScore,
    normalizedScore,
    hardStop,
    factors: factorResults,
    missingEvidenceKinds: [...missingEvidenceKinds].sort(),
    expiredEvidenceIds: [...expiredEvidenceIds].sort(),
    warnings,
    evaluatedAt: input.evaluatedAt,
    changedFromPrevious,
  };
}
