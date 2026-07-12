import type { CurrencyCode } from "../quotes/quote-types.js";

export type RiskTier = "standard" | "monitored" | "elevated" | "restricted";

export interface SettlementRouteRecord {
  readonly routeId: string;
  readonly currency: CurrencyCode;
  readonly destinationCountry: string;
  readonly rail: "swift" | "sepa" | "rtgs" | "ach" | "domestic";
  readonly correspondent: string;
  readonly cutoffUtcHour: number;
  readonly additionalBusinessDays: number;
  readonly manualReviewAmount: string;
  readonly riskTier: RiskTier;
  readonly enabled: boolean;
}

export interface HolidayRecord {
  readonly calendar: string;
  readonly date: string;
  readonly name: string;
  readonly scope: "national" | "banking" | "market" | "regional";
  readonly affectedCurrencies: readonly CurrencyCode[];
  readonly fullClosure: boolean;
}

export interface ComplianceRuleRecord {
  readonly ruleId: string;
  readonly jurisdiction: string;
  readonly category: string;
  readonly thresholdCurrency: CurrencyCode;
  readonly thresholdAmount: string;
  readonly action: "allow" | "review" | "hold" | "reject";
  readonly riskTier: RiskTier;
  readonly evidenceFields: readonly string[];
}

export interface LedgerAccountRecord {
  readonly accountCode: string;
  readonly displayName: string;
  readonly category: "asset" | "liability" | "income" | "expense" | "equity";
  readonly currency: CurrencyCode;
  readonly normalBalance: "debit" | "credit";
  readonly reconciliationCadence: "intraday" | "daily" | "weekly" | "monthly";
  readonly postingRestricted: boolean;
}

export interface AuditEventDefinition {
  readonly eventType: string;
  readonly domain: string;
  readonly defaultSeverity: "debug" | "info" | "notice" | "warning" | "critical";
  readonly retentionDays: number;
  readonly requiredAttributes: readonly string[];
  readonly containsPersonalData: boolean;
  readonly immutable: boolean;
}

export interface PairLimitRecord {
  readonly pair: string;
  readonly desk: string;
  readonly maximumNotional: string;
  readonly maximumSpreadBps: number;
  readonly maximumQuoteAgeMs: number;
  readonly tradingHours: string;
  readonly riskTier: RiskTier;
}
