import assert from "node:assert/strict";
import test from "node:test";
import {
  OrderedBatchCommitter,
  type SettlementItem,
} from "../src/ordered-batch-committer.js";

const item = (
  instructionId: string,
  accountId: string,
  amountMinor: bigint,
  currency = "EUR",
): SettlementItem => ({ instructionId, accountId, amountMinor, currency });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
};

test("successful batch outcomes retain the original input order", async () => {
  const committer = new OrderedBatchCommitter(3, 0, async () => undefined);
  const items = [
    item("third", "c", 30n),
    item("first", "a", 10n),
    item("second", "b", 20n),
  ];
  const completionOrder: string[] = [];
  const result = await committer.commit(items, "order-1", async (entry) => {
    await new Promise((resolve) =>
      setTimeout(resolve, entry.instructionId === "third" ? 4 : 1),
    );
    completionOrder.push(entry.instructionId);
    return `receipt-${entry.instructionId}`;
  });

  assert.notDeepEqual(
    completionOrder,
    items.map((entry) => entry.instructionId),
  );
  assert.deepEqual(
    result.map((outcome) => outcome.instructionId),
    ["third", "first", "second"],
  );
  assert.deepEqual(
    result.map((outcome) => outcome.receipt),
    ["receipt-third", "receipt-first", "receipt-second"],
  );
  assert.equal(
    result.every((outcome) => outcome.status === "settled"),
    true,
  );
});

test("only the failing instruction is retried", async () => {
  const delays: number[] = [];
  const committer = new OrderedBatchCommitter(3, 5, async (delay) => {
    delays.push(delay);
  });
  const attempts = new Map<string, number>();
  const result = await committer.commit(
    [item("stable", "a", 1n), item("flaky", "b", 2n)],
    "retry-1",
    async (entry) => {
      const count = (attempts.get(entry.instructionId) ?? 0) + 1;
      attempts.set(entry.instructionId, count);
      if (entry.instructionId === "flaky" && count < 3) {
        throw new Error(`temporary-${count}`);
      }
      return `r-${entry.instructionId}`;
    },
  );
  assert.equal(attempts.get("stable"), 1);
  assert.equal(attempts.get("flaky"), 3);
  assert.deepEqual(delays, [5, 10]);
  assert.deepEqual(
    result.map((outcome) => outcome.attempts),
    [1, 3],
  );
});

test("same-key concurrent callers join one running operation", async () => {
  const gate = deferred<string>();
  const committer = new OrderedBatchCommitter();
  const batch = [item("one", "a", 10n)];
  let writes = 0;
  const writer = async () => {
    writes += 1;
    return gate.promise;
  };
  const first = committer.commit(batch, "shared", writer);
  const second = committer.commit(batch, "shared", writer);
  const third = committer.commit(batch, "shared", writer);
  assert.equal(writes, 1);
  gate.resolve("receipt-one");

  const [left, middle, right] = await Promise.all([first, second, third]);
  assert.deepEqual(left, middle);
  assert.deepEqual(middle, right);
  assert.equal(writes, 1);
  assert.equal(committer.receiptCount(), 1);
});

test("different idempotency keys may settle concurrently", async () => {
  const gates = new Map([
    ["a", deferred<string>()],
    ["b", deferred<string>()],
  ]);
  const committer = new OrderedBatchCommitter();
  const started: string[] = [];
  const left = committer.commit([item("a", "x", 1n)], "left", async (entry) => {
    started.push(entry.instructionId);
    return gates.get(entry.instructionId)!.promise;
  });
  const right = committer.commit(
    [item("b", "y", 1n)],
    "right",
    async (entry) => {
      started.push(entry.instructionId);
      return gates.get(entry.instructionId)!.promise;
    },
  );
  assert.deepEqual(started.sort(), ["a", "b"]);
  gates.get("b")!.resolve("receipt-b");
  gates.get("a")!.resolve("receipt-a");
  assert.equal((await left)[0]!.receipt, "receipt-a");
  assert.equal((await right)[0]!.receipt, "receipt-b");
});

test("completed idempotent replay never calls the writer again", async () => {
  const committer = new OrderedBatchCommitter();
  const batch = [item("x", "a", 9n), item("y", "b", 8n)];
  let writes = 0;
  const first = await committer.commit(batch, "complete", async (entry) => {
    writes += 1;
    return `receipt-${entry.instructionId}`;
  });
  const second = await committer.commit(batch, "complete", async () => {
    writes += 1;
    return "unexpected";
  });
  assert.deepEqual(second, first);
  assert.equal(writes, 2);
  assert.equal(committer.receiptCount(), 2);
});

test("a later call retries only outcomes that exhausted their attempts", async () => {
  const committer = new OrderedBatchCommitter(2, 0, async () => undefined);
  let allowRecovery = false;
  const calls = new Map<string, number>();
  const writer = async (entry: SettlementItem) => {
    calls.set(entry.instructionId, (calls.get(entry.instructionId) ?? 0) + 1);
    if (entry.instructionId === "recover" && !allowRecovery)
      throw new Error("offline");
    return `receipt-${entry.instructionId}`;
  };
  const batch = [item("done", "a", 1n), item("recover", "b", 2n)];
  const first = await committer.commit(batch, "partial", writer);
  assert.deepEqual(
    first.map((outcome) => outcome.status),
    ["settled", "failed"],
  );
  assert.equal(calls.get("done"), 1);
  assert.equal(calls.get("recover"), 2);

  allowRecovery = true;
  const second = await committer.commit(batch, "partial", writer);
  assert.deepEqual(
    second.map((outcome) => outcome.status),
    ["settled", "settled"],
  );
  assert.equal(second[0]!.attempts, 0);
  assert.equal(calls.get("done"), 1);
  assert.equal(calls.get("recover"), 3);
  assert.equal(committer.receiptCount(), 2);
});

