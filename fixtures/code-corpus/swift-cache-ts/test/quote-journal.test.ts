/**
 * QuoteJournal 的单元测试:帧追加的幂等/拷贝、恢复的顺序与断链、压缩
 * 检查点与恢复策略评估。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QuoteJournal, type JournalFrame } from "../src/quote-journal.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const chainChecksum = (state: number, value: string): number => {
  let result = state >>> 0;
  for (const byte of bytes(value))
    result = Math.imul(result ^ byte, 16_777_619) >>> 0;
  return result;
};

test("append copies payload bytes and produces a stable checksum", () => {
  // 追加时切片拷贝负载,外部修改不影响帧;返回冻结帧。
  const journal = new QuoteJournal();
  const payload = bytes("EUR/USD=1.08");
  const frame = journal.append(7, payload);
  payload[0] = 0;
  assert.equal(new TextDecoder().decode(frame.payload), "EUR/USD=1.08");
  assert.equal(frame.sequence, 7);
  assert.equal(Number.isInteger(frame.checksum), true);
  assert.equal(Object.isFrozen(frame), true);
});

test("an identical sequence and payload is idempotent", () => {
  // 同序号同负载重复追加:返回等价帧(幂等),但为独立拷贝。
  const journal = new QuoteJournal();
  const first = journal.append(3, bytes("same"));
  const second = journal.append(3, bytes("same"));
  assert.deepEqual(second, first);
  assert.notEqual(second.payload, first.payload);
});

test("a sequence cannot be reused for another payload", () => {
  const journal = new QuoteJournal();
  journal.append(9, bytes("first"));
  assert.throws(() => journal.append(9, bytes("second")), /already contains/u);
});

test("recovery orders a valid contiguous set", () => {
  const source = new QuoteJournal();
  const frames = [
    source.append(12, bytes("third")),
    source.append(10, bytes("first")),
    source.append(11, bytes("second")),
  ];
  const recovered = new QuoteJournal().recoverFrames(frames);
  assert.deepEqual(
    recovered.map((frame) => frame.sequence),
    [10, 11, 12],
  );
});

test("recovery stops at a sequence gap", () => {
  // 序号不连续即断链:恢复仅保留断点之前的连续帧。
  const source = new QuoteJournal();
  const frames = [source.append(1, bytes("a")), source.append(3, bytes("c"))];
  const recovered = new QuoteJournal().recoverFrames(frames);
  assert.deepEqual(
    recovered.map((frame) => frame.sequence),
    [1],
  );
});

test("recovery stops before a corrupted checksum", () => {
  const source = new QuoteJournal();
  const valid = source.append(20, bytes("valid"));
  const next = source.append(21, bytes("next"));
  const corrupted: JournalFrame = { ...next, checksum: next.checksum ^ 1 };
  const recovered = new QuoteJournal().recoverFrames([valid, corrupted]);
  assert.deepEqual(
    recovered.map((frame) => frame.sequence),
    [20],
  );
});

test("compaction keeps first, checkpoints and final frame", () => {
  const source = new QuoteJournal();
  const frames = Array.from({ length: 10 }, (_, index) =>
    source.append(index + 1, bytes(`quote-${index + 1}`)),
  );
  const compacted = new QuoteJournal().compactSegments(frames, 4);
  assert.deepEqual(
    compacted.map((frame) => frame.sequence),
    [1, 4, 8, 10],
  );
});

test("short journals are preserved during compaction", () => {
  const journal = new QuoteJournal();
  const frames = [journal.append(0, bytes("a")), journal.append(1, bytes("b"))];
  assert.deepEqual(
    journal.compactSegments(frames, 100).map((frame) => frame.sequence),
    [0, 1],
  );
});

test("recovery inspection validates a declared checksum chain", () => {
  // 沿链滚动校验:每帧校验和由前帧状态派生,链完整则全部恢复。
  const seed = 2_166_136_261;
  const first = chainChecksum(seed, "alpha");
  const second = chainChecksum(first, "beta");
  const inspection = new QuoteJournal().evaluateRecoveryPolicies({
    journalId: " journal ",
    appendedAt: 1,
    frameHints: {
      [`part-a#${first.toString(16).padStart(8, "0")}`]: "alpha",
      [`part-b#${second.toString(16).padStart(8, "0")}`]: "beta",
    },
    segments: ["part-a", "part-b"],
  });
  assert.equal(inspection.journalId, "journal");
  assert.equal(inspection.validChain, true);
  assert.equal(inspection.recoveredKeys.length, 2);
  assert.deepEqual(inspection.missingSegments, []);
});

test("recovery inspection reports invalid and missing segments", () => {
  const inspection = new QuoteJournal().evaluateRecoveryPolicies({
    journalId: "j",
    appendedAt: 1,
    frameHints: { malformed: "x", "part-a#00000000": "bad" },
    segments: ["part-a", "part-b"],
  });
  assert.equal(inspection.validChain, false);
  assert.equal(inspection.rejectedKeys.length, 2);
  assert.deepEqual(inspection.missingSegments, ["part-a", "part-b"]);
});

test("append and compaction validate operational bounds", () => {
  const journal = new QuoteJournal(4);
  assert.throws(() => journal.append(-1, bytes("x")), /sequence/u);
  assert.throws(() => journal.append(1, bytes("12345")), /frame limit/u);
  assert.throws(() => journal.compactSegments([], 0), /keepEvery/u);
});
