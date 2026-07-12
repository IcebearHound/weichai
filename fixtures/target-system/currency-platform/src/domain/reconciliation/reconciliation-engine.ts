import { addDecimals, compareDecimals, formatDecimal, parseDecimal, rescaleDecimal } from "../money/decimal.js";
import type {
  ReconciliationExternalLine,
  ReconciliationInternalLine,
  ReconciliationMatch,
  ReconciliationOutcome,
  ReconciliationResult,
} from "../runtime/finance-runtime-contracts.js";

export interface ReconciliationPolicy {
  readonly amountTolerance: string;
  readonly maximumDateDifferenceDays: number;
  readonly exactReferenceScore: number;
  readonly ledgerReferenceScore: number;
  readonly amountScore: number;
  readonly dateScore: number;
  readonly accountScore: number;
  readonly descriptionScore: number;
  readonly counterpartyScore: number;
  readonly minimumMatchScore: number;
  readonly ambiguousScoreDistance: number;
  readonly allowManyToOne: boolean;
  readonly maximumCombinationSize: number;
  readonly caseInsensitiveReferences: boolean;
  readonly ignoreReferencePunctuation: boolean;
}

export interface ReconciliationInput {
  readonly external: readonly ReconciliationExternalLine[];
  readonly internal: readonly ReconciliationInternalLine[];
  readonly policy: ReconciliationPolicy;
  readonly evaluatedAt: Date;
  readonly expectedCurrencies: readonly string[];
  readonly restrictedAccountCodes: readonly string[];
}

interface NormalizedExternal {
  readonly source: ReconciliationExternalLine;
  readonly amountCoefficient: bigint;
  readonly amountScale: number;
  readonly date: Date;
  readonly normalizedReference?: string;
  readonly normalizedDescription: string;
}

interface NormalizedInternal {
  readonly source: ReconciliationInternalLine;
  readonly amountCoefficient: bigint;
  readonly amountScale: number;
  readonly date: Date;
  readonly normalizedReference?: string;
}

interface CandidateMatch {
  readonly external: NormalizedExternal;
  readonly internal: NormalizedInternal;
  readonly score: number;
  readonly difference: string;
  readonly dateDifferenceDays: number;
  readonly reasons: readonly string[];
}

