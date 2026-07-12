import assert from "node:assert/strict";
import test from "node:test";
import {
  SettlementScenarioBook,
  type ScenarioDefinition,
  type ScenarioExecutionRecord,
} from "../src/settlement-scenario-book.js";

const balancedDefinition = (): ScenarioDefinition => ({
  scenarioId: "daily",
  positions: [
    {
      account: "debtor-a",
      currency: "EUR",
      amountMinor: -70_000n,
      priority: 0,
    },
    {
      account: "debtor-b",
      currency: "EUR",
      amountMinor: -30_000n,
      priority: 1,
    },
    {
      account: "creditor-a",
      currency: "EUR",
      amountMinor: 60_000n,
      priority: 0,
    },
    {
      account: "creditor-b",
      currency: "EUR",
      amountMinor: 40_000n,
      priority: 1,
    },
  ],
  feeRules: [
    {
      currency: "EUR",
      basisPoints: 10,
      fixedMinor: 2n,
      minimumFeeMinor: 5n,
      maximumFeeMinor: 100n,
    },
  ],
  accountRoutes: {
    "debtor-a": "LON->FRA",
    "debtor-b": "LON->AMS->FRA",
  },
});

test("scenario compilation creates deterministic netting instructions", () => {
  const book = new SettlementScenarioBook();
  const compiled = book.compile(balancedDefinition());
  assert.equal(compiled.scenarioId, "daily");
  assert.equal(compiled.instructions.length, 3);
  assert.equal(compiled.accountCount, 4);
  assert.equal(compiled.grossPrincipalMinor, 100_000n);
  assert.equal(compiled.unmatchedByCurrency.EUR, 0n);
  assert.deepEqual(compiled.currencies, ["EUR"]);
  assert.match(compiled.fingerprint, /^[0-9a-f]{8}$/u);
});

test("compiled instruction order follows priority then currency", () => {
  const book = new SettlementScenarioBook();
  const compiled = book.compile({
    scenarioId: "priority",
    positions: [
      {
        account: "low-debtor",
        currency: "USD",
        amountMinor: -10n,
        priority: 9,
      },
      {
        account: "low-creditor",
        currency: "USD",
        amountMinor: 10n,
        priority: 9,
      },
      {
        account: "high-debtor",
        currency: "EUR",
        amountMinor: -20n,
        priority: 0,
      },
      {
        account: "high-creditor",
        currency: "EUR",
        amountMinor: 20n,
        priority: 0,
      },
    ],
    feeRules: [],
    accountRoutes: {},
  });
  assert.deepEqual(
    compiled.instructions.map((entry) => entry.currency),
    ["EUR", "USD"],
  );
  assert.deepEqual(
    compiled.instructions.map((entry) => entry.priority),
    [0, 9],
  );
});

test("fee calculation respects minimum and maximum caps", () => {
  const book = new SettlementScenarioBook();
  const low = book.compile({
    scenarioId: "fee-min",
    positions: [
      { account: "a", currency: "EUR", amountMinor: -10n, priority: 0 },
      { account: "b", currency: "EUR", amountMinor: 10n, priority: 0 },
    ],
    feeRules: [
      { currency: "EUR", basisPoints: 1, fixedMinor: 0n, minimumFeeMinor: 5n },
    ],
    accountRoutes: {},
  });
  assert.equal(low.instructions[0]!.feeMinor, 5n);

  const high = book.compile({
    scenarioId: "fee-max",
    positions: [
      { account: "a", currency: "EUR", amountMinor: -1_000_000n, priority: 0 },
      { account: "b", currency: "EUR", amountMinor: 1_000_000n, priority: 0 },
    ],
    feeRules: [
      {
        currency: "EUR",
        basisPoints: 1_000,
        fixedMinor: 100n,
        minimumFeeMinor: 0n,
        maximumFeeMinor: 50n,
      },
    ],
    accountRoutes: {},
  });
  assert.equal(high.instructions[0]!.feeMinor, 50n);
});

test("routes are attached from debtor or creditor configuration", () => {
  const book = new SettlementScenarioBook();
  const compiled = book.compile(balancedDefinition());
  assert.deepEqual(compiled.instructions[0]!.route, ["LON", "FRA"]);
  assert.equal(
    compiled.instructions.some((entry) => entry.route.includes("AMS")),
    true,
  );
});

test("compilation combines repeated account positions", () => {
  const book = new SettlementScenarioBook();
  const compiled = book.compile({
    scenarioId: "aggregate",
    positions: [
      { account: "a", currency: "GBP", amountMinor: -30n, priority: 2 },
      { account: "a", currency: "GBP", amountMinor: 10n, priority: 1 },
      { account: "b", currency: "GBP", amountMinor: 20n, priority: 0 },
    ],
    feeRules: [],
    accountRoutes: {},
  });
  assert.equal(compiled.instructions.length, 1);
  assert.equal(compiled.instructions[0]!.principalMinor, 20n);
});

