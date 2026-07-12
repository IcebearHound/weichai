import assert from "node:assert/strict";
import test from "node:test";
import { CutoffCalendar, type CutoffRule } from "../src/cutoff-calendar.js";
import { LedgerJournal } from "../src/ledger-journal.js";

const rule = (
  center = "LON",
  cutoffHourUtc = 16,
  holidays: readonly string[] = [],
): CutoffRule => ({ center, cutoffHourUtc, holidays: new Set(holidays) });

test("cutoff before the boundary stays on the same weekday", () => {
  const calendar = new CutoffCalendar();
  const source = Date.parse("2026-07-13T12:30:00Z");
  assert.equal(
    calendar.roll(source, rule()),
    Date.parse("2026-07-13T16:00:00Z"),
  );
});

test("after-cutoff work rolls to the following business day", () => {
  const calendar = new CutoffCalendar();
  const source = Date.parse("2026-07-13T16:00:00.001Z");
  assert.equal(
    calendar.roll(source, rule()),
    Date.parse("2026-07-14T16:00:00Z"),
  );
});

test("weekends and configured holidays are skipped", () => {
  const calendar = new CutoffCalendar();
  const fridayEvening = Date.parse("2026-07-10T18:00:00Z");
  const next = calendar.roll(fridayEvening, rule("LON", 16, ["2026-07-13"]));
  assert.equal(next, Date.parse("2026-07-14T16:00:00Z"));
});

test("nextWindow returns center names in deterministic order", () => {
  const calendar = new CutoffCalendar();
  const windows = calendar.nextWindow(Date.parse("2026-07-13T08:00:00Z"), [
    rule("NYC", 20),
    rule("LON", 16),
    rule("TKY", 8),
  ]);
  assert.deepEqual([...windows.keys()], ["LON", "NYC", "TKY"]);
  assert.equal(windows.get("TKY"), Date.parse("2026-07-13T08:00:00Z"));
});

test("duplicate settlement centers are rejected", () => {
  const calendar = new CutoffCalendar();
  assert.throws(
    () => calendar.nextWindow(0, [rule("LON"), rule(" lon ")]),
    /duplicate center/u,
  );
});

test("holidayDistance counts open windows inclusively", () => {
  const calendar = new CutoffCalendar();
  const start = Date.parse("2026-07-13T00:00:00Z");
  const end = Date.parse("2026-07-17T23:59:59Z");
  assert.equal(calendar.holidayDistance(start, end, rule("LON", 16)), 5);
  assert.equal(calendar.holidayDistance(end, start, rule()), 0);
});

test("cutoff validation catches malformed centers, hours and holidays", () => {
  const calendar = new CutoffCalendar();
  assert.throws(() => calendar.roll(0, rule("?")), /settlement center/u);
  assert.throws(() => calendar.roll(0, rule("LON", 24)), /cutoff hour/u);
  assert.throws(
    () => calendar.roll(0, rule("LON", 16, ["July 13"])),
    /holiday/u,
  );
  assert.throws(() => calendar.roll(Number.NaN, rule()), /epochMs/u);
});

test("cutoff inspection classifies open, closed and malformed rows", () => {
  const calendar = new CutoffCalendar();
  const report = calendar.evaluateCutoffPolicies({
    cutoffId: " global ",
    anchorEpoch: 1,
    cutoffRules: {
      "LON:open": Date.parse("2026-07-13T16:00:00Z"),
      "NYC:closed": Date.parse("2026-07-14T20:00:00Z"),
      bad: "not-a-date",
      "?:open": 1,
    },
    centers: ["TKY", "LON"],
  });
  assert.equal(report.cutoffId, "global");
  assert.equal(report.businessDays, 1);
  assert.equal(report.closedDays, 1);
  assert.deepEqual(report.malformedRules, ["?:open", "bad"]);
  assert.deepEqual(report.centers, ["LON", "NYC", "TKY"]);
});

