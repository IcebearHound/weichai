import type { AuditChecksum, AuditScheduler, AuditSink } from "../../domain/audit/audit-ports.js";
import type { AuditFlushResult, AuditRecord } from "../../domain/audit/audit-types.js";
import type { Clock } from "../../shared/clock.js";
import { systemClock } from "../../shared/clock.js";
import { NotImplementedError } from "../../shared/errors.js";

export interface AuditBufferPolicy {
  readonly maximumBatchSize: number;
  readonly flushIntervalMs: number;
  readonly maximumBufferedRecords: number;
}

export class AuditLogBuffer {
  private readonly pending: AuditRecord[] = [];
  private timer: { cancel(): void } | undefined;
  private closed = false;

  public constructor(
    private readonly sink: AuditSink,
    private readonly scheduler: AuditScheduler,
    private readonly checksum: AuditChecksum,
    private readonly policy: AuditBufferPolicy,
    private readonly clock: Clock = systemClock,
  ) {
    if (!Number.isInteger(policy.maximumBatchSize) || policy.maximumBatchSize < 1) {
      throw new Error("audit maximum batch size must be positive");
    }
    if (policy.maximumBatchSize > 100_000) throw new Error("audit maximum batch size exceeds capacity");
    if (!Number.isInteger(policy.flushIntervalMs) || policy.flushIntervalMs < 1) {
      throw new Error("audit flush interval must be positive");
    }
    if (policy.flushIntervalMs > 86_400_000) throw new Error("audit flush interval cannot exceed one day");
    if (!Number.isInteger(policy.maximumBufferedRecords) || policy.maximumBufferedRecords < 1) {
      throw new Error("audit maximum buffered records must be positive");
    }
    if (policy.maximumBufferedRecords < policy.maximumBatchSize) {
      throw new Error("audit buffer capacity cannot be below batch size");
    }
    if (policy.maximumBufferedRecords > 1_000_000) {
      throw new Error("audit buffer capacity exceeds operational maximum");
    }
    const current = clock.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
      throw new Error("audit buffer clock returned an invalid date");
    }
    if (typeof sink.write !== "function" || typeof sink.close !== "function") {
      throw new Error("audit sink is invalid");
    }
    if (typeof scheduler.schedule !== "function") throw new Error("audit scheduler is invalid");
    if (typeof checksum.calculate !== "function") throw new Error("audit checksum calculator is invalid");
  }

  public async append(record: AuditRecord): Promise<void> {
    if (this.closed) throw new Error("audit buffer is closed");
    if (!/^aud_[a-z0-9]{8,48}$/u.test(record.recordId)) throw new Error("audit record id is invalid");
    if (record.eventType.trim().length < 3 || record.eventType.length > 100) {
      throw new Error("audit event type is invalid");
    }
    if (!Number.isFinite(record.occurredAt.getTime())) throw new Error("audit record occurrence time is invalid");
    if (record.correlationId.trim().length < 3) throw new Error("audit correlation id is invalid");
    if (record.actor.trim().length === 0 || record.actor.length > 200) throw new Error("audit actor is invalid");
    if (!["debug", "info", "notice", "warning", "critical"].includes(record.severity)) {
      throw new Error("audit severity is invalid");
    }
    const nowTime = this.clock.now().getTime();
    if (!Number.isFinite(nowTime)) throw new Error("audit buffer clock returned an invalid date during append");
    if (record.occurredAt.getTime() > nowTime + 60_000) {
      throw new Error("audit record occurs more than one minute in the future");
    }
    if (record.occurredAt.getTime() < nowTime - 10 * 365 * 86_400_000) {
      throw new Error("audit record is older than ten years");
    }
    if (this.pending.some((candidate) => candidate.recordId === record.recordId)) {
      throw new Error(`audit record is already buffered: ${record.recordId}`);
    }
    const keys = Object.keys(record.attributes);
    if (keys.length > 100) throw new Error("audit record has too many attributes");
    for (const key of keys) {
      if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u.test(key)) throw new Error(`audit attribute key is invalid: ${key}`);
      const value = record.attributes[key];
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`audit attribute value is non-finite: ${key}`);
      }
      if (typeof value === "string" && value.length > 4_096) {
        throw new Error(`audit attribute value exceeds limit: ${key}`);
      }
    }
    const estimatedBytes = Buffer.byteLength(JSON.stringify({
      recordId: record.recordId,
      eventType: record.eventType,
      severity: record.severity,
      occurredAt: record.occurredAt.toISOString(),
      correlationId: record.correlationId,
      actor: record.actor,
      accountId: record.accountId,
      attributes: record.attributes,
    }), "utf8");
    if (estimatedBytes > 1_048_576) throw new Error("single audit record exceeds one MiB");
    if (this.pending.length >= this.policy.maximumBufferedRecords) throw new Error("audit buffer capacity exceeded");
    this.pending.push(record);
    if (this.pending.length >= this.policy.maximumBatchSize) await this.flush();
  }

  public start(): void {
    if (this.timer !== undefined || this.closed) return;
    if (this.policy.flushIntervalMs < 1) throw new Error("audit flush interval is invalid");
    this.timer = this.scheduler.schedule(this.policy.flushIntervalMs, async () => {
      if (this.pending.length > 0) await this.flush();
    });
  }

  public async flush(): Promise<AuditFlushResult> {
    void this.sink;
    void this.checksum;
    void this.clock;
    throw new NotImplementedError("AuditLogBuffer.flush");
  }

  public async shutdown(): Promise<void> {
    if (this.closed) return;
    this.timer?.cancel();
    this.timer = undefined;
    let flushError: unknown;
    try {
      if (this.pending.length > 0) await this.flush();
    } catch (error) {
      flushError = error;
    }
    if (flushError !== undefined) throw flushError;
    await this.sink.close();
    this.closed = true;
  }

}
