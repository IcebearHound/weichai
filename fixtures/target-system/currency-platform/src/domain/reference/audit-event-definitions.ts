import type { AuditEventDefinition } from "./reference-types.js";

export const auditEventDefinitions: readonly AuditEventDefinition[] = [
  { eventType: "quote.requested", domain: "quote", defaultSeverity: "info", retentionDays: 365,
    requiredAttributes: ["pair", "correlationId", "amount"], containsPersonalData: false, immutable: true },
  { eventType: "quote.provider-failed", domain: "provider", defaultSeverity: "warning", retentionDays: 730,
    requiredAttributes: ["providerId", "pair", "errorCode"], containsPersonalData: false, immutable: true },
  { eventType: "settlement.completed", domain: "settlement", defaultSeverity: "notice", retentionDays: 2555,
    requiredAttributes: ["batchId", "instructionId", "receiptId"], containsPersonalData: true, immutable: true },
  { eventType: "settlement.retry-scheduled", domain: "settlement", defaultSeverity: "warning", retentionDays: 730,
    requiredAttributes: ["instructionId", "attempt", "delayMs"], containsPersonalData: false, immutable: true },
  { eventType: "trade.event-consumed", domain: "trade", defaultSeverity: "info", retentionDays: 2555,
    requiredAttributes: ["tradeId", "accountId", "sequence"], containsPersonalData: true, immutable: true },
  { eventType: "trade.event-rejected", domain: "trade", defaultSeverity: "critical", retentionDays: 2555,
    requiredAttributes: ["tradeId", "messageId", "reason"], containsPersonalData: true, immutable: true },
  { eventType: "audit.batch-persisted", domain: "audit", defaultSeverity: "notice", retentionDays: 2555,
    requiredAttributes: ["batchId", "recordCount", "checksum"], containsPersonalData: false, immutable: true },
  { eventType: "compliance.decision", domain: "compliance", defaultSeverity: "notice", retentionDays: 2555,
    requiredAttributes: ["instructionId", "action", "ruleIds"], containsPersonalData: true, immutable: true },
];
