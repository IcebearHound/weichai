import assert from "node:assert/strict";
import test from "node:test";
import { AuditLogBuffer } from "../../src/application/audit/audit-log-buffer.js";
import type { AuditChecksum, AuditScheduler, AuditSink } from "../../src/domain/audit/audit-ports.js";
import type { AuditBatch, AuditRecord } from "../../src/domain/audit/audit-types.js";
import { auditRecordId } from "../../src/domain/audit/audit-types.js";
import { correlationId } from "../../src/shared/identifiers.js";

function record(suffix: string): AuditRecord {
  return {
    recordId: auditRecordId(`aud_${suffix.padEnd(8, "x")}`),
    eventType: "settlement.completed",
    severity: "notice",
    occurredAt: new Date("2026-07-12T08:00:00.000Z"),
    correlationId: correlationId(`audit-${suffix}`),
    actor: "acceptance-suite",
    attributes: { instructionId: suffix, status: "settled" },
  };
}

function scheduler(): AuditScheduler & { run(): Promise<void> } {
  let operation: (() => Promise<void>) | undefined;
  return {
    schedule(_interval, callback) {
      operation = callback;
      return { cancel() { operation = undefined; } };
    },
    async run() {
      await operation?.();
    },
  };
}

const checksum: AuditChecksum = {
  calculate(lines) {
    return `checksum-${lines.join("|").length.toString(16).padStart(8, "0")}`;
  },
};

function sink(): AuditSink & { batches: AuditBatch[]; closes: number } {
  return {
    batches: [],
    closes: 0,
    async write(batch) {
      this.batches.push(batch);
    },
    async close() {
      this.closes += 1;
    },
  };
}

const policy = { maximumBatchSize: 2, flushIntervalMs: 10, maximumBufferedRecords: 10 };

test("normal: reaching the threshold persists one batch", async () => {
  const target = sink();
  const buffer = new AuditLogBuffer(target, scheduler(), checksum, policy);
  await buffer.append(record("normal01"));
  await buffer.append(record("normal02"));
  assert.equal(target.batches.length, 1);
  assert.deepEqual(target.batches[0]?.records.map((item) => item.recordId), ["aud_normal01", "aud_normal02"]);
});

test("boundary: shutdown flushes one remaining record before closing the sink", async () => {
  const target = sink();
  const buffer = new AuditLogBuffer(target, scheduler(), checksum, policy);
  await buffer.append(record("single01"));
  await buffer.shutdown();
  assert.equal(target.batches.length, 1);
  assert.equal(target.batches[0]?.records.length, 1);
  assert.equal(target.closes, 1);
});

test("failure: a failed write retains records for a later flush", async () => {
  let attempts = 0;
  const batches: AuditBatch[] = [];
  const target: AuditSink = {
    async write(batch) {
      attempts += 1;
      if (attempts === 1) throw new Error("disk unavailable");
      batches.push(batch);
    },
    async close() {},
  };
  const buffer = new AuditLogBuffer(target, scheduler(), checksum, policy);
  await buffer.append(record("failed01"));
  await assert.rejects(buffer.flush(), /disk unavailable/u);
  const result = await buffer.flush();
  assert.equal(result.persistedRecords, 1);
  assert.equal(batches.length, 1);
});

test("concurrency: simultaneous flush callers share one persistence operation", async () => {
  let writes = 0;
  const target: AuditSink = {
    async write() {
      writes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    async close() {},
  };
  const buffer = new AuditLogBuffer(target, scheduler(), checksum, policy);
  await buffer.append(record("race0001"));
  const [first, second, third] = await Promise.all([buffer.flush(), buffer.flush(), buffer.flush()]);
  assert.equal(writes, 1);
  assert.equal(first.persistedRecords + second.persistedRecords + third.persistedRecords, 1);
});
