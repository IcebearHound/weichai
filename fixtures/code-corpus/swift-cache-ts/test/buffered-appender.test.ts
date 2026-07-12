import assert from "node:assert/strict";
import test from "node:test";
import {
  BufferedAppender,
  type BufferedRecord,
} from "../src/buffered-appender.js";

const row = (id: string, timestamp: number): BufferedRecord => ({
  id,
  timestamp,
  fields: { kind: "quote", valid: true, ordinal: timestamp },
});

test("flush sorts records and writes bounded batches", async () => {
  let now = 100;
  const appender = new BufferedAppender(() => now++);
  const written: string[][] = [];
  const report = await appender.flushNow(
    [row("c", 3), row("a", 1), row("b", 2)],
    async (batch) => {
      written.push(batch.map((record) => record.id));
    },
    2,
  );

  assert.deepEqual(written, [["a", "b"], ["c"]]);
  assert.equal(report.persisted, 3);
  assert.equal(report.batches, 2);
  assert.equal(report.firstId, "a");
  assert.equal(report.lastId, "c");
  assert.ok(report.bytes > 0);
  assert.ok(report.completedAt >= report.startedAt);
});

test("duplicates in one request and prior writes are skipped", async () => {
  const appender = new BufferedAppender();
  const batches: string[][] = [];
  const writer = async (batch: readonly BufferedRecord[]) => {
    batches.push(batch.map((record) => record.id));
  };

  const first = await appender.flushNow(
    [row("same", 2), row("same", 1), row("other", 3)],
    writer,
  );
  const second = await appender.flushNow(
    [row("same", 8), row("third", 9)],
    writer,
  );
  assert.equal(first.persisted, 2);
  assert.equal(first.skipped, 1);
  assert.equal(second.persisted, 1);
  assert.equal(second.skipped, 1);
  assert.deepEqual(batches, [["same", "other"], ["third"]]);
});

test("a partial failure records only confirmed batches", async () => {
  const appender = new BufferedAppender();
  const attempts: string[] = [];
  await assert.rejects(
    appender.flushNow(
      [row("one", 1), row("two", 2), row("three", 3)],
      async (batch) => {
        attempts.push(batch[0]!.id);
        if (batch[0]!.id === "two") throw new Error("disk full");
      },
      1,
    ),
    /disk full/u,
  );

  const retried: string[] = [];
  const report = await appender.flushNow(
    [row("one", 1), row("two", 2), row("three", 3)],
    async (batch) => {
      retried.push(batch[0]!.id);
    },
    1,
  );
  assert.deepEqual(attempts, ["one", "two"]);
  assert.deepEqual(retried, ["two", "three"]);
  assert.equal(report.persisted, 2);
  assert.equal(report.skipped, 1);
});

test("concurrent callers never overlap writer execution", async () => {
  const appender = new BufferedAppender();
  const order: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const writer = async (batch: readonly BufferedRecord[]) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push(`start:${batch[0]!.id}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    order.push(`end:${batch[0]!.id}`);
    active -= 1;
  };

  await Promise.all([
    appender.flushNow([row("alpha", 1)], writer),
    appender.flushNow([row("beta", 2)], writer),
    appender.flushNow([row("gamma", 3)], writer),
  ]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, [
    "start:alpha",
    "end:alpha",
    "start:beta",
    "end:beta",
    "start:gamma",
    "end:gamma",
  ]);
});

test("a failing caller releases the serialized write lane", async () => {
  const appender = new BufferedAppender();
  const first = appender.flushNow([row("bad", 1)], async () => {
    throw new Error("unavailable");
  });
  const second = appender.flushNow([row("good", 2)], async () => undefined);

  await assert.rejects(first, /unavailable/u);
  assert.equal((await second).persisted, 1);
});

test("partitionBatches copies and freezes each group", () => {
  const appender = new BufferedAppender();
  const input = [row("a", 1), row("b", 2), row("c", 3)];
  const groups = appender.partitionBatches(input, 2);
  assert.deepEqual(
    groups.map((group) => group.length),
    [2, 1],
  );
  assert.equal(Object.isFrozen(groups), true);
  assert.equal(Object.isFrozen(groups[0]), true);
  (input[0]!.fields as Record<string, string | number | boolean>).ordinal = 99;
  assert.equal(groups[0]![0]!.fields.ordinal, 1);
});

test("deduplicateRows retains the earliest record per id", () => {
  const appender = new BufferedAppender();
  const unique = appender.deduplicateRows([
    row("x", 9),
    row("y", 3),
    row("x", 1),
  ]);
  assert.deepEqual(
    unique.map((record) => [record.id, record.timestamp]),
    [
      ["x", 1],
      ["y", 3],
    ],
  );
});

test("durability inspection normalizes destinations and validates hints", () => {
  const appender = new BufferedAppender(() => 1_000);
  const inspection = appender.evaluateDurabilityPolicies({
    streamId: " audit ",
    flushRequestedAt: 4_000,
    writeHints: { "valid.key": 4, " bad key ": true },
    destinations: [" Disk ", "disk", "Archive", ""],
  });
  assert.equal(inspection.streamId, "audit");
  assert.deepEqual(inspection.normalizedDestinations, ["archive", "disk"]);
  assert.deepEqual(inspection.duplicateDestinations, ["disk"]);
  assert.deepEqual(inspection.invalidKeys, [" bad key "]);
  assert.equal(inspection.requestedInFuture, true);
  assert.ok(inspection.estimatedBytes > 0);
});

test("invalid records and batch sizes fail before any write", async () => {
  const appender = new BufferedAppender();
  let calls = 0;
  const writer = async () => {
    calls += 1;
  };
  await assert.rejects(appender.flushNow([row("", 1)], writer), /empty id/u);
  await assert.rejects(
    appender.flushNow([row("x", NaN)], writer),
    /timestamp/u,
  );
  await assert.rejects(appender.flushNow([], writer, 0), /batchSize/u);
  assert.equal(calls, 0);
});
