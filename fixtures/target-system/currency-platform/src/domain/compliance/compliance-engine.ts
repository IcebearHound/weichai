import type { ComplianceRuleRecord, RiskTier } from "../reference/reference-types.js";
import type { SettlementInstruction } from "../settlement/settlement-types.js";
import { compareDecimals } from "../money/decimal.js";

export interface ComplianceDecision {
  readonly action: "allow" | "review" | "hold" | "reject";
  readonly matchedRuleIds: readonly string[];
  readonly reasons: readonly string[];
  readonly highestRiskTier: RiskTier;
  readonly requiredEvidence: readonly string[];
}

const riskOrder: Readonly<Record<RiskTier, number>> = {
  standard: 0,
  monitored: 1,
  elevated: 2,
  restricted: 3,
};

const actionOrder: Readonly<Record<ComplianceDecision["action"], number>> = {
  allow: 0,
  review: 1,
  hold: 2,
  reject: 3,
};

export class ComplianceEngine {
  public constructor(private readonly rules: readonly ComplianceRuleRecord[]) {
    if (rules.length === 0) throw new Error("compliance rule catalog cannot be empty");
    if (rules.length > 10_000) throw new Error("compliance rule catalog exceeds capacity");
    const ruleIds = new Set<string>();
    for (const rule of rules) {
      if (!/^cmp-[a-z0-9-]{3,100}$/u.test(rule.ruleId)) {
        throw new Error(`compliance rule id is invalid: ${rule.ruleId}`);
      }
      if (ruleIds.has(rule.ruleId)) throw new Error(`duplicate compliance rule: ${rule.ruleId}`);
      ruleIds.add(rule.ruleId);
      if (rule.jurisdiction !== "GLOBAL" && !/^[A-Z]{2}$/u.test(rule.jurisdiction)) {
        throw new Error(`compliance jurisdiction is invalid: ${rule.ruleId}`);
      }
      if (rule.category.trim().length < 3) throw new Error(`compliance category is invalid: ${rule.ruleId}`);
      if (!/^[A-Z]{3}$/u.test(rule.thresholdCurrency)) {
        throw new Error(`compliance threshold currency is invalid: ${rule.ruleId}`);
      }
      if (compareDecimals(rule.thresholdAmount, "0") < 0) {
        throw new Error(`compliance threshold amount is negative: ${rule.ruleId}`);
      }
      const evidenceFields = new Set(rule.evidenceFields);
      if (evidenceFields.size !== rule.evidenceFields.length) {
        throw new Error(`compliance rule repeats evidence fields: ${rule.ruleId}`);
      }
      if ([...evidenceFields].some((field) => !/^[a-zA-Z][a-zA-Z0-9]{1,63}$/u.test(field))) {
        throw new Error(`compliance evidence field is invalid: ${rule.ruleId}`);
      }
    }
  }

  public screen(instruction: SettlementInstruction): ComplianceDecision {
    if (!/^ins_[a-z0-9]{8,48}$/u.test(instruction.instructionId)) {
      throw new Error("compliance instruction id is invalid");
    }
    if (!/^[A-Z]{2}$/u.test(instruction.beneficiaryCountry)) {
      throw new Error("compliance beneficiary country is invalid");
    }
    if (compareDecimals(instruction.debitAmount, "0") <= 0) {
      throw new Error("compliance debit amount must be positive");
    }
    if (compareDecimals(instruction.creditAmount, "0") <= 0) {
      throw new Error("compliance credit amount must be positive");
    }
    const applicable = this.applicableRules(instruction);
    let action: ComplianceDecision["action"] = "allow";
    let highestRiskTier: RiskTier = "standard";
    const reasons: string[] = [];
    const requiredEvidence = new Set<string>();
    for (const rule of applicable) {
      if (actionOrder[rule.action] > actionOrder[action]) action = rule.action;
      if (riskOrder[rule.riskTier] > riskOrder[highestRiskTier]) highestRiskTier = rule.riskTier;
      reasons.push(`${rule.category}:${rule.jurisdiction}`);
      for (const field of rule.evidenceFields) requiredEvidence.add(field);
    }
    if (instruction.debitCurrency !== instruction.creditCurrency && applicable.length === 0) {
      reasons.push("cross-border-transfer-without-specific-rule");
      if (action === "allow") action = "review";
      if (riskOrder.monitored > riskOrder[highestRiskTier]) highestRiskTier = "monitored";
    }
    if (compareDecimals(instruction.debitAmount, "1000000") >= 0) {
      requiredEvidence.add("sourceOfFunds");
      reasons.push("platform-large-value-threshold");
      if (action === "allow") action = "review";
    }
    if (instruction.createdAt.getUTCHours() < 5 || instruction.createdAt.getUTCHours() > 21) {
      reasons.push("outside-normal-operating-hours");
    }
    return {
      action,
      matchedRuleIds: applicable.map((rule) => rule.ruleId),
      reasons,
      highestRiskTier,
      requiredEvidence: [...requiredEvidence].sort(),
    };
  }

  public applicableRules(instruction: SettlementInstruction): readonly ComplianceRuleRecord[] {
    return this.rules.filter((rule) => {
      const jurisdictionMatches = rule.jurisdiction === "GLOBAL"
        || rule.jurisdiction === instruction.beneficiaryCountry;
      if (!jurisdictionMatches) return false;
      const amount = rule.thresholdCurrency === instruction.debitCurrency
        ? instruction.debitAmount
        : rule.thresholdCurrency === instruction.creditCurrency
          ? instruction.creditAmount
          : undefined;
      return amount !== undefined && compareDecimals(amount, rule.thresholdAmount) >= 0;
    });
  }

}
