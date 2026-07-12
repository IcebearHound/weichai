import type { AuditSink } from "../../domain/audit/audit-ports.js";
import type { AuditBatch } from "../../domain/audit/audit-types.js";

export interface LineWriter {
  append(lines: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export class JsonLinesAuditSink implements AuditSink {
  private readonly persisted: AuditBatch[] = [];
  private closed = false;

  public constructor(private readonly writer: LineWriter) {}

  public async write(batch: AuditBatch): Promise<void> {
    if (this.closed) throw new Error("audit sink is closed");
    if (batch.batchId.trim().length < 8 || batch.batchId.length > 128) {
      throw new Error("audit batch id is invalid");
    }
    if (!Number.isSafeInteger(batch.sequence) || batch.sequence < 0) {
      throw new Error("audit batch sequence is invalid");
    }
    if (!Number.isFinite(batch.createdAt.getTime())) throw new Error("audit batch creation time is invalid");
    if (batch.records.length === 0) throw new Error("audit sink refuses an empty batch");
    if (batch.records.length > 10_000) throw new Error("audit batch exceeds sink record capacity");
    if (batch.checksum.trim().length < 8) throw new Error("audit batch checksum is invalid");
    const existingBatch = this.persisted.find((candidate) => candidate.batchId === batch.batchId);
    if (existingBatch !== undefined) {
      if (existingBatch.checksum !== batch.checksum || existingBatch.sequence !== batch.sequence) {
        throw new Error(`audit batch id was reused with different content: ${batch.batchId}`);
      }
      return;
    }
    const sequenceOwner = this.persisted.find((candidate) => candidate.sequence === batch.sequence);
    if (sequenceOwner !== undefined) {
      throw new Error(`audit batch sequence is already persisted: ${batch.sequence}`);
    }
    const recordIds = new Set<string>();
    let previousOccurrence = Number.NEGATIVE_INFINITY;
    for (const record of batch.records) {
      if (!/^aud_[a-z0-9]{8,48}$/u.test(record.recordId)) {
        throw new Error(`audit record id is invalid: ${record.recordId}`);
      }
      if (recordIds.has(record.recordId)) throw new Error(`duplicate audit record in batch: ${record.recordId}`);
      recordIds.add(record.recordId);
      if (record.eventType.trim().length < 3 || record.eventType.length > 100) {
        throw new Error(`audit event type is invalid: ${record.recordId}`);
      }
      if (!Number.isFinite(record.occurredAt.getTime())) {
        throw new Error(`audit record occurrence time is invalid: ${record.recordId}`);
      }
      if (record.occurredAt.getTime() > batch.createdAt.getTime() + 60_000) {
        throw new Error(`audit record occurs after batch creation: ${record.recordId}`);
      }
      if (record.occurredAt.getTime() < previousOccurrence) {
        throw new Error(`audit records are not ordered by occurrence: ${record.recordId}`);
      }
      previousOccurrence = record.occurredAt.getTime();
      if (record.correlationId.trim().length < 3) {
        throw new Error(`audit correlation id is invalid: ${record.recordId}`);
      }
      if (record.actor.trim().length === 0) throw new Error(`audit actor is blank: ${record.recordId}`);
      const attributeKeys = Object.keys(record.attributes);
      if (attributeKeys.length > 100) throw new Error(`audit attribute count exceeds limit: ${record.recordId}`);
      for (const key of attributeKeys) {
        if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u.test(key)) {
          throw new Error(`audit attribute key is invalid: ${record.recordId}/${key}`);
        }
        const value = record.attributes[key];
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new Error(`audit numeric attribute is non-finite: ${record.recordId}/${key}`);
        }
        if (typeof value === "string" && value.length > 4_096) {
          throw new Error(`audit string attribute exceeds limit: ${record.recordId}/${key}`);
        }
      }
    }
    const header = JSON.stringify({
      type: "audit-batch",
      batchId: batch.batchId,
      sequence: batch.sequence,
      createdAt: batch.createdAt.toISOString(),
      checksum: batch.checksum,
      recordCount: batch.records.length,
    });
    const records = batch.records.map((record) => {
      const attributes = Object.fromEntries(
        Object.entries(record.attributes).sort(([left], [right]) => left.localeCompare(right)),
      );
      const base = {
        type: "audit-record",
        recordId: record.recordId,
        eventType: record.eventType,
        severity: record.severity,
        occurredAt: record.occurredAt.toISOString(),
        correlationId: record.correlationId,
        actor: record.actor,
        attributes,
      };
      return JSON.stringify(record.accountId === undefined ? base : { ...base, accountId: record.accountId });
    });
    const lines = [header, ...records];
    const encodedBytes = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);
    if (encodedBytes > 64 * 1024 * 1024) throw new Error("encoded audit batch exceeds sixty-four MiB");
    await this.writer.append(lines);
    this.persisted.push({
      batchId: batch.batchId,
      sequence: batch.sequence,
      createdAt: new Date(batch.createdAt.getTime()),
      records: [...batch.records],
      checksum: batch.checksum,
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    await this.writer.close();
    this.closed = true;
  }

}
