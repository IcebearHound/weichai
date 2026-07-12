
import assert from "node:assert/strict";
import test from "node:test";
import { currency, ExpiringRequestMux, PartitionedSignalRunner, ThresholdSink, type AuditEntry, type TradeSignal } from "../src/index.js";

test("currency normalization rejects malformed codes", () => {
  assert.equal(currency(" usd "), "USD");
  assert.throws(() => currency("US"));
});

test("request mux shares a concurrent loader and keeps a fresh value", async () => {
  let now = 1_000;
  let calls = 0;
  const mux = new ExpiringRequestMux<string, number>(5_000, 200, 30_000, () => now);
  const loader = async () => { calls += 1; await Promise.resolve(); return 17; };
  assert.deepEqual(await Promise.all([mux.load("USD/EUR", loader), mux.load("USD/EUR", loader)]), [17, 17]);
  now += 100;
  assert.equal(await mux.load("USD/EUR", loader), 17);
  assert.equal(calls, 1);
});

test("account lane acknowledges only after handling", async () => {
  const runner = new PartitionedSignalRunner();
  const order: string[] = [];
  const signal = (sequence: number): TradeSignal => ({ messageId:`m${sequence}`, account:"a", sequence, occurredAt:sequence,
    instrument:"EURUSD", side:"buy", quantity:1, tags:[] });
  await Promise.all([1, 2].map((sequence) => runner.accept(signal(sequence), async (entry) => { order.push(`run:${entry.sequence}`); },
    async (entry) => { order.push(`ack:${entry.sequence}`); })));
  assert.deepEqual(order, ["run:1", "ack:1", "run:2", "ack:2"]);
});

test("sink writes on threshold and drains during close", async () => {
  const batches: number[] = [];
  const sink = new ThresholdSink(2, 10_000, async (entries) => { batches.push(entries.length); });
  const entry = (identity: string): AuditEntry => ({ identity, occurredAt:Date.now(), category:"test", actor:"suite", fields:{} });
  await sink.append(entry("1"));
  await sink.append(entry("2"));
  await sink.append(entry("3"));
  await sink.close();
  assert.deepEqual(batches, [2, 1]);
});
