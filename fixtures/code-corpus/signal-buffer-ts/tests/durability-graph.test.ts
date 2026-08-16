/**
 * 持久性与图算法测试:ThresholdSink、planAuditPartitions、PacketJournal、
 * repairFrameSequence、SegmentStore、planSegmentMigration、DependencyMap 与
 * minimumDependencyCut。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DependencyMap,
  PacketJournal,
  SegmentStore,
  ThresholdSink,
  minimumDependencyCut,
  planAuditPartitions,
  planSegmentMigration,
  repairFrameSequence,
} from "../src/index.js";
import {
  audit,
  dependencyFixture,
  extent,
  extentFixture,
  frame,
  packetFixture,
  node,
} from "./scenario-fixtures.js";

test("threshold sink flushes when the count reaches its threshold", async () => {
  const batches: string[][] = [];
  const sink = new ThresholdSink(3, 60_000, async (entries) => {
    batches.push(entries.map((entry) => entry.identity));
  });
  await sink.append(audit("a1", "s1"));
  await sink.append(audit("a2", "s2"));
  assert.deepEqual(batches, []);
  await sink.append(audit("a3", "s3"));
  assert.deepEqual(batches, [["a1", "a2", "a3"]]);
  await sink.close();
});

test("manual flush returns the number of persisted entries", async () => {
  const batches: number[] = [];
  const sink = new ThresholdSink(10, 60_000, async (entries) => { batches.push(entries.length); });
  await sink.append(audit("one", "s1"));
  await sink.append(audit("two", "s2"));
  assert.equal(await sink.flush("manual"), 2);
  assert.equal(await sink.flush("manual"), 0);
  assert.deepEqual(batches, [2]);
  await sink.close();
});

test("concurrent callers produce lossless batches", async () => {
  // 并发追加 41 条:全部落盘、无重复、每批不超过阈值。
  const persisted = new Set<string>();
  const batchSizes: number[] = [];
  const sink = new ThresholdSink(7, 60_000, async (entries) => {
    await Promise.resolve();
    batchSizes.push(entries.length);
    for (const entry of entries) {
      assert.equal(persisted.has(entry.identity), false);
      persisted.add(entry.identity);
    }
  });
  await Promise.all(Array.from({ length: 41 }, (_value, index) => sink.append(audit(`entry-${index}`, `subject-${index}`))));
  await sink.close();
  assert.equal(persisted.size, 41);
  assert.equal(batchSizes.reduce((sum, size) => sum + size, 0), 41);
  assert.ok(batchSizes.every((size) => size <= 7));
});

test("failed writer restores a batch for a later flush", async () => {
  // 首次写入失败后批次回退缓冲,下次 flush 仍能完整落盘。
  let attempts = 0;
  const persisted: string[] = [];
  const sink = new ThresholdSink(10, 60_000, async (entries) => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk full");
    persisted.push(...entries.map((entry) => entry.identity));
  });
  await sink.append(audit("recoverable", "subject"));
  await assert.rejects(sink.flush("manual"), /disk full/);
  assert.equal(await sink.flush("manual"), 1);
  assert.deepEqual(persisted, ["recoverable"]);
  await sink.close();
});

test("close drains remaining entries and rejects later appends", async () => {
  const persisted: string[] = [];
  const sink = new ThresholdSink(100, 60_000, async (entries) => {
    persisted.push(...entries.map((entry) => entry.identity));
  });
  await sink.append(audit("left", "s1"));
  await sink.append(audit("right", "s2"));
  await sink.close();
  assert.deepEqual(persisted, ["left", "right"]);
  await assert.rejects(sink.append(audit("late", "s3")), /closing/);
  await sink.close();
});

test("timer flush persists a partial buffer", async () => {
  const batches: number[] = [];
  const sink = new ThresholdSink(100, 15, async (entries) => { batches.push(entries.length); });
  await sink.append(audit("timer-entry", "subject"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(batches, [1]);
  await sink.close();
});

test("audit partitions redact sensitive fields", () => {
  // 敏感字段脱敏只发生在分区副本,不修改调用方的原始条目。
  const entries = [
    { ...audit("a", "s"), fields: { subject: "s", token: "visible-before-redaction", region: "eu" } },
  ];
  const partitions = planAuditPartitions(entries, 2, new Set(["token"]));
  const stored = partitions.flatMap((partition) => partition.entries)[0];
  assert.equal(stored.fields.token, "[redacted]");
  assert.equal(stored.fields.region, "eu");
  assert.equal(entries[0].fields.token, "visible-before-redaction");
});

test("audit partitioning removes duplicate identities", () => {
  const repeated = audit("same", "subject");
  const partitions = planAuditPartitions([repeated, repeated, audit("other", "subject")], 3, new Set());
  const identities = partitions.flatMap((partition) => partition.entries.map((entry) => entry.identity));
  assert.deepEqual(identities.sort(), ["other", "same"]);
});

test("audit partition statistics match their entries", () => {
  const entries = Array.from({ length: 20 }, (_value, index) => audit(
    `entry-${index}`,
    `subject-${index}`,
    `account-${index % 4}`,
    1_000 + index,
    index % 3 === 0 ? "security" : "settlement",
  ));
  const partitions = planAuditPartitions(entries, 4, new Set());
  for (const partition of partitions) {
    const categoryTotal = [...partition.categories.entries()]
      .filter(([category]) => !category.startsWith("__"))
      .reduce((sum, [, count]) => sum + count, 0);
    assert.equal(categoryTotal, partition.entries.length);
    assert.ok(partition.bytes >= partition.entries.length);
  }
});

test("packet journal verifies checksums", () => {
  const journal = new PacketJournal();
  const valid = frame(0, [1, 2, 3]);
  const damaged = { ...valid, checksum: valid.checksum + 1 };
  assert.equal(journal.verify(valid).valid, true);
  assert.equal(journal.verify(damaged).valid, false);
  assert.throws(() => journal.reorder(damaged, 1_000, 10), /checksum mismatch/);
});

test("packet journal reorders a complete stream", () => {
  const journal = new PacketJournal();
  // 乱序到达的帧在末帧就绪后按序号拼接为完整负载。
  assert.equal(journal.reorder(frame(2, [5, 6], true), 100, 10), undefined);
  assert.equal(journal.reorder(frame(0, [1, 2]), 110, 10), undefined);
  const joined = journal.reorder(frame(1, [3, 4]), 120, 10);
  assert.deepEqual([...joined!], [1, 2, 3, 4, 5, 6]);
  assert.equal(journal.density("prices-20260712", 130).frameCount, 0);
});

test("packet density reports gaps and age", () => {
  const journal = new PacketJournal();
  journal.reorder(frame(0, [1]), 1_000, 10);
  journal.reorder(frame(3, [4], true), 1_100, 10);
  const density = journal.density("prices-20260712", 1_500);
  assert.equal(density.frameCount, 2);
  assert.deepEqual(density.missing, [1, 2]);
  assert.equal(density.ageMs, 500);
  assert.equal(density.complete, false);
});

test("frame repair sorts a valid complete stream", () => {
  const repaired = repairFrameSequence(packetFixture, 0);
  assert.deepEqual(repaired.repaired.map((entry) => entry.ordinal), [0, 1, 2, 3]);
  assert.equal(repaired.complete, true);
  assert.deepEqual(repaired.missing, []);
  assert.equal(repaired.ranges.length, 1);
  assert.match(repaired.digest, /^[0-9a-f]{16}$/);
});

test("frame repair discards checksum failures and foreign streams", () => {
  const valid = frame(0, [1], true, "main");
  const corrupted = { ...frame(1, [2], false, "main"), checksum: 0 };
  const foreign = frame(2, [3], false, "other");
  const result = repairFrameSequence([valid, corrupted, foreign], 0);
  assert.equal(result.stream, "main");
  assert.ok(result.discarded.includes(1));
  assert.ok(result.discarded.includes(2));
  assert.equal(result.complete, true);
});

test("frame repair chooses the longer conflicting payload", () => {
  // 同序号冲突帧:保留负载更长者,冲突尺寸记录在 conflicts 中。
  const short = frame(0, [1], true);
  const long = frame(0, [1, 2, 3], true);
  const result = repairFrameSequence([short, long], 0);
  assert.deepEqual([...result.repaired[0].payload], [1, 2, 3]);
  assert.deepEqual(result.conflicts.get(0), [1, 3]);
  assert.ok(result.discarded.includes(0));
});

test("segment migration aligns every placement", () => {
  const plan = planSegmentMigration(extentFixture, { "compact-a": 512, "compact-b": 512 });
  assert.equal(plan.unplaced.length, 0);
  for (const placement of plan.placements.values()) assert.equal(placement.offset % 8, 0);
  assert.ok(plan.utilization.get("compact-a")! > 0);
  assert.ok(plan.estimatedBytes > 0);
});

test("segment migration reports insufficient capacity", () => {
  const plan = planSegmentMigration([
    extent("old", 0, 100),
    extent("old", 100, 100),
  ], { tiny: 120 });
  assert.equal(plan.placements.size, 1);
  assert.equal(plan.unplaced.length, 1);
  assert.ok(plan.fragmentation.get("tiny")!.freeBytes < 120);
});

test("migration waves avoid using a segment twice", () => {
  // 同一波次内任何段(源或目标)至多被一个迁移占用,避免读写冲突。
  const plan = planSegmentMigration(extentFixture, { "new-a": 512, "new-b": 512, "new-c": 512 });
  for (const wave of plan.waves) {
    const busy = new Set<string>();
    for (const ordinal of wave) {
      const move = plan.moves.find((candidate) => candidate.ordinal === ordinal)!;
      assert.equal(busy.has(move.fromSegment), false);
      assert.equal(busy.has(move.toSegment), false);
      busy.add(move.fromSegment);
      busy.add(move.toSegment);
    }
  }
});

test("migration validates overlaps and unknown source segments", () => {
  const plan = planSegmentMigration([
    extent("known", 0, 20),
    extent("known", 10, 20),
    extent("unknown", 0, 5),
  ], { known: 100 });
  assert.ok(plan.conflicts.some((message) => message.includes("overlap")));
  assert.ok(plan.conflicts.some((message) => message.includes("unknown segment")));
});

test("empty segment store queries return neutral state", () => {
  const store = new SegmentStore();
  assert.deepEqual(store.compact("missing", new Set()), []);
  assert.deepEqual(store.sparseIndex("missing", 1), []);
  assert.deepEqual(store.fragmentation("missing"), { occupied: 0, gaps: 0, tail: 0, ratio: 0, largestGap: 0 });
  assert.throws(() => store.sparseIndex("missing", 0), /stride/);
});

test("dependency map returns stable topological order", () => {
  const graph = new DependencyMap();
  // 拓扑序:每个节点的前置必须排在它之前。
  dependencyFixture.forEach((entry, index) => graph.register(entry, 1_000 + index));
  const result = graph.topological();
  const position = new Map(result.ordered.map((entry, index) => [entry.id, index]));
  for (const entry of dependencyFixture) {
    for (const prerequisite of entry.prerequisites) assert.ok(position.get(prerequisite)! < position.get(entry.id)!);
  }
  assert.deepEqual(result.blocked, []);
});

test("dependency map identifies cycles", () => {
  const graph = new DependencyMap();
  graph.register(node("a", ["c"]), 1);
  graph.register(node("b", ["a"]), 2);
  graph.register(node("c", ["b"]), 3);
  const result = graph.topological();
  assert.deepEqual(result.ordered, []);
  assert.deepEqual(result.blocked, ["a", "b", "c"]);
});

test("dependency registration rejects malformed nodes", () => {
  const graph = new DependencyMap();
  assert.throws(() => graph.register(node(""), 1), /id is required/);
  assert.throws(() => graph.register(node("negative", [], -1), 1), /cost/);
  assert.throws(() => graph.register(node("self", ["self"]), 1), /itself/);
  assert.throws(() => graph.register(node("duplicate", ["a", "a"]), 1), /duplicate prerequisites/);
});

test("propagation batches descendants by capacity", () => {
  const graph = new DependencyMap();
  dependencyFixture.forEach((entry, index) => graph.register(entry, index));
  const waves = graph.propagation(["ingest"], 2);
  assert.ok(waves.every((wave) => wave.length <= 2));
  assert.equal(waves.flat()[0].id, "ingest");
  assert.equal(new Set(waves.flat().map((entry) => entry.id)).size, dependencyFixture.length);
  assert.throws(() => graph.propagation(["ingest"], 0), /capacity/);
});

test("minimum dependency cut separates root and terminal", () => {
  // 从 ingest 到 publish 的最小代价割:存在割、代价为正且无环。
  const result = minimumDependencyCut(dependencyFixture, ["ingest"], new Set(["publish"]));
  assert.ok(result.cut.length >= 1);
  assert.ok(result.cost > 0);
  assert.equal(result.unreachable.length, 0);
  assert.equal(result.cycles.length, 0);
  assert.ok(result.criticalPaths[0].path.includes("publish"));
});

test("minimum dependency cut reports cycles and missing references", () => {
  const result = minimumDependencyCut([
    node("a", ["c"]),
    node("b", ["a"]),
    node("c", ["b"]),
    node("orphan", ["missing"]),
  ], ["a"], new Set(["c", "unknown-terminal"]));
  assert.deepEqual(result.cycles[0], ["a", "b", "c"]);
  assert.ok(result.missingReferences.includes("orphan->missing"));
  assert.ok(result.unreachable.includes("unknown-terminal"));
});