test("same key with changed content is rejected after completion", async () => {
  const committer = new OrderedBatchCommitter();
  await committer.commit([item("one", "a", 1n)], "contract", async () => "r1");
  await assert.rejects(
    committer.commit([item("one", "a", 2n)], "contract", async () => "r2"),
    /previously used/u,
  );
});

test("same key with changed content is rejected while running", async () => {
  const committer = new OrderedBatchCommitter();
  const gate = deferred<string>();
  const running = committer.commit(
    [item("one", "a", 1n)],
    "active",
    () => gate.promise,
  );
  await assert.rejects(
    committer.commit([item("two", "a", 1n)], "active", async () => "r2"),
    /already running/u,
  );
  gate.resolve("r1");
  await running;
});

test("writer receipt validation participates in retry policy", async () => {
  const committer = new OrderedBatchCommitter(3, 0, async () => undefined);
  let calls = 0;
  const result = await committer.commit(
    [item("x", "a", 1n)],
    "receipt",
    async () => {
      calls += 1;
      return calls < 3 ? "   " : " canonical ";
    },
  );
  assert.equal(calls, 3);
  assert.equal(result[0]!.receipt, "canonical");
});

test("empty batches are idempotent and frozen", async () => {
  const committer = new OrderedBatchCommitter();
  let calls = 0;
  const first = await committer.commit([], "empty", async () => {
    calls += 1;
    return "never";
  });
  const second = await committer.commit([], "empty", async () => "never");
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(calls, 0);
});

test("maximum parallelism bounds concurrent writer calls", async () => {
  const committer = new OrderedBatchCommitter(1, 0, async () => undefined, 3);
  const batch = Array.from({ length: 18 }, (_, index) =>
    item(`i-${index}`, `a-${index}`, BigInt(index + 1)),
  );
  let active = 0;
  let maximumActive = 0;
  const result = await committer.commit(batch, "bounded", async (entry) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return `r-${entry.instructionId}`;
  });
  assert.equal(result.length, 18);
  assert.equal(maximumActive, 3);
});

test("inspect and forget expose only completed operations", async () => {
  const committer = new OrderedBatchCommitter();
  const gate = deferred<string>();
  const running = committer.commit(
    [item("x", "a", 1n)],
    "inspect",
    () => gate.promise,
  );
  assert.equal(committer.inspect("inspect"), undefined);
  assert.equal(committer.forget("inspect"), false);
  gate.resolve("rx");
  const completed = await running;
  assert.deepEqual(committer.inspect(" inspect "), completed);
  assert.equal(committer.forget("inspect"), true);
  assert.equal(committer.inspect("inspect"), undefined);
  assert.equal(committer.receiptCount(), 1);
});

test("input validation occurs before any settlement write", async () => {
  const committer = new OrderedBatchCommitter();
  let writes = 0;
  const writer = async () => {
    writes += 1;
    return "r";
  };
  await assert.rejects(
    committer.commit([item("", "a", 1n)], "key", writer),
    /instructionId/u,
  );
  await assert.rejects(
    committer.commit([item("x", "", 1n)], "key", writer),
    /accountId/u,
  );
  await assert.rejects(
    committer.commit([item("x", "a", 0n)], "key", writer),
    /zero/u,
  );
  await assert.rejects(
    committer.commit([item("x", "a", 1n, "EU")], "key", writer),
    /currency/u,
  );
  await assert.rejects(
    committer.commit(
      [item("same", "a", 1n), item("same", "b", 2n)],
      "key",
      writer,
    ),
    /duplicate instructionId/u,
  );
  await assert.rejects(committer.commit([], "", writer), /idempotency key/u);
  assert.equal(writes, 0);
});

test("large deterministic batches preserve every receipt association", async () => {
  const committer = new OrderedBatchCommitter(2, 0, async () => undefined, 7);
  const batch = Array.from({ length: 75 }, (_, index) =>
    item(
      `instruction-${index}`,
      `account-${index % 9}`,
      BigInt(index + 1),
      index % 2 ? "USD" : "EUR",
    ),
  );
  const outcomes = await committer.commit(
    batch,
    "property-batch",
    async (entry) => `receipt:${entry.instructionId}:${entry.accountId}`,
  );
  assert.equal(outcomes.length, batch.length);
  assert.equal(
    new Set(outcomes.map((outcome) => outcome.receipt)).size,
    batch.length,
  );
  for (let index = 0; index < batch.length; index += 1) {
    assert.equal(outcomes[index]!.instructionId, batch[index]!.instructionId);
    assert.equal(
      outcomes[index]!.receipt,
      `receipt:${batch[index]!.instructionId}:${batch[index]!.accountId}`,
    );
  }
});