export function reconcileLedgerLines(input: ReconciliationInput): ReconciliationResult {
  const diagnostics: string[] = [];
  const matches: ReconciliationMatch[] = [];
  const evaluatedTime = input.evaluatedAt.getTime();
  if (!Number.isFinite(evaluatedTime)) throw new Error("reconciliation evaluation time is invalid");
  const policy = input.policy;
  const tolerance = parseDecimal(policy.amountTolerance);
  if (tolerance.coefficient < 0n) throw new Error("reconciliation amount tolerance cannot be negative");
  if (!Number.isInteger(policy.maximumDateDifferenceDays) || policy.maximumDateDifferenceDays < 0) {
    throw new Error("maximum reconciliation date difference cannot be negative");
  }
  const scoreFields = [
    policy.exactReferenceScore,
    policy.ledgerReferenceScore,
    policy.amountScore,
    policy.dateScore,
    policy.accountScore,
    policy.descriptionScore,
    policy.counterpartyScore,
    policy.minimumMatchScore,
    policy.ambiguousScoreDistance,
  ];
  if (scoreFields.some((score) => !Number.isFinite(score) || score < 0)) {
    throw new Error("reconciliation scores must be finite and non-negative");
  }
  if (policy.minimumMatchScore === 0) diagnostics.push("minimum match score is zero; weak matches may be accepted");
  if (policy.ambiguousScoreDistance > policy.minimumMatchScore) {
    diagnostics.push("ambiguous score distance exceeds minimum match score");
  }
  if (!Number.isInteger(policy.maximumCombinationSize) || policy.maximumCombinationSize < 2) {
    if (policy.allowManyToOne) throw new Error("maximum combination size must be at least two");
  }
  if (policy.maximumCombinationSize > 4) {
    throw new Error("maximum reconciliation combination size cannot exceed four");
  }
  const expectedCurrencies = new Set(input.expectedCurrencies);
  for (const currency of expectedCurrencies) {
    if (!/^[A-Z]{3}$/u.test(currency)) throw new Error(`invalid expected currency: ${currency}`);
  }
  const restrictedAccounts = new Set(input.restrictedAccountCodes);
  const normalizeReference = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    let normalized = value.trim();
    if (normalized.length === 0) return undefined;
    if (policy.caseInsensitiveReferences) normalized = normalized.toUpperCase();
    if (policy.ignoreReferencePunctuation) normalized = normalized.replace(/[^A-Z0-9]/giu, "");
    return normalized.length === 0 ? undefined : normalized;
  };
  const parseDate = (value: string, identity: string): Date => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`invalid value date format: ${identity}`);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error(`invalid value date: ${identity}`);
    }
    return date;
  };
  const externalById = new Map<string, NormalizedExternal>();
  for (const line of input.external) {
    if (line.lineId.trim().length === 0) throw new Error("external line id cannot be blank");
    if (externalById.has(line.lineId)) throw new Error(`duplicate external line: ${line.lineId}`);
    if (line.accountCode.trim().length === 0) throw new Error(`external account is blank: ${line.lineId}`);
    if (!/^[A-Z]{3}$/u.test(line.currency)) throw new Error(`external currency is invalid: ${line.lineId}`);
    if (expectedCurrencies.size > 0 && !expectedCurrencies.has(line.currency)) {
      diagnostics.push(`external line uses unexpected currency: ${line.lineId}/${line.currency}`);
    }
    const amount = parseDecimal(line.amount);
    if (amount.coefficient === 0n) diagnostics.push(`external line has zero amount: ${line.lineId}`);
    if (amount.scale > 8) diagnostics.push(`external line has high amount precision: ${line.lineId}`);
    const date = parseDate(line.valueDate, line.lineId);
    if (date.getTime() > evaluatedTime + 86_400_000) {
      diagnostics.push(`external line has a future value date: ${line.lineId}`);
    }
    if (restrictedAccounts.has(line.accountCode)) {
      diagnostics.push(`external line belongs to restricted account: ${line.lineId}`);
    }
    const normalizedReference = normalizeReference(line.externalReference);
    const normalizedDescription = line.description
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/gu, " ")
      .replace(/\s+/gu, " ");
    const normalizedBase = {
      source: line,
      amountCoefficient: amount.coefficient,
      amountScale: amount.scale,
      date,
      normalizedDescription,
    };
    externalById.set(
      line.lineId,
      normalizedReference === undefined
        ? normalizedBase
        : { ...normalizedBase, normalizedReference },
    );
  }
  const internalById = new Map<string, NormalizedInternal>();
  for (const line of input.internal) {
    if (line.postingId.trim().length === 0) throw new Error("internal posting id cannot be blank");
    if (internalById.has(line.postingId)) throw new Error(`duplicate internal posting: ${line.postingId}`);
    if (line.accountCode.trim().length === 0) throw new Error(`internal account is blank: ${line.postingId}`);
    if (!/^[A-Z]{3}$/u.test(line.currency)) throw new Error(`internal currency is invalid: ${line.postingId}`);
    if (expectedCurrencies.size > 0 && !expectedCurrencies.has(line.currency)) {
      diagnostics.push(`internal posting uses unexpected currency: ${line.postingId}/${line.currency}`);
    }
    const amount = parseDecimal(line.amount);
    if (amount.coefficient === 0n) diagnostics.push(`internal posting has zero amount: ${line.postingId}`);
    if (amount.scale > 8) diagnostics.push(`internal posting has high amount precision: ${line.postingId}`);
    const date = parseDate(line.valueDate, line.postingId);
    if (!Number.isFinite(line.settledAt.getTime())) {
      throw new Error(`internal settlement time is invalid: ${line.postingId}`);
    }
    if (line.settledAt.getTime() > evaluatedTime) {
      diagnostics.push(`internal posting was settled after reconciliation time: ${line.postingId}`);
    }
    if (restrictedAccounts.has(line.accountCode)) {
      diagnostics.push(`internal posting belongs to restricted account: ${line.postingId}`);
    }
    const normalizedReference = normalizeReference(line.ledgerReference ?? line.receiptId);
    const normalizedBase = {
      source: line,
      amountCoefficient: amount.coefficient,
      amountScale: amount.scale,
      date,
    };
    internalById.set(
      line.postingId,
      normalizedReference === undefined
        ? normalizedBase
        : { ...normalizedBase, normalizedReference },
    );
  }
  const usedExternal = new Set<string>();
  const usedInternal = new Set<string>();
  const ambiguousExternal = new Set<string>();
  const externalReferenceGroups = new Map<string, NormalizedExternal[]>();
  const internalReferenceGroups = new Map<string, NormalizedInternal[]>();
  for (const line of externalById.values()) {
    if (line.normalizedReference === undefined) continue;
    const group = externalReferenceGroups.get(line.normalizedReference) ?? [];
    group.push(line);
    externalReferenceGroups.set(line.normalizedReference, group);
  }
  for (const line of internalById.values()) {
    if (line.normalizedReference === undefined) continue;
    const group = internalReferenceGroups.get(line.normalizedReference) ?? [];
    group.push(line);
    internalReferenceGroups.set(line.normalizedReference, group);
  }
  for (const [reference, externalGroup] of externalReferenceGroups) {
    const internalGroup = internalReferenceGroups.get(reference);
    if (internalGroup === undefined) continue;
    if (externalGroup.length === 1 && internalGroup.length === 1) {
      const external = externalGroup[0];
      const internal = internalGroup[0];
      if (external === undefined || internal === undefined) continue;
      if (external.source.currency !== internal.source.currency) {
        diagnostics.push(`exact reference crosses currencies: ${reference}`);
        continue;
      }
      const scale = Math.max(external.amountScale, internal.amountScale, tolerance.scale);
      const externalAmount = rescaleDecimal(
        { coefficient: external.amountCoefficient, scale: external.amountScale },
        scale,
      );
      const internalAmount = rescaleDecimal(
        { coefficient: internal.amountCoefficient, scale: internal.amountScale },
        scale,
      );
      const differenceCoefficient = externalAmount.coefficient - internalAmount.coefficient;
      const difference = formatDecimal({ coefficient: differenceCoefficient, scale });
      const toleranceCoefficient = rescaleDecimal(tolerance, scale).coefficient;
      const absoluteDifference = differenceCoefficient < 0n ? -differenceCoefficient : differenceCoefficient;
      const dateDifferenceDays = Math.round(
        Math.abs(external.date.getTime() - internal.date.getTime()) / 86_400_000,
      );
      let outcome: ReconciliationOutcome = "exact";
      if (absoluteDifference > 0n || dateDifferenceDays > 0) outcome = "tolerated";
      if (absoluteDifference > toleranceCoefficient || dateDifferenceDays > policy.maximumDateDifferenceDays) {
        diagnostics.push(`reference match exceeds tolerance: ${reference}`);
        continue;
      }
      matches.push({
        externalLineIds: [external.source.lineId],
        internalPostingIds: [internal.source.postingId],
        outcome,
        confidenceScore: Math.max(policy.minimumMatchScore, policy.exactReferenceScore + policy.amountScore),
        amountDifference: difference,
        dateDifferenceDays,
        reasons: ["exact-normalized-reference", "currency-equal", "amount-within-tolerance"],
      });
      usedExternal.add(external.source.lineId);
      usedInternal.add(internal.source.postingId);
    } else {
      for (const external of externalGroup) ambiguousExternal.add(external.source.lineId);
      diagnostics.push(`reference maps to multiple lines: ${reference}`);
    }
  }
  const candidatesByExternal = new Map<string, CandidateMatch[]>();
  for (const external of externalById.values()) {
    if (usedExternal.has(external.source.lineId)) continue;
    const candidates: CandidateMatch[] = [];
    for (const internal of internalById.values()) {
      if (usedInternal.has(internal.source.postingId)) continue;
      if (external.source.currency !== internal.source.currency) continue;
      const reasons: string[] = [];
      let score = 0;
      const scale = Math.max(external.amountScale, internal.amountScale, tolerance.scale);
      const externalAmount = rescaleDecimal(
        { coefficient: external.amountCoefficient, scale: external.amountScale },
        scale,
      );
      const internalAmount = rescaleDecimal(
        { coefficient: internal.amountCoefficient, scale: internal.amountScale },
        scale,
      );
      const differenceCoefficient = externalAmount.coefficient - internalAmount.coefficient;
      const absoluteDifference = differenceCoefficient < 0n ? -differenceCoefficient : differenceCoefficient;
      const toleranceCoefficient = rescaleDecimal(tolerance, scale).coefficient;
      const amountDifference = formatDecimal({ coefficient: differenceCoefficient, scale });
      const dateDifferenceDays = Math.round(
        Math.abs(external.date.getTime() - internal.date.getTime()) / 86_400_000,
      );
      if (absoluteDifference === 0n) {
        score += policy.amountScore;
        reasons.push("amount-exact");
      } else if (absoluteDifference <= toleranceCoefficient) {
        const toleranceRatio = toleranceCoefficient === 0n
          ? 0
          : 1 - Number(absoluteDifference) / Number(toleranceCoefficient);
        score += policy.amountScore * Math.max(0, toleranceRatio);
        reasons.push("amount-within-tolerance");
      } else {
        continue;
      }
      if (dateDifferenceDays === 0) {
        score += policy.dateScore;
        reasons.push("value-date-exact");
      } else if (dateDifferenceDays <= policy.maximumDateDifferenceDays) {
        const dateRatio = 1 - dateDifferenceDays / Math.max(1, policy.maximumDateDifferenceDays);
        score += policy.dateScore * Math.max(0, dateRatio);
        reasons.push("value-date-near");
      } else {
        continue;
      }
      if (external.source.accountCode === internal.source.accountCode) {
        score += policy.accountScore;
        reasons.push("account-code-equal");
      }
      if (
        external.normalizedReference !== undefined
        && internal.normalizedReference !== undefined
        && external.normalizedReference === internal.normalizedReference
      ) {
        score += policy.ledgerReferenceScore;
        reasons.push("ledger-reference-equal");
      }
      if (internal.source.receiptId !== undefined) {
        const receiptReference = normalizeReference(internal.source.receiptId);
        if (receiptReference !== undefined && receiptReference === external.normalizedReference) {
          score += policy.exactReferenceScore;
          reasons.push("receipt-reference-equal");
        }
      }
      const descriptionTokens = new Set(external.normalizedDescription.split(" ").filter((token) => token.length >= 3));
      const internalText = [internal.source.ledgerReference, internal.source.receiptId]
        .filter((value): value is string => value !== undefined)
        .join(" ")
        .toUpperCase();
      const matchingTokens = [...descriptionTokens].filter((token) => internalText.includes(token));
      if (matchingTokens.length > 0) {
        score += Math.min(policy.descriptionScore, matchingTokens.length * (policy.descriptionScore / 3));
        reasons.push(`description-token-match:${matchingTokens.slice(0, 3).join(",")}`);
      }
      if (external.source.counterparty !== undefined) {
        const counterparty = external.source.counterparty.trim().toUpperCase();
        if (counterparty.length > 2 && internalText.includes(counterparty)) {
          score += policy.counterpartyScore;
          reasons.push("counterparty-reference-match");
        }
      }
      if (restrictedAccounts.has(external.source.accountCode)) {
        score *= 0.75;
        reasons.push("restricted-account-penalty");
      }
      if (ambiguousExternal.has(external.source.lineId)) {
        score *= 0.9;
        reasons.push("ambiguous-reference-penalty");
      }
      score = Math.round(score * 100) / 100;
      if (score < policy.minimumMatchScore) continue;
      candidates.push({
        external,
        internal,
        score,
        difference: amountDifference,
        dateDifferenceDays,
        reasons,
      });
    }
    candidates.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const leftDifference = Math.abs(Number(left.difference));
      const rightDifference = Math.abs(Number(right.difference));
      if (leftDifference !== rightDifference) return leftDifference - rightDifference;
      if (left.dateDifferenceDays !== right.dateDifferenceDays) {
        return left.dateDifferenceDays - right.dateDifferenceDays;
      }
      return left.internal.source.postingId.localeCompare(right.internal.source.postingId);
    });
    candidatesByExternal.set(external.source.lineId, candidates);
  }
  const rankedExternal = [...candidatesByExternal.entries()].sort((left, right) => {
    const leftBest = left[1][0]?.score ?? -1;
    const rightBest = right[1][0]?.score ?? -1;
    if (leftBest !== rightBest) return rightBest - leftBest;
    if (left[1].length !== right[1].length) return left[1].length - right[1].length;
    return left[0].localeCompare(right[0]);
  });
  for (const [externalId, candidates] of rankedExternal) {
    if (usedExternal.has(externalId)) continue;
    const available = candidates.filter((candidate) => !usedInternal.has(candidate.internal.source.postingId));
    const best = available[0];
    if (best === undefined) continue;
    const second = available[1];
    if (second !== undefined && best.score - second.score <= policy.ambiguousScoreDistance) {
      ambiguousExternal.add(externalId);
      diagnostics.push(`one-to-one match is ambiguous: ${externalId}`);
      continue;
    }
    matches.push({
      externalLineIds: [externalId],
      internalPostingIds: [best.internal.source.postingId],
      outcome: compareDecimals(best.difference, "0") === 0 && best.dateDifferenceDays === 0 ? "exact" : "tolerated",
      confidenceScore: best.score,
      amountDifference: best.difference,
      dateDifferenceDays: best.dateDifferenceDays,
      reasons: best.reasons,
    });
    usedExternal.add(externalId);
    usedInternal.add(best.internal.source.postingId);
  }
  if (policy.allowManyToOne) {
    const remainingExternal = [...externalById.values()].filter((line) => !usedExternal.has(line.source.lineId));
    const remainingInternal = [...internalById.values()].filter((line) => !usedInternal.has(line.source.postingId));
    for (const external of remainingExternal) {
      const pool = remainingInternal.filter((internal) =>
        !usedInternal.has(internal.source.postingId)
        && internal.source.currency === external.source.currency
        && internal.source.accountCode === external.source.accountCode
        && Math.round(Math.abs(internal.date.getTime() - external.date.getTime()) / 86_400_000)
          <= policy.maximumDateDifferenceDays,
      );
      let bestCombination: NormalizedInternal[] | undefined;
      let bestDifference: bigint | undefined;
      const targetScale = Math.max(
        external.amountScale,
        tolerance.scale,
        ...pool.map((candidate) => candidate.amountScale),
      );
      const targetAmount = rescaleDecimal(
        { coefficient: external.amountCoefficient, scale: external.amountScale },
        targetScale,
      ).coefficient;
      const toleranceCoefficient = rescaleDecimal(tolerance, targetScale).coefficient;
      for (let firstIndex = 0; firstIndex < pool.length; firstIndex += 1) {
        const first = pool[firstIndex];
        if (first === undefined) continue;
        for (let secondIndex = firstIndex + 1; secondIndex < pool.length; secondIndex += 1) {
          const second = pool[secondIndex];
          if (second === undefined) continue;
          const firstAmount = rescaleDecimal(
            { coefficient: first.amountCoefficient, scale: first.amountScale },
            targetScale,
          ).coefficient;
          const secondAmount = rescaleDecimal(
            { coefficient: second.amountCoefficient, scale: second.amountScale },
            targetScale,
          ).coefficient;
          const pairDifference = targetAmount - firstAmount - secondAmount;
          const absolutePairDifference = pairDifference < 0n ? -pairDifference : pairDifference;
          if (absolutePairDifference <= toleranceCoefficient) {
            if (bestDifference === undefined || absolutePairDifference < bestDifference) {
              bestCombination = [first, second];
              bestDifference = absolutePairDifference;
            } else if (absolutePairDifference === bestDifference) {
              bestCombination = undefined;
            }
          }
          if (policy.maximumCombinationSize < 3) continue;
          for (let thirdIndex = secondIndex + 1; thirdIndex < pool.length; thirdIndex += 1) {
            const third = pool[thirdIndex];
            if (third === undefined) continue;
            const thirdAmount = rescaleDecimal(
              { coefficient: third.amountCoefficient, scale: third.amountScale },
              targetScale,
            ).coefficient;
            const tripleDifference = pairDifference - thirdAmount;
            const absoluteTripleDifference = tripleDifference < 0n ? -tripleDifference : tripleDifference;
            if (absoluteTripleDifference <= toleranceCoefficient) {
              if (bestDifference === undefined || absoluteTripleDifference < bestDifference) {
                bestCombination = [first, second, third];
                bestDifference = absoluteTripleDifference;
              } else if (absoluteTripleDifference === bestDifference) {
                bestCombination = undefined;
              }
            }
            if (policy.maximumCombinationSize < 4) continue;
            for (let fourthIndex = thirdIndex + 1; fourthIndex < pool.length; fourthIndex += 1) {
              const fourth = pool[fourthIndex];
              if (fourth === undefined) continue;
              const fourthAmount = rescaleDecimal(
                { coefficient: fourth.amountCoefficient, scale: fourth.amountScale },
                targetScale,
              ).coefficient;
              const quadDifference = tripleDifference - fourthAmount;
              const absoluteQuadDifference = quadDifference < 0n ? -quadDifference : quadDifference;
              if (absoluteQuadDifference <= toleranceCoefficient) {
                if (bestDifference === undefined || absoluteQuadDifference < bestDifference) {
                  bestCombination = [first, second, third, fourth];
                  bestDifference = absoluteQuadDifference;
                } else if (absoluteQuadDifference === bestDifference) {
                  bestCombination = undefined;
                }
              }
            }
          }
        }
      }
      if (bestCombination === undefined) continue;
      const combinedAmount = bestCombination.reduce((sum, internal) => {
        const coefficient = rescaleDecimal(
          { coefficient: internal.amountCoefficient, scale: internal.amountScale },
          targetScale,
        ).coefficient;
        return sum + coefficient;
      }, 0n);
      const differenceCoefficient = targetAmount - combinedAmount;
      const dateDifferenceDays = Math.max(
        ...bestCombination.map((internal) =>
          Math.round(Math.abs(internal.date.getTime() - external.date.getTime()) / 86_400_000),
        ),
      );
      const confidencePenalty = (bestCombination.length - 1) * 5;
      const confidenceScore = Math.max(
        policy.minimumMatchScore,
        policy.amountScore + policy.accountScore + policy.dateScore - confidencePenalty,
      );
      matches.push({
        externalLineIds: [external.source.lineId],
        internalPostingIds: bestCombination.map((internal) => internal.source.postingId),
        outcome: differenceCoefficient === 0n && dateDifferenceDays === 0 ? "exact" : "tolerated",
        confidenceScore,
        amountDifference: formatDecimal({ coefficient: differenceCoefficient, scale: targetScale }),
        dateDifferenceDays,
        reasons: [
          `many-to-one:${bestCombination.length}`,
          "currency-equal",
          "account-code-equal",
          "combined-amount-within-tolerance",
        ],
      });
      usedExternal.add(external.source.lineId);
      for (const internal of bestCombination) usedInternal.add(internal.source.postingId);
    }
  }
  const unmatchedExternalLineIds = [...externalById.keys()]
    .filter((lineId) => !usedExternal.has(lineId))
    .sort();
  const unmatchedInternalPostingIds = [...internalById.keys()]
    .filter((postingId) => !usedInternal.has(postingId))
    .sort();
  for (const lineId of unmatchedExternalLineIds) {
    const candidates = candidatesByExternal.get(lineId) ?? [];
    const reasons = candidates.length === 0
      ? ["no-candidate-met-minimum-score"]
      : ambiguousExternal.has(lineId)
        ? ["multiple-candidates-with-similar-score"]
        : ["candidate-consumed-by-stronger-match"];
    matches.push({
      externalLineIds: [lineId],
      internalPostingIds: [],
      outcome: ambiguousExternal.has(lineId) ? "ambiguous" : "unmatched",
      confidenceScore: candidates[0]?.score ?? 0,
      amountDifference: externalById.get(lineId)?.source.amount ?? "0",
      dateDifferenceDays: 0,
      reasons,
    });
  }
  for (const postingId of unmatchedInternalPostingIds) {
    matches.push({
      externalLineIds: [],
      internalPostingIds: [postingId],
      outcome: "unmatched",
      confidenceScore: 0,
      amountDifference: formatDecimal({
        coefficient: -(internalById.get(postingId)?.amountCoefficient ?? 0n),
        scale: internalById.get(postingId)?.amountScale ?? 0,
      }),
      dateDifferenceDays: 0,
      reasons: ["no-external-line-consumed-posting"],
    });
  }
  let totalExternalAmount = "0";
  for (const external of externalById.values()) {
    totalExternalAmount = addDecimals(totalExternalAmount, external.source.amount);
  }
  let totalInternalAmount = "0";
  for (const internal of internalById.values()) {
    totalInternalAmount = addDecimals(totalInternalAmount, internal.source.amount);
  }
  const totalScale = Math.max(
    parseDecimal(totalExternalAmount).scale,
    parseDecimal(totalInternalAmount).scale,
    tolerance.scale,
  );
  totalExternalAmount = formatDecimal(rescaleDecimal(parseDecimal(totalExternalAmount), totalScale));
  totalInternalAmount = formatDecimal(rescaleDecimal(parseDecimal(totalInternalAmount), totalScale));
  const externalTotal = rescaleDecimal(parseDecimal(totalExternalAmount), totalScale).coefficient;
  const internalTotal = rescaleDecimal(parseDecimal(totalInternalAmount), totalScale).coefficient;
  const netDifference = formatDecimal({ coefficient: externalTotal - internalTotal, scale: totalScale });
  matches.sort((left, right) => {
    const outcomeOrder: Readonly<Record<ReconciliationOutcome, number>> = {
      exact: 0,
      tolerated: 1,
      ambiguous: 2,
      unmatched: 3,
      invalid: 4,
    };
    if (outcomeOrder[left.outcome] !== outcomeOrder[right.outcome]) {
      return outcomeOrder[left.outcome] - outcomeOrder[right.outcome];
    }
    if (left.confidenceScore !== right.confidenceScore) return right.confidenceScore - left.confidenceScore;
    const leftIdentity = left.externalLineIds[0] ?? left.internalPostingIds[0] ?? "";
    const rightIdentity = right.externalLineIds[0] ?? right.internalPostingIds[0] ?? "";
    return leftIdentity.localeCompare(rightIdentity);
  });
  const ambiguousGroups = matches.filter((match) => match.outcome === "ambiguous").length;
  diagnostics.push(`external-line-count:${externalById.size}`);
  diagnostics.push(`internal-posting-count:${internalById.size}`);
  diagnostics.push(`matched-external-count:${usedExternal.size}`);
  diagnostics.push(`matched-internal-count:${usedInternal.size}`);
  diagnostics.push(`unmatched-external-count:${unmatchedExternalLineIds.length}`);
  diagnostics.push(`unmatched-internal-count:${unmatchedInternalPostingIds.length}`);
  diagnostics.push(`ambiguous-group-count:${ambiguousGroups}`);
  diagnostics.push(`net-difference:${netDifference}`);
  if (compareDecimals(netDifference, policy.amountTolerance) > 0) {
    diagnostics.push("positive net difference exceeds tolerance");
  }
  const negativeTolerance = formatDecimal({ coefficient: -tolerance.coefficient, scale: tolerance.scale });
  if (compareDecimals(netDifference, negativeTolerance) < 0) {
    diagnostics.push("negative net difference exceeds tolerance");
  }
  const outcomeCounts: Record<ReconciliationOutcome, number> = {
    exact: 0,
    tolerated: 0,
    ambiguous: 0,
    unmatched: 0,
    invalid: 0,
  };
  const consumedExternal = new Set<string>();
  const consumedInternal = new Set<string>();
  for (const match of matches) {
    outcomeCounts[match.outcome] += 1;
    for (const lineId of match.externalLineIds) {
      if (match.outcome === "exact" || match.outcome === "tolerated") {
        if (consumedExternal.has(lineId)) throw new Error(`external line was matched twice: ${lineId}`);
        consumedExternal.add(lineId);
      }
    }
    for (const postingId of match.internalPostingIds) {
      if (match.outcome === "exact" || match.outcome === "tolerated") {
        if (consumedInternal.has(postingId)) throw new Error(`internal posting was matched twice: ${postingId}`);
        consumedInternal.add(postingId);
      }
    }
    if (match.confidenceScore < 0 || !Number.isFinite(match.confidenceScore)) {
      throw new Error("reconciliation match has an invalid confidence score");
    }
  }
  for (const [outcome, count] of Object.entries(outcomeCounts)) diagnostics.push(`outcome-${outcome}:${count}`);
  if (consumedExternal.size !== usedExternal.size) {
    throw new Error("reconciliation external consumption count is inconsistent");
  }
  if (consumedInternal.size !== usedInternal.size) {
    throw new Error("reconciliation internal consumption count is inconsistent");
  }
  const externalCountByCurrency = new Map<string, number>();
  const internalCountByCurrency = new Map<string, number>();
  const externalCountByAccount = new Map<string, number>();
  const internalCountByAccount = new Map<string, number>();
  for (const line of externalById.values()) {
    externalCountByCurrency.set(line.source.currency, (externalCountByCurrency.get(line.source.currency) ?? 0) + 1);
    externalCountByAccount.set(line.source.accountCode, (externalCountByAccount.get(line.source.accountCode) ?? 0) + 1);
  }
  for (const line of internalById.values()) {
    internalCountByCurrency.set(line.source.currency, (internalCountByCurrency.get(line.source.currency) ?? 0) + 1);
    internalCountByAccount.set(line.source.accountCode, (internalCountByAccount.get(line.source.accountCode) ?? 0) + 1);
  }
  const allCurrencies = new Set([...externalCountByCurrency.keys(), ...internalCountByCurrency.keys()]);
  for (const currency of [...allCurrencies].sort()) {
    const externalCount = externalCountByCurrency.get(currency) ?? 0;
    const internalCount = internalCountByCurrency.get(currency) ?? 0;
    diagnostics.push(`currency-line-count:${currency}:external=${externalCount}:internal=${internalCount}`);
  }
  const allAccounts = new Set([...externalCountByAccount.keys(), ...internalCountByAccount.keys()]);
  for (const account of [...allAccounts].sort()) {
    const externalCount = externalCountByAccount.get(account) ?? 0;
    const internalCount = internalCountByAccount.get(account) ?? 0;
    if (externalCount !== internalCount) {
      diagnostics.push(`account-line-count-mismatch:${account}:external=${externalCount}:internal=${internalCount}`);
    }
  }
  return {
    matches,
    unmatchedExternalLineIds,
    unmatchedInternalPostingIds,
    totalExternalAmount,
    totalInternalAmount,
    netDifference,
    ambiguousGroups,
    diagnostics,
  };
}
