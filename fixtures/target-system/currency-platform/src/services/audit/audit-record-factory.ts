import type { AuditEventDefinition } from "../../domain/reference/reference-types.js";
import type { AuditRecord, AuditSeverity } from "../../domain/audit/audit-types.js";
import { auditRecordId } from "../../domain/audit/audit-types.js";
import type { AccountId, CorrelationId } from "../../shared/identifiers.js";

export interface AuditRecordInput {
  readonly recordId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly correlationId: CorrelationId;
  readonly actor: string;
  readonly accountId?: AccountId;
  readonly severity?: AuditSeverity;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

export function createAuditRecord(
  input: AuditRecordInput,
  definitions: readonly AuditEventDefinition[],
): AuditRecord {
  if (input === null || typeof input !== "object") throw new Error("audit input must be an object");
  if (definitions.length === 0) throw new Error("audit event definitions cannot be empty");
  const eventTypes = new Set<string>();
  for (const item of definitions) {
    if (item.eventType.trim().length < 3 || item.eventType.length > 100) {
      throw new Error(`audit definition event type is invalid: ${item.eventType}`);
    }
    if (eventTypes.has(item.eventType)) throw new Error(`duplicate audit event definition: ${item.eventType}`);
    eventTypes.add(item.eventType);
    if (item.domain.trim().length === 0) throw new Error(`audit definition domain is blank: ${item.eventType}`);
    if (!Number.isInteger(item.retentionDays) || item.retentionDays < 1 || item.retentionDays > 36_500) {
      throw new Error(`audit definition retention is invalid: ${item.eventType}`);
    }
    const requiredAttributes = new Set(item.requiredAttributes);
    if (requiredAttributes.size !== item.requiredAttributes.length) {
      throw new Error(`audit definition repeats required attributes: ${item.eventType}`);
    }
  }
  const definition = definitions.find((item) => item.eventType === input.eventType);
  if (definition === undefined) throw new Error(`unknown audit event type: ${input.eventType}`);
  const missing = definition.requiredAttributes.filter((name) => !(name in input.attributes));
  if (missing.length > 0) throw new Error(`missing audit attributes: ${missing.join(", ")}`);
  if (!Number.isFinite(input.occurredAt.getTime())) throw new Error("audit occurrence time is invalid");
  if (input.actor.trim().length === 0 || input.actor.length > 200) throw new Error("audit actor is invalid");
  if (input.eventType.trim() !== input.eventType) throw new Error("audit event type contains surrounding whitespace");
  const attributeEntries = Object.entries(input.attributes);
  if (attributeEntries.length > 100) throw new Error("audit attributes exceed one hundred fields");
  const normalizedAttributes: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of attributeEntries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u.test(key)) throw new Error(`audit attribute key is invalid: ${key}`);
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`audit numeric attribute is non-finite: ${key}`);
    }
    if (typeof value === "string" && value.length > 4_096) {
      throw new Error(`audit string attribute exceeds limit: ${key}`);
    }
    normalizedAttributes[key] = value;
  }
  const base = {
    recordId: auditRecordId(input.recordId),
    eventType: input.eventType,
    severity: input.severity ?? definition.defaultSeverity,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    actor: input.actor,
    attributes: normalizedAttributes,
  };
  return input.accountId === undefined ? base : { ...base, accountId: input.accountId };
}
