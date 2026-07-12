import assert from "node:assert/strict";
import test from "node:test";
import { AuditNameCodec } from "../src/audit-name-codec.js";
import { CutoffCalendar } from "../src/cutoff-calendar.js";
import { LedgerJournal } from "../src/ledger-journal.js";
import { MarketMemo } from "../src/market-memo.js";
import { NettingPlanner } from "../src/netting-planner.js";
import { OrderedBatchCommitter } from "../src/ordered-batch-committer.js";
import { OrderedMessagePump } from "../src/ordered-message-pump.js";
import { QuotedFeeTable } from "../src/quoted-fee-table.js";
import { ReceiptReconciler } from "../src/receipt-reconciler.js";
import { RouteCodeParser } from "../src/route-code-parser.js";
import { SettlementTelemetry } from "../src/settlement-telemetry.js";

test("settled batch receipts form a recoverable ledger chain", async () => {
  const committer = new OrderedBatchCommitter(2, 0, async () => undefined);
  const journal = new LedgerJournal();
  const items = [
    { instructionId: "i-1", accountId: "a", amountMinor: 10n, currency: "EUR" },
    { instructionId: "i-2", accountId: "b", amountMinor: 20n, currency: "USD" },
    { instructionId: "i-3", accountId: "c", amountMinor: 30n, currency: "GBP" },
  ];
  const outcomes = await committer.commit(
    items,
    "daily-batch",
    async (entry) => `receipt-${entry.instructionId}`,
  );
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]!;
    journal.persist(
      "receipts",
      index,
      new TextEncoder().encode(outcome.receipt!),
    );
  }
  const recovered = journal.recover("receipts");
  assert.deepEqual(
    recovered.map((frame) => new TextDecoder().decode(frame.payload)),
    ["receipt-i-1", "receipt-i-2", "receipt-i-3"],
  );
  assert.equal(committer.receiptCount(), recovered.length);
});

test("netting instructions become fee-bearing settlement items", async () => {
  const planner = new NettingPlanner(true);
  const fees = new QuotedFeeTable();
  const committer = new OrderedBatchCommitter();
  const instructions = planner.plan([
    { account: "debtor", currency: "EUR", amountMinor: -100_000n, priority: 0 },
    {
      account: "creditor",
      currency: "EUR",
      amountMinor: 100_000n,
      priority: 0,
    },
  ]);
  const tiers = [
    {
      minimumMinor: 0n,
      maximumMinor: 9_999n,
      basisPoints: 100,
      fixedMinor: 0n,
    },
    { minimumMinor: 10_000n, basisPoints: 20, fixedMinor: 5n },
  ];
  const settlementItems = instructions.map((instruction, index) => ({
    instructionId: `net-${index}`,
    accountId: instruction.from,
    amountMinor:
      instruction.amountMinor + fees.lookup(instruction.amountMinor, tiers),
    currency: instruction.currency,
  }));
  const outcomes = await committer.commit(
    settlementItems,
    "netting",
    async (entry) => `${entry.instructionId}:${entry.amountMinor}`,
  );
  assert.equal(instructions[0]!.amountMinor, 100_000n);
  assert.equal(settlementItems[0]!.amountMinor, 100_205n);
  assert.equal(outcomes[0]!.receipt, "net-0:100205");
});

test("receipt reconciliation confirms committed outcomes against an archive", async () => {
  const committer = new OrderedBatchCommitter();
  const reconciler = new ReceiptReconciler();
  const settled = await committer.commit(
    [
      { instructionId: "x", accountId: "a", amountMinor: 50n, currency: "EUR" },
      { instructionId: "y", accountId: "b", amountMinor: 75n, currency: "USD" },
    ],
    "reconcile",
    async (entry) => `receipt-${entry.instructionId}`,
  );
  const left = settled.map((outcome, index) => ({
    id: outcome.receipt!,
    instructionId: outcome.instructionId,
    amountMinor: index === 0 ? 50n : 75n,
    currency: index === 0 ? "EUR" : "USD",
    timestamp: 1_000 + index,
  }));
  const right = left
    .map((entry) => ({ ...entry, id: `archive-${entry.id}` }))
    .reverse();
  const matches = reconciler.match(left, right);
  assert.equal(matches.length, 2);
  assert.equal(
    matches.every((match) => match.score === 22),
    true,
  );
});

test("trade message dispatch records settlement telemetry only after processing", async () => {
  const pump = new OrderedMessagePump();
  const telemetry = new SettlementTelemetry();
  let clock = 100;
  await pump.dispatch(
    {
      id: "event-1",
      account: "acct",
      sequence: 1,
      payload: new Uint8Array([1]),
    },
    async () => {
      clock += 20;
      telemetry.observe({
        operation: "event.settle",
        latencyMs: 20,
        retries: 0,
        succeeded: true,
        timestamp: clock,
      });
    },
    async () => {
      clock += 1;
    },
  );
  assert.deepEqual(telemetry.latencyBands("event.settle"), [20, 20, 20, 20]);
  assert.equal(clock, 121);
});

test("failed dispatch is absent from success telemetry and broker ack", async () => {
  const pump = new OrderedMessagePump();
  const telemetry = new SettlementTelemetry();
  let acknowledged = false;
  await assert.rejects(
    pump.dispatch(
      { id: "bad", account: "acct", sequence: 1, payload: new Uint8Array() },
      async () => {
        telemetry.observe({
          operation: "event.settle",
          latencyMs: 5,
          retries: 1,
          succeeded: false,
          timestamp: 1,
        });
        throw new Error("domain failure");
      },
      async () => {
        acknowledged = true;
      },
    ),
    /domain failure/u,
  );
  assert.equal(acknowledged, false);
  assert.equal(telemetry.retryBudget("event.settle", 1).consumed, 1);
});

