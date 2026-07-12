import { currencyCode } from "../quotes/quote-types.js";
import type { ComplianceRuleRecord } from "./reference-types.js";

export const complianceRules: readonly ComplianceRuleRecord[] = [
  { ruleId: "cmp-global-sanctions", jurisdiction: "GLOBAL", category: "sanctions-exposure",
    thresholdCurrency: currencyCode("USD"), thresholdAmount: "0.01", action: "hold", riskTier: "restricted",
    evidenceFields: ["sanctionsScreeningId", "screenedAt"] },
  { ruleId: "cmp-us-large-value", jurisdiction: "US", category: "large-value-transfer",
    thresholdCurrency: currencyCode("USD"), thresholdAmount: "100000.00", action: "review", riskTier: "monitored",
    evidenceFields: ["sourceOfFunds", "transferPurpose"] },
  { ruleId: "cmp-de-beneficiary", jurisdiction: "DE", category: "beneficiary-screening",
    thresholdCurrency: currencyCode("EUR"), thresholdAmount: "10000.00", action: "review", riskTier: "monitored",
    evidenceFields: ["beneficiaryName", "beneficiaryAddress"] },
  { ruleId: "cmp-gb-ownership", jurisdiction: "GB", category: "ultimate-owner-check",
    thresholdCurrency: currencyCode("GBP"), thresholdAmount: "50000.00", action: "hold", riskTier: "elevated",
    evidenceFields: ["ultimateOwner", "ownershipPercentage"] },
  { ruleId: "cmp-cn-purpose", jurisdiction: "CN", category: "purpose-code-validation",
    thresholdCurrency: currencyCode("CNY"), thresholdAmount: "500000.00", action: "review", riskTier: "monitored",
    evidenceFields: ["purposeCode", "contractReference"] },
  { ruleId: "cmp-hk-velocity", jurisdiction: "HK", category: "velocity-monitoring",
    thresholdCurrency: currencyCode("HKD"), thresholdAmount: "1000000.00", action: "hold", riskTier: "elevated",
    evidenceFields: ["dailyTransferCount", "relationshipManager"] },
  { ruleId: "cmp-sg-source", jurisdiction: "SG", category: "source-of-funds",
    thresholdCurrency: currencyCode("SGD"), thresholdAmount: "250000.00", action: "review", riskTier: "monitored",
    evidenceFields: ["sourceOfFunds", "bankStatement"] },
  { ruleId: "cmp-ae-corridor", jurisdiction: "AE", category: "corridor-restriction",
    thresholdCurrency: currencyCode("AED"), thresholdAmount: "750000.00", action: "hold", riskTier: "elevated",
    evidenceFields: ["originCountry", "ultimateBeneficiary"] },
];
