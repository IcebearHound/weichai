import assert from "node:assert/strict";
import test from "node:test";
import { planAccountOrdering } from "../../src/domain/trades/account-ordering-planner.js";
import { planAuditSegmentation } from "../../src/domain/audit/audit-segmentation-planner.js";

test("account ordering dispatches different accounts into separate lanes", () => {
  const now = new Date("2026-07-12T08:00:00.000Z");
  const events = ["ACC-AB12", "ACC-CD34"].map((accountId, index) => ({
    messageId: `message-${index}`,
    eventId: `event-${index}`,
    accountId,
    tradeId: `trade-${index}`,
    sequence: 0,
    partition: index,
    offset: 0,
    deliveryAttempt: 1,
    receivedAt: now,
    priority: 1,
  }));
  const result = planAccountOrdering({
    events,
    lanes: [],
    deduplication: [],
    activeAccountIds: [],
    now,
    policy: {
      maximumParallelAccounts: 2,
      maximumQueueDepthPerAccount: 10,
      maximumDeliveryAttempts: 5,
      gapWaitMs: 100,
      failureBackoffMs: 100,
      allowInitialNonZeroSequence: false,
      deadLetterAfterAttempts: true,
      prioritizeOldestAccount: true,
    },
  });
  assert.equal(result.dispatches.filter((item) => item.action === "handle").length, 2);
  assert.equal(new Set(Object.values(result.laneAssignments)).size, 2);
});

test("audit segmentation assigns contiguous sequences", () => {
  const now = new Date("2026-07-12T08:00:00.000Z");
  const records = ["audit-1", "audit-2"].map((recordId, index) => ({
    recordId,
    eventType: "settlement.completed",
    severity: "notice",
    correlationId: `correlation-${index}`,
    occurredAt: new Date(now.getTime() + index),
    encodedBytes: 200,
    partitionKey: "account-1",
    immutable: true,
    attributes: { index },
  }));
  const result = planAuditSegmentation({
    records,
    segments: [],
    trigger: "manual",
    now,
    nextSequence: 10,
    callerId: "unit-test",
    policy: {
      partitionCount: 2,
      maximumRecordsPerSegment: 100,
      maximumBytesPerSegment: 10_000,
      maximumSegmentAgeMs: 60_000,
      maximumBatchRecords: 10,
      maximumBatchBytes: 5_000,
      minimumBatchRecords: 1,
      rotateOnCriticalRecord: true,
      preserveCorrelationGroups: false,
      checksumAlgorithm: "fnv1a",
    },
  });
  assert.equal(result.totalRecords, 2);
  assert.equal(result.nextSequence, 12);
  assert.equal(result.writes[0]?.firstSequence, 10);
});
