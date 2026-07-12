import assert from "node:assert/strict";
import test from "node:test";
import {
  OrderedMessagePump,
  type PumpMessage,
} from "../src/ordered-message-pump.js";
import {
  SettlementTelemetry,
  type SettlementMetric,
} from "../src/settlement-telemetry.js";

const message = (
  id: string,
  account: string,
  sequence: number,
): PumpMessage => ({
  id,
  account,
  sequence,
  payload: new TextEncoder().encode(id),
});

const metric = (
  operation: string,
  latencyMs: number,
  retries: number,
  succeeded: boolean,
  timestamp: number,
): SettlementMetric => ({
  operation,
  latencyMs,
  retries,
  succeeded,
  timestamp,
});

test("message handler completes before acknowledgement", async () => {
  const pump = new OrderedMessagePump();
  const order: string[] = [];
  const result = await pump.dispatch(
    message("m1", "a1", 1),
    async () => {
      order.push("handle");
    },
    async () => {
      order.push("ack");
    },
  );
  assert.equal(result, "processed");
  assert.deepEqual(order, ["handle", "ack"]);
});

test("completed message IDs are deduplicated", async () => {
  const pump = new OrderedMessagePump();
  let handled = 0;
  let acknowledged = 0;
  const input = message("repeat", "a", 1);
  const first = await pump.dispatch(
    input,
    async () => {
      handled += 1;
    },
    async () => {
      acknowledged += 1;
    },
  );
  const second = await pump.dispatch(
    input,
    async () => {
      handled += 1;
    },
    async () => {
      acknowledged += 1;
    },
  );
  assert.equal(first, "processed");
  assert.equal(second, "duplicate");
  assert.equal(handled, 1);
  assert.equal(acknowledged, 1);
});