test("imbalanced books expose rather than hide unmatched currency", () => {
  const book = new SettlementScenarioBook();
  const compiled = book.compile({
    scenarioId: "unmatched",
    positions: [
      { account: "a", currency: "JPY", amountMinor: -100n, priority: 0 },
      { account: "b", currency: "JPY", amountMinor: 70n, priority: 0 },
    ],
    feeRules: [],
    accountRoutes: {},
  });
  assert.equal(compiled.grossPrincipalMinor, 70n);
  assert.equal(compiled.unmatchedByCurrency.JPY, -30n);
});

test("execute returns stable slots despite out-of-order completion", async () => {
  let now = 0;
  const book = new SettlementScenarioBook(2, () => now++);
  const compiled = book.compile(balancedDefinition());
  const completion: string[] = [];
  const records = await book.execute(compiled, async (instruction) => {
    await new Promise((resolve) =>
      setTimeout(resolve, instruction.index === 0 ? 4 : 1),
    );
    completion.push(instruction.instructionId);
    return `receipt-${instruction.index}`;
  });
  assert.notDeepEqual(
    completion,
    records.map((record) => record.instructionId),
  );
  assert.deepEqual(
    records.map((record) => record.index),
    [0, 1, 2],
  );
  assert.equal(
    records.every((record) => record.status === "settled"),
    true,
  );
});

test("execute retries individual writer failures", async () => {
  const book = new SettlementScenarioBook(3);
  const compiled = book.compile(balancedDefinition());
  const calls = new Map<string, number>();
  const records = await book.execute(compiled, async (instruction) => {
    const count = (calls.get(instruction.instructionId) ?? 0) + 1;
    calls.set(instruction.instructionId, count);
    if (instruction.index === 1 && count < 3) throw new Error("temporary");
    return `receipt-${instruction.index}`;
  });
  assert.deepEqual(
    records.map((record) => record.attempts),
    [1, 3, 1],
  );
  assert.equal(
    records.every((record) => record.status === "settled"),
    true,
  );
});

test("execute records exhausted failures without rejecting the batch", async () => {
  const book = new SettlementScenarioBook(2);
  const compiled = book.compile(balancedDefinition());
  const records = await book.execute(compiled, async (instruction) => {
    if (instruction.index === 0) throw new Error("permanent");
    return `receipt-${instruction.index}`;
  });
  assert.equal(records[0]!.status, "failed");
  assert.equal(records[0]!.attempts, 2);
  assert.equal(records[0]!.error, "permanent");
  assert.equal(
    records.slice(1).every((record) => record.status === "settled"),
    true,
  );
});

test("blocked accounts never reach the writer", async () => {
  const book = new SettlementScenarioBook();
  const compiled = book.compile(balancedDefinition());
  let calls = 0;
  const records = await book.execute(
    compiled,
    async (instruction) => {
      calls += 1;
      return `receipt-${instruction.index}`;
    },
    2,
    new Set(["debtor-a"]),
  );
  const blocked = records.filter((record) => record.status === "blocked");
  assert.ok(blocked.length >= 1);
  assert.equal(calls, records.length - blocked.length);
  assert.equal(
    blocked.every((record) => record.attempts === 0),
    true,
  );
});

test("receipt reuse across different instructions becomes a failure", async () => {
  const book = new SettlementScenarioBook(1);
  const compiled = book.compile(balancedDefinition());
  const records = await book.execute(compiled, async () => "same-receipt", 1);
  assert.equal(records[0]!.status, "settled");
  assert.equal(
    records.slice(1).every((record) => record.status === "failed"),
    true,
  );
  assert.equal(records[1]!.error?.includes("reused"), true);
});

test("execution concurrency obeys its configured bound", async () => {
  const book = new SettlementScenarioBook();
  const compiled = book.compile(balancedDefinition());
  let active = 0;
  let maximum = 0;
  await book.execute(
    compiled,
    async (instruction) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return `r-${instruction.index}`;
    },
    2,
  );
  assert.equal(maximum, 2);
});