test("route, cutoff and audit name compose a storage partition", () => {
  const parser = new RouteCodeParser();
  const calendar = new CutoffCalendar();
  const codec = new AuditNameCodec();
  const route = parser.parse("LON->FRA->NYC?urgent");
  const cutoff = calendar.roll(Date.parse("2026-07-13T10:00:00Z"), {
    center: route.source,
    cutoffHourUtc: 16,
    holidays: new Set(),
  });
  const partition = codec.encode([
    route.source,
    route.destination,
    new Date(cutoff).toISOString().slice(0, 10),
    [...route.flags].join(","),
  ]);
  assert.equal(partition, "LON/NYC/2026-07-13/urgent");
});

test("market memo caches route parsing without pretending to coalesce", async () => {
  const parser = new RouteCodeParser();
  const memo = new MarketMemo();
  let parses = 0;
  const first = await memo.read("ROUTE/LON-NYC", async () => {
    parses += 1;
    return parser.parse("LON->NYC");
  });
  const second = await memo.read("route/lon-nyc", async () => {
    parses += 1;
    return parser.parse("LON->FRA->NYC");
  });
  assert.equal(parses, 1);
  assert.equal(first, second);
  assert.deepEqual(second.hops, []);
});

test("partial settlement retry journals each receipt once", async () => {
  const committer = new OrderedBatchCommitter(1, 0, async () => undefined);
  const journal = new LedgerJournal();
  let recover = false;
  const batch = [
    {
      instructionId: "stable",
      accountId: "a",
      amountMinor: 1n,
      currency: "EUR",
    },
    {
      instructionId: "flaky",
      accountId: "b",
      amountMinor: 2n,
      currency: "EUR",
    },
  ];
  const writer = async (entry: (typeof batch)[number]) => {
    if (entry.instructionId === "flaky" && !recover) throw new Error("offline");
    return `r-${entry.instructionId}`;
  };
  const first = await committer.commit(batch, "partial-flow", writer);
  for (const outcome of first) {
    if (outcome.receipt !== undefined) {
      journal.persist(
        "partial",
        journal.recover("partial").length,
        new TextEncoder().encode(outcome.receipt),
      );
    }
  }
  recover = true;
  const second = await committer.commit(batch, "partial-flow", writer);
  const known = new Set(
    journal
      .recover("partial")
      .map((frame) => new TextDecoder().decode(frame.payload)),
  );
  for (const outcome of second) {
    if (outcome.receipt !== undefined && !known.has(outcome.receipt)) {
      journal.persist(
        "partial",
        journal.recover("partial").length,
        new TextEncoder().encode(outcome.receipt),
      );
      known.add(outcome.receipt);
    }
  }
  assert.deepEqual([...known].sort(), ["r-flaky", "r-stable"]);
  assert.equal(journal.recover("partial").length, 2);
  assert.equal(committer.receiptCount(), 2);
});

test("multi-currency end-to-end scenario preserves financial balance", async () => {
  const planner = new NettingPlanner(true);
  const committer = new OrderedBatchCommitter();
  const positions = [
    { account: "a", currency: "EUR", amountMinor: -100n, priority: 1 },
    { account: "b", currency: "EUR", amountMinor: 60n, priority: 0 },
    { account: "c", currency: "EUR", amountMinor: 40n, priority: 1 },
    { account: "a", currency: "USD", amountMinor: 30n, priority: 0 },
    { account: "d", currency: "USD", amountMinor: -30n, priority: 0 },
  ];
  const instructions = planner.plan(positions);
  const residual = planner.allocateResidual(instructions);
  const items = instructions.map((instruction, index) => ({
    instructionId: `multi-${index}`,
    accountId: instruction.from,
    amountMinor: instruction.amountMinor,
    currency: instruction.currency,
  }));
  const outcomes = await committer.commit(
    items,
    "multi",
    async (entry) => `ok-${entry.instructionId}`,
  );
  assert.equal(
    outcomes.every((outcome) => outcome.status === "settled"),
    true,
  );
  assert.equal(
    Object.values(residual).reduce((sum, amount) => sum + amount, 0n),
    0n,
  );
  assert.equal(outcomes.length, instructions.length);
});

test("independent daily keys produce independent receipt namespaces", async () => {
  const committer = new OrderedBatchCommitter();
  const batch = [
    { instructionId: "same", accountId: "a", amountMinor: 1n, currency: "EUR" },
  ];
  const monday = await committer.commit(
    batch,
    "2026-07-13",
    async () => "monday-receipt",
  );
  const tuesday = await committer.commit(
    batch,
    "2026-07-14",
    async () => "tuesday-receipt",
  );
  assert.equal(monday[0]!.receipt, "monday-receipt");
  assert.equal(tuesday[0]!.receipt, "tuesday-receipt");
  assert.equal(committer.receiptCount(), 2);
});

test("all platform components tolerate empty read-only views", () => {
  assert.deepEqual(new NettingPlanner().plan([]), []);
  assert.deepEqual(new ReceiptReconciler().match([], []), []);
  assert.deepEqual(
    new SettlementTelemetry().latencyBands("missing"),
    [0, 0, 0, 0],
  );
  assert.deepEqual([...new MarketMemo().groupKeys()], []);
  assert.deepEqual(new LedgerJournal().recover("empty"), []);
});