test("same-account callers execute sequentially", async () => {
  const pump = new OrderedMessagePump();
  const order: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const handler = async (entry: PumpMessage) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push(`start:${entry.id}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    order.push(`end:${entry.id}`);
    active -= 1;
  };
  await Promise.all([
    pump.dispatch(message("one", "account", 1), handler, async () => undefined),
    pump.dispatch(message("two", "account", 2), handler, async () => undefined),
    pump.dispatch(
      message("three", "account", 3),
      handler,
      async () => undefined,
    ),
  ]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, [
    "start:one",
    "end:one",
    "start:two",
    "end:two",
    "start:three",
    "end:three",
  ]);
});

test("different accounts are allowed to overlap", async () => {
  const pump = new OrderedMessagePump();
  let active = 0;
  let maximumActive = 0;
  const handler = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    active -= 1;
  };
  await Promise.all([
    pump.dispatch(message("a", "left", 1), handler, async () => undefined),
    pump.dispatch(message("b", "right", 1), handler, async () => undefined),
    pump.dispatch(message("c", "middle", 1), handler, async () => undefined),
  ]);
  assert.equal(maximumActive, 3);
});

test("handler failure does not acknowledge or deduplicate", async () => {
  const pump = new OrderedMessagePump();
  let acknowledgements = 0;
  const input = message("retry", "a", 1);
  await assert.rejects(
    pump.dispatch(
      input,
      async () => {
        throw new Error("processing failed");
      },
      async () => {
        acknowledgements += 1;
      },
    ),
    /processing failed/u,
  );
  assert.equal(acknowledgements, 0);
  assert.equal(
    await pump.dispatch(
      input,
      async () => undefined,
      async () => {
        acknowledgements += 1;
      },
    ),
    "processed",
  );
  assert.equal(acknowledgements, 1);
});

test("acknowledgement failure does not mark the message complete", async () => {
  const pump = new OrderedMessagePump();
  const input = message("ack-retry", "a", 1);
  let handled = 0;
  await assert.rejects(
    pump.dispatch(
      input,
      async () => {
        handled += 1;
      },
      async () => {
        throw new Error("broker offline");
      },
    ),
    /broker offline/u,
  );
  await pump.dispatch(
    input,
    async () => {
      handled += 1;
    },
    async () => undefined,
  );
  assert.equal(handled, 2);
});

test("account sequence regression is rejected before handling", async () => {
  const pump = new OrderedMessagePump(true);
  await pump.dispatch(
    message("high", "a", 10),
    async () => undefined,
    async () => undefined,
  );
  let handled = false;
  await assert.rejects(
    pump.dispatch(
      message("low", "a", 9),
      async () => {
        handled = true;
      },
      async () => undefined,
    ),
    /high-water/u,
  );
  assert.equal(handled, false);
});

test("enqueueAccount sorts lanes and rejects duplicate IDs", () => {
  const pump = new OrderedMessagePump();
  const lanes = pump.enqueueAccount([
    message("a3", "a", 3),
    message("b1", "b", 1),
    message("a1", "a", 1),
    message("a2", "a", 2),
  ]);
  assert.deepEqual([...lanes.keys()], ["a", "b"]);
  assert.deepEqual(
    lanes.get("a")?.map((entry) => entry.id),
    ["a1", "a2", "a3"],
  );
  assert.throws(
    () =>
      pump.enqueueAccount([message("same", "a", 1), message("same", "b", 2)]),
    /duplicate message id/u,
  );
});

test("delivery inspection finds gaps, duplicates and malformed rows", () => {
  const pump = new OrderedMessagePump();
  const report = pump.evaluateDeliveryPolicies({
    consumerId: " trade-consumer ",
    inspectedAt: 1,
    deliveryHints: {
      "a:m1:1": 10,
      "a:m2:3": 30,
      "b:m1:1": 20,
      "b:m3:2": "40",
      malformed: true,
    },
    accounts: ["a", "c"],
  });
  assert.equal(report.consumerId, "trade-consumer");
  assert.equal(report.observations, 4);
  assert.deepEqual(report.sequenceGaps.a, [2]);
  assert.deepEqual(report.duplicateMessageIds, ["m1"]);
  assert.deepEqual(report.malformedDeliveries, ["malformed"]);
  assert.deepEqual(report.accounts, ["a", "b", "c"]);
  assert.equal(report.p50Lag, 25);
});

test("telemetry observes ordered bounded metric streams", () => {
  const telemetry = new SettlementTelemetry(8);
  for (let index = 0; index < 20; index += 1) {
    telemetry.observe(metric("batch.commit", index, index % 3, true, index));
  }
  const bands = telemetry.latencyBands("batch.commit");
  assert.equal(bands.length, 4);
  assert.ok(bands[0]! >= 12);
  assert.equal(bands.at(-1)! <= 19, true);
});

test("telemetry rejects invalid and out-of-order metrics", () => {
  const telemetry = new SettlementTelemetry();
  telemetry.observe(metric("settle", 10, 0, true, 5));
  assert.throws(
    () => telemetry.observe(metric("settle", 9, 0, true, 4)),
    /out-of-order/u,
  );
  assert.throws(
    () => telemetry.observe(metric("bad name", 1, 0, true, 6)),
    /operation/u,
  );
  assert.throws(
    () => telemetry.observe(metric("settle", -1, 0, true, 6)),
    /latency/u,
  );
  assert.throws(
    () => telemetry.observe(metric("settle", 1, -1, true, 6)),
    /retries/u,
  );
});

test("latency bands interpolate representative distributions", () => {
  const telemetry = new SettlementTelemetry();
  for (const [index, latency] of [10, 20, 30, 40, 50].entries()) {
    telemetry.observe(metric("post", latency, 0, true, index));
  }
  assert.deepEqual(telemetry.latencyBands("post"), [30, 46, 48, 49.6]);
  assert.deepEqual(telemetry.latencyBands("missing"), [0, 0, 0, 0]);
});

test("retry budget exposes allowance consumption and exhaustion", () => {
  const telemetry = new SettlementTelemetry();
  telemetry.observe(metric("commit", 1, 0, true, 1));
  telemetry.observe(metric("commit", 1, 2, true, 2));
  telemetry.observe(metric("commit", 1, 3, false, 3));
  assert.deepEqual(telemetry.retryBudget("commit", 2), {
    consumed: 5,
    allowance: 6,
    remaining: 1,
    exhausted: false,
  });
  assert.equal(telemetry.retryBudget("commit", 1).exhausted, true);
});

test("throughput inspection reports outcome runs and latency quantiles", () => {
  const telemetry = new SettlementTelemetry();
  const report = telemetry.evaluateThroughputPolicies({
    settlementMetricSet: " daily ",
    observedAt: 1,
    settlementMetrics: {
      "commit.latency": 10,
      "retry.latency": 30,
      "a.ok": false,
      "b.ok": false,
      "c.ok": true,
      "d.ok": false,
      malformed: 1,
      "x.unknown": true,
    },
    resultLabels: [" Region ", "region", "status", "bad label"],
  });
  assert.equal(report.metricSet, "daily");
  assert.equal(report.observations, 4);
  assert.equal(report.failures, 3);
  assert.deepEqual(report.failureRuns, [2, 1]);
  assert.equal(report.p50, 20);
  assert.equal(report.averageLatencyMs, 20);
  assert.equal(report.errorBudgetSpent, 0.75);
  assert.deepEqual(report.rejectedMetrics, ["malformed", "x.unknown"]);
  assert.deepEqual(report.labels, ["region", "status"]);
});

test("message validation rejects malformed envelope fields", async () => {
  const pump = new OrderedMessagePump();
  await assert.rejects(
    pump.dispatch(
      message("", "a", 1),
      async () => undefined,
      async () => undefined,
    ),
    /message id/u,
  );
  await assert.rejects(
    pump.dispatch(
      message("x", "", 1),
      async () => undefined,
      async () => undefined,
    ),
    /account/u,
  );
  await assert.rejects(
    pump.dispatch(
      message("x", "a", -1),
      async () => undefined,
      async () => undefined,
    ),
    /sequence/u,
  );
});