test("summary aggregates money, retries, latency and errors", () => {
  const book = new SettlementScenarioBook();
  const records: ScenarioExecutionRecord[] = [
    {
      index: 0,
      instructionId: "a",
      currency: "EUR",
      from: "debtor",
      to: "creditor",
      principalMinor: 100n,
      feeMinor: 2n,
      status: "settled",
      attempts: 2,
      elapsedMs: 10,
      receipt: "r-a",
    },
    {
      index: 1,
      instructionId: "b",
      currency: "USD",
      from: "debtor",
      to: "other",
      principalMinor: 50n,
      feeMinor: 1n,
      status: "failed",
      attempts: 3,
      elapsedMs: 30,
      error: "offline",
    },
    {
      index: 2,
      instructionId: "c",
      currency: "EUR",
      from: "blocked",
      to: "creditor",
      principalMinor: 25n,
      feeMinor: 0n,
      status: "blocked",
      attempts: 0,
      elapsedMs: 0,
      error: "account blocked",
    },
  ];
  const summary = book.summarize(records);
  assert.equal(summary.instructionCount, 3);
  assert.equal(summary.settled, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.attempts, 5);
  assert.equal(summary.settledPrincipalByCurrency.EUR, 100n);
  assert.equal(summary.feeByCurrency.EUR, 2n);
  assert.equal(summary.debitByAccount.debtor, 102n);
  assert.equal(summary.creditByAccount.creditor, 100n);
  assert.equal(summary.errorCounts.offline, 1);
  assert.equal(summary.p50LatencyMs, 10);
});

test("summary identifies duplicate receipt identifiers", () => {
  const book = new SettlementScenarioBook();
  const base = {
    currency: "EUR",
    from: "a",
    to: "b",
    principalMinor: 1n,
    feeMinor: 0n,
    status: "settled" as const,
    attempts: 1,
    elapsedMs: 1,
    receipt: "duplicate",
  };
  const summary = book.summarize([
    { ...base, index: 0, instructionId: "one" },
    { ...base, index: 1, instructionId: "two" },
  ]);
  assert.deepEqual(summary.duplicateReceipts, ["duplicate"]);
  assert.equal(summary.receipts, 1);
});

test("scenario validation covers identities, routes and fee rules", () => {
  const book = new SettlementScenarioBook();
  assert.throws(
    () => book.compile({ ...balancedDefinition(), scenarioId: "bad id" }),
    /scenarioId/u,
  );
  assert.throws(
    () =>
      book.compile({
        ...balancedDefinition(),
        accountRoutes: { debtor: "LON" },
      }),
    /invalid route/u,
  );
  assert.throws(
    () =>
      book.compile({
        ...balancedDefinition(),
        feeRules: [
          ...balancedDefinition().feeRules,
          {
            currency: "EUR",
            basisPoints: 1,
            fixedMinor: 0n,
            minimumFeeMinor: 0n,
          },
        ],
      }),
    /duplicate fee rule/u,
  );
  assert.throws(
    () =>
      book.compile({
        ...balancedDefinition(),
        positions: [
          { account: "", currency: "EUR", amountMinor: 1n, priority: 0 },
        ],
      }),
    /invalid account/u,
  );
});

test("empty scenario compilation and execution stay well-defined", async () => {
  const book = new SettlementScenarioBook();
  const compiled = book.compile({
    scenarioId: "empty",
    positions: [],
    feeRules: [],
    accountRoutes: {},
  });
  assert.deepEqual(compiled.instructions, []);
  assert.equal(compiled.grossPrincipalMinor, 0n);
  assert.deepEqual(await book.execute(compiled, async () => "never"), []);
  assert.deepEqual(book.summarize([]), {
    instructionCount: 0,
    settled: 0,
    failed: 0,
    blocked: 0,
    receipts: 0,
    duplicateReceipts: [],
    attempts: 0,
    retryHistogram: {},
    settledPrincipalByCurrency: {},
    feeByCurrency: {},
    debitByAccount: {},
    creditByAccount: {},
    errorCounts: {},
    minimumLatencyMs: 0,
    maximumLatencyMs: 0,
    averageLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
  });
});

test("generated balanced scenarios conserve gross principal", () => {
  const book = new SettlementScenarioBook();
  for (let size = 1; size <= 25; size += 1) {
    const positions = [];
    let expected = 0n;
    for (let index = 1; index <= size; index += 1) {
      const amount = BigInt(index * 100);
      expected += amount;
      positions.push({
        account: `debtor-${index}`,
        currency: "EUR",
        amountMinor: -amount,
        priority: index,
      });
      positions.push({
        account: `creditor-${index}`,
        currency: "EUR",
        amountMinor: amount,
        priority: index,
      });
    }
    const compiled = book.compile({
      scenarioId: `generated-${size}`,
      positions,
      feeRules: [],
      accountRoutes: {},
    });
    assert.equal(compiled.grossPrincipalMinor, expected);
    assert.equal(compiled.unmatchedByCurrency.EUR, 0n);
  }
});
