/**
 * 性质测试:对批次、结算波次、窗口均值、重试预算、段放置与数据包重建
 * 做随机化/遍历验证,确保关键不变量在规模变化下成立。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  OrderedBatchMap,
  WindowLedger,
  constructSettlementWaves,
  optimizeRetryBudget,
  planSegmentMigration,
  repairFrameSequence,
} from "../src/index.js";
import { USD, extent, frame, observation, retry, settlement } from "./scenario-fixtures.js";

test("batch outcomes retain ordinal identity for varied completion order", async () => {
  // 40 条意图随机完成顺序:输出槽位恒与输入序号一一对应。
  const batch = new OrderedBatchMap();
  const intents = Array.from({ length: 40 }, (_value, ordinal) => settlement(
    `property-${ordinal}`,
    `account-${ordinal % 7}`,
    ordinal + 1,
    USD,
    "2026-07-20",
    ordinal % 11,
  ));
  const outcomes = await batch.collect(intents, async (intent) => {
    const ordinal = Number(intent.identity.split("-")[1]);
    await new Promise((resolve) => setTimeout(resolve, ordinal % 4));
    return `receipt:${intent.identity}`;
  }, 1);
  assert.equal(outcomes.length, intents.length);
  for (let ordinal = 0; ordinal < outcomes.length; ordinal += 1) {
    assert.equal(outcomes[ordinal].ordinal, ordinal);
    assert.equal(outcomes[ordinal].identity, intents[ordinal].identity);
    assert.equal(outcomes[ordinal].receipt, `receipt:${intents[ordinal].identity}`);
  }
});

test("settlement planner assigns every accepted identity exactly once", () => {
  // 60 条意图:全部被分配且无重复,同一波次内账户互不重复。
  const intents = Array.from({ length: 60 }, (_value, ordinal) => settlement(
    `wave-${ordinal}`,
    `account-${ordinal % 13}`,
    10 + ordinal,
    USD,
    `2026-07-${String(13 + ordinal % 7).padStart(2, "0")}`,
    (ordinal * 17) % 100,
  ));
  const plan = constructSettlementWaves(intents, {}, { USD: 1_000_000 }, new Set());
  const assigned = plan.waves.flat().map((intent) => intent.identity);
  assert.equal(plan.rejected.size, 0);
  assert.equal(assigned.length, intents.length);
  assert.equal(new Set(assigned).size, intents.length);
  for (const wave of plan.waves) {
    assert.equal(new Set(wave.map((intent) => intent.account)).size, wave.length);
  }
});

test("weighted window means stay between their observations", () => {
  // 25 组随机数据:加权均值必然落在观测值的最小/最大之间。
  for (let scenario = 1; scenario <= 25; scenario += 1) {
    const ledger = new WindowLedger();
    const values = Array.from({ length: 8 }, (_value, index) => ((scenario * 31 + index * 17) % 101) - 50);
    let bucket = -1;
    for (let index = 0; index < values.length; index += 1) {
      bucket = ledger.ingest(observation(
        `sensor-${scenario}`,
        `account-${scenario}`,
        index,
        1_000 + index,
        values[index],
        "ready",
        1 + index % 3,
      ), 10_000);
    }
    const aggregate = ledger.closeWindow(bucket)!;
    assert.ok(aggregate.weightedMean >= Math.min(...values));
    assert.ok(aggregate.weightedMean <= Math.max(...values));
    assert.equal(aggregate.count, values.length);
  }
});

test("retry optimization never exceeds integer budgets", () => {
  const tickets = Array.from({ length: 24 }, (_value, index) => retry(
    `ticket-${index}`,
    `account-${index % 5}`,
    900 + index,
    1 + index % 7,
    1 + index % 4,
    2_000 + index * 10,
  ));
  for (let budget = 0; budget <= 40; budget += 2) {
    const plan = optimizeRetryBudget(tickets, budget, {
      "account-0": 0.4,
      "account-1": 0.4,
      "account-2": 0.4,
      "account-3": 0.4,
      "account-4": 0.4,
    }, 1_000);
    assert.ok(plan.spent <= budget);
    assert.equal(plan.selected.reduce((sum, ticket) => sum + ticket.cost, 0), plan.spent);
    assert.equal(new Set(plan.selected.map((ticket) => ticket.identity)).size, plan.selected.length);
  }
});

test("segment placements are aligned, bounded, and non-overlapping", () => {
  // 30 条 extent 放置到 3 个段:8 字节对齐、不越界、互不重叠。
  const extents = Array.from({ length: 30 }, (_value, index) => extent(
    `source-${index % 3}`,
    index * 40,
    12 + index % 9,
    true,
    10_000 + index,
  ));
  const capacities = { targetA: 512, targetB: 512, targetC: 512 };
  const plan = planSegmentMigration(extents, capacities);
  const occupied = new Map<string, Array<{ start: number; end: number }>>();
  for (const [ordinal, placement] of plan.placements) {
    const length = extents[ordinal].length;
    assert.equal(placement.offset % 8, 0);
    assert.ok(placement.offset + length <= capacities[placement.segment as keyof typeof capacities]);
    const ranges = occupied.get(placement.segment) ?? [];
    assert.equal(ranges.some((range) => placement.offset < range.end && placement.offset + length > range.start), false);
    ranges.push({ start: placement.offset, end: placement.offset + length });
    occupied.set(placement.segment, ranges);
  }
});

test("packet reconstruction is permutation invariant", () => {
  // 帧输入顺序任意排列,重建的摘要与修复结果必须一致。
  const canonical = [
    frame(0, [1, 2]),
    frame(1, [3, 4]),
    frame(2, [5, 6]),
    frame(3, [7, 8], true),
  ];
  const permutations = [
    canonical,
    [canonical[3], canonical[2], canonical[1], canonical[0]],
    [canonical[1], canonical[3], canonical[0], canonical[2]],
    [canonical[2], canonical[0], canonical[3], canonical[1]],
  ];
  const baseline = repairFrameSequence(permutations[0], 0);
  for (const permutation of permutations.slice(1)) {
    const result = repairFrameSequence(permutation, 0);
    assert.equal(result.digest, baseline.digest);
    assert.deepEqual(result.repaired.map((entry) => entry.ordinal), [0, 1, 2, 3]);
    assert.equal(result.complete, true);
  }
});
