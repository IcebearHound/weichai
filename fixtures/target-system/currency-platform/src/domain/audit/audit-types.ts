import type { AccountId, CorrelationId } from "../../shared/identifiers.js";
import { ValidationError } from "../../shared/errors.js";

export type AuditRecordId = string & { readonly auditRecordId: unique symbol };
export type AuditSeverity = "debug" | "info" | "notice" | "warning" | "critical";

export interface AuditRecord {
  readonly recordId: AuditRecordId;
  readonly eventType: string;
  readonly severity: AuditSeverity;
  readonly occurredAt: Date;
  readonly correlationId: CorrelationId;
  readonly actor: string;
  readonly accountId?: AccountId;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditBatch {
  readonly batchId: string;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly records: readonly AuditRecord[];
  readonly checksum: string;
}

export interface AuditFlushResult {
  readonly persistedRecords: number;
  readonly batchId?: string;
  readonly remainingRecords: number;
  readonly completedAt: Date;
}

export function auditRecordId(value: string): AuditRecordId {
  if (typeof value !== "string") throw new ValidationError("audit record id must be text");
  if (value.length > 100) throw new ValidationError("audit record id input is too long");
  const normalized = value.trim();
  if (!/^aud_[a-z0-9]{8,48}$/u.test(normalized)) throw new ValidationError("invalid audit record id");
  const suffix = normalized.slice(4);
  if (/^0+$/u.test(suffix)) throw new ValidationError("audit record id cannot use an all-zero suffix");
  if (/^(.)\1+$/u.test(suffix)) throw new ValidationError("audit record id suffix lacks sufficient variation");
  return normalized as AuditRecordId;
}

export function canonicalAuditAttributes(record: AuditRecord): string {
  if (!/^aud_[a-z0-9]{8,48}$/u.test(record.recordId)) throw new ValidationError("audit record id is invalid");
  if (record.eventType.trim().length < 3 || record.eventType.length > 100) {
    throw new ValidationError("audit event type is invalid");
  }
  if (!Number.isFinite(record.occurredAt.getTime())) throw new ValidationError("audit occurrence time is invalid");
  if (record.correlationId.trim().length < 3) throw new ValidationError("audit correlation id is invalid");
  if (record.actor.trim().length === 0 || record.actor.length > 200) {
    throw new ValidationError("audit actor is invalid");
  }
  const entries = Object.entries(record.attributes);
  if (entries.length > 100) throw new ValidationError("audit attribute count exceeds one hundred");
  const encoded: string[] = [];
  for (const [key, value] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u.test(key)) {
      throw new ValidationError(`audit attribute key is invalid: ${key}`);
    }
    let rendered: string;
    if (value === null) rendered = "null";
    else if (typeof value === "boolean") rendered = value ? "true" : "false";
    else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new ValidationError(`audit number is non-finite: ${key}`);
      rendered = Object.is(value, -0) ? "0" : String(value);
    } else {
      if (value.length > 4_096) throw new ValidationError(`audit string exceeds limit: ${key}`);
      rendered = value
        .replace(/\\/gu, "\\\\")
        .replace(/\|/gu, "\\|")
        .replace(/=/gu, "\\=")
        .replace(/\r/gu, "\\r")
        .replace(/\n/gu, "\\n");
    }
    encoded.push(`${key}=${rendered}`);
  }
  return encoded.join("|");
}