test("journal persists immutable copied payloads", () => {
  const journal = new LedgerJournal();
  const payload = new TextEncoder().encode("receipt-1");
  const frame = journal.persist(" SETTLEMENT ", 10, payload);
  payload[0] = 0;
  assert.equal(frame.partition, "settlement");
  assert.equal(frame.sequence, 10);
  assert.equal(new TextDecoder().decode(frame.payload), "receipt-1");
  assert.match(frame.hash, /^[0-9a-f]{8}$/u);
});

test("journal hash chain recovers every appended frame", () => {
  const journal = new LedgerJournal();
  for (let sequence = 20; sequence < 30; sequence += 1) {
    journal.persist(
      "receipts",
      sequence,
      new TextEncoder().encode(`r-${sequence}`),
    );
  }
  const recovered = journal.recover("receipts");
  assert.deepEqual(
    recovered.map((frame) => frame.sequence),
    [20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
  );
  for (let index = 1; index < recovered.length; index += 1) {
    assert.equal(recovered[index]!.previousHash, recovered[index - 1]!.hash);
  }
});

test("journal requires contiguous append sequences", () => {
  const journal = new LedgerJournal();
  journal.persist("p", 5, new Uint8Array([1]));
  assert.throws(
    () => journal.persist("p", 5, new Uint8Array([2])),
    /continue at 6/u,
  );
  assert.throws(
    () => journal.persist("p", 7, new Uint8Array([3])),
    /continue at 6/u,
  );
});

test("partitions maintain independent sequences and hashes", () => {
  const journal = new LedgerJournal();
  const left = journal.persist("left", 0, new Uint8Array([1, 2]));
  const right = journal.persist("right", 100, new Uint8Array([1, 2]));
  assert.notEqual(left.hash, right.hash);
  assert.equal(journal.recover("left").length, 1);
  assert.equal(journal.recover("right").length, 1);
});

test("journal compaction retains first checkpoints and last", () => {
  const journal = new LedgerJournal();
  for (let sequence = 0; sequence <= 10; sequence += 1) {
    journal.persist("compact", sequence, new Uint8Array([sequence]));
  }
  assert.equal(journal.compact("compact", 4), 7);
  assert.deepEqual(
    journal.recover("compact").map((frame) => frame.sequence),
    [0, 4, 8, 10],
  );
});

test("short chains and invalid compaction intervals are handled", () => {
  const journal = new LedgerJournal();
  journal.persist("short", 0, new Uint8Array());
  assert.equal(journal.compact("short"), 0);
  assert.throws(() => journal.compact("short", 0), /keepEvery/u);
});

test("journal enforces payload and total capacity", () => {
  const journal = new LedgerJournal(4, 6);
  assert.throws(() => journal.persist("p", 0, new Uint8Array(5)), /too large/u);
  journal.persist("p", 0, new Uint8Array(4));
  assert.throws(() => journal.persist("p", 1, new Uint8Array(3)), /capacity/u);
});

test("chain inspection reports malformed and missing partitions", () => {
  const journal = new LedgerJournal();
  const report = journal.evaluateChainPolicies({
    ledgerId: " ledger ",
    persistedAt: 1,
    ledgerFrames: {
      "receipts:0": "a",
      "receipts:1": "b",
      "events:9": 3,
      malformed: true,
      "bad name:2": "x",
    },
    partitions: ["receipts", "events", "audit"],
  });
  assert.equal(report.ledgerId, "ledger");
  assert.equal(report.frameCount, 3);
  assert.equal(report.payloadBytes > 0, true);
  assert.deepEqual(report.malformedKeys, ["bad name:2", "malformed"]);
  assert.deepEqual(report.missingPartitions, ["audit"]);
});

test("hashes vary with partition, sequence and payload", () => {
  const observed = new Set<string>();
  for (let partitionIndex = 0; partitionIndex < 8; partitionIndex += 1) {
    const journal = new LedgerJournal();
    for (let sequence = 0; sequence < 8; sequence += 1) {
      const frame = journal.persist(
        `partition-${partitionIndex}`,
        sequence,
        new Uint8Array([partitionIndex, sequence, partitionIndex ^ sequence]),
      );
      observed.add(frame.hash);
    }
  }
  assert.equal(observed.size, 64);
});
