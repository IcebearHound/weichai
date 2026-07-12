import assert from "node:assert/strict";
import test from "node:test";
import {
  ForensicReplay,
  OperationsWorkbench,
  type IncidentReplayInput,
  type OperationsPlanningInput,
} from "../src/index.js";
import {
  EUR,
  GBP,
  JPY,
  USD,
  audit,
  dependencyFixture,
  extentFixture,
  liquidMarket,
  observationSeries,
  packetFixture,
  pair,
  retry,
  settlementBook,
  tradeStream,
} from "./scenario-fixtures.js";

const workbench = (): OperationsWorkbench => new OperationsWorkbench(3, 512, 18, 2, 500);

const planningInput = (now = 5_000): OperationsPlanningInput => ({
  pairs: [
    pair(USD, EUR),
    pair(EUR, USD),
    pair(GBP, USD),
    pair(USD, GBP),
    pair(USD, JPY),
  ],
  quotes: liquidMarket,
  settlements: settlementBook,
  trades: tradeStream,
  audits: [
    ...settlementBook.map((intent, index) => audit(`settlement-audit-${index}`, intent.identity, intent.account, 3_000 + index)),
    ...tradeStream.map((signal, index) => audit(`trade-audit-${index}`, signal.messageId, signal.account, 3_100 + index, "trade")),
  ],
  providerEvents: [
    { channel: "north-feed", at: 1_000, outcome: "success", latencyMs: 12 },
    { channel: "east-feed", at: 1_010, outcome: "failure" },
    { channel: "east-feed", at: 1_020, outcome: "failure" },
    { channel: "alpine-feed", at: 1_030, outcome: "success", latencyMs: 20 },
    { channel: "tokyo-feed", at: 1_040, outcome: "success", latencyMs: 30 },
  ],
  retryTickets: [
    retry("retry-a", "acct-a", 4_000, 4, 3, 6_000),
    retry("retry-b", "acct-b", 4_100, 3, 2, 6_100),
    retry("retry-c", "acct-c", 4_200, 5, 4, 5_500),
    retry("retry-d", "acct-d", 6_000, 2, 1, 8_000),
  ],
  blockedDates: new Set<string>(),
  accountLimits: {
    "acct-a": 500_000,
    "acct-b": 500_000,
    "acct-c": 500_000,
    "acct-d": 500_000,
    "acct-e": 2_000_000,
    "acct-f": 100_000,
  },
  currencyLimits: {
    USD: 1_000_000,
    EUR: 500_000,
    GBP: 500_000,
    CHF: 500_000,
    JPY: 2_000_000,
  },
  accountShares: {
    "acct-a": 0.4,
    "acct-b": 0.4,
    "acct-c": 0.4,
    "acct-d": 0.2,
  },
  providerOrder: ["north-feed", "east-feed", "alpine-feed", "tokyo-feed"],
  now,
});

test("operations workbench produces bounded settlement waves", () => {
  const plan = workbench().buildPlan(planningInput());
  assert.ok(plan.acceptedSettlementWaves.length > 0);
  assert.ok(plan.acceptedSettlementWaves.every((wave) => wave.length <= 3));
  const planned = plan.acceptedSettlementWaves.flat();
  assert.equal(new Set(planned).size, planned.length);
  assert.ok(planned.includes("s-001"));
});

test("operations workbench preserves retry budget", () => {
  const plan = workbench().buildPlan(planningInput());
  assert.ok(plan.retrySpend <= 18);
  assert.ok(plan.retryDispatch.length >= 1);
  assert.equal(new Set(plan.retryDispatch).size, plan.retryDispatch.length);
});

test("operations workbench partitions every audit identity", () => {
  const input = planningInput();
  const plan = workbench().buildPlan(input);
  const identities = plan.auditPartitions.flatMap((partition) => partition.identities);
  assert.equal(new Set(identities).size, input.audits.length);
  assert.ok(plan.auditPartitions.every((partition) => /^[0-9a-f]{8}$/.test(partition.root)));
  assert.deepEqual(plan.auditPartitions.map((partition) => partition.index), [...plan.auditPartitions.keys()]);
});

test("operations workbench exposes an open-provider recovery probe", () => {
  const plan = workbench().buildPlan(planningInput());
  const east = plan.providerProbes.find((probe) => probe.provider === "east-feed")!;
  assert.equal(east.reason, "recovery");
  assert.ok(east.earliestAt >= 1_520);
  assert.ok(east.deadlineAt > east.earliestAt);
});

test("operations workbench funding reports currency shortfall", () => {
  const funding = workbench().rebalanceLiquidity(settlementBook, { USD: 100_000 }, new Map());
  const usd = funding.find((line) => line.currency === USD)!;
  assert.ok(usd.grossRequired >= usd.grossAvailable);
  assert.ok(usd.netShortfall > 0);
  assert.ok(usd.urgentIntents.includes("s-001"));
});

test("operations workbench rejects settlements on a blocked date", () => {
  const input = planningInput();
  const blocked = {
    ...input,
    blockedDates: new Set(["2026-07-13"]),
  };
  const plan = workbench().buildPlan(blocked);
  assert.equal(plan.deferredSettlements.get("s-001"), "blocked value date");
  assert.equal(plan.deferredSettlements.get("s-004"), "blocked value date");
  assert.equal(plan.acceptedSettlementWaves.flat().includes("s-001"), false);
});

test("operations workbench orders risk by descending score", () => {
  const plan = workbench().buildPlan(planningInput());
  const risks = [...plan.accountRisk.values()];
  for (let index = 1; index < risks.length; index += 1) assert.ok(risks[index - 1] >= risks[index]);
  assert.ok(plan.accountRisk.has("acct-a"));
  assert.ok(plan.accountRisk.has("acct-c"));
});

test("operations workbench validates constructor policies", () => {
  assert.throws(() => new OperationsWorkbench(0, 512, 10, 2, 500), /Parallelism/);
  assert.throws(() => new OperationsWorkbench(1, 128, 10, 2, 500), /auditTargetBytes/);
  assert.throws(() => new OperationsWorkbench(1, 512, -1, 2, 500), /retryBudget/);
  assert.throws(() => new OperationsWorkbench(1, 512, 1, 0, 500), /failureLimit/);
  assert.throws(() => new OperationsWorkbench(1, 512, 1, 1, 0), /recoveryDelayMs/);
});

test("operations workbench rejects a non-finite planning clock", () => {
  assert.throws(() => workbench().buildPlan(planningInput(Number.NaN)), /planning clock/);
});

const incidentInput = (): IncidentReplayInput => ({
  incidentId: "incident-20260712-a",
  boundary: 1_000,
  observations: observationSeries,
  signals: tradeStream,
  checkpoints: {
    "acct-a": 0,
    "acct-b": 0,
    "acct-c": 0,
    "acct-d": 0,
    "acct-e": 0,
  },
  dependencies: dependencyFixture,
  dependencyRoots: ["ingest"],
  dependencyTerminals: new Set(["publish"]),
  frames: packetFixture,
  expectedParity: 0,
  extents: extentFixture,
  segmentCapacities: {
    "old-a": 512,
    "old-b": 512,
    "old-c": 512,
    "compact-a": 768,
    "compact-b": 768,
  },
});

test("forensic replay builds a chronological combined timeline", () => {
  const report = new ForensicReplay().replay(incidentInput());
  assert.ok(report.timeline.length > observationSeries.length + tradeStream.length);
  for (let index = 1; index < report.timeline.length; index += 1) {
    assert.ok(report.timeline[index - 1].at <= report.timeline[index].at);
  }
  assert.ok(report.timeline.some((entry) => entry.kind === "trade-signal"));
  assert.ok(report.timeline.some((entry) => entry.kind === "observation"));
});

test("forensic replay retains account-level correlations", () => {
  const report = new ForensicReplay().replay(incidentInput());
  const accountA = report.correlations.find((entry) => entry.account === "acct-a")!;
  assert.equal(accountA.signalCount, 3);
  assert.equal(accountA.observationCount, 4);
  assert.deepEqual(accountA.missingSignals, [3]);
  assert.ok(accountA.changedSensors.includes("queue-depth"));
  assert.equal(accountA.blockedObservations, 1);
});

test("forensic replay exposes dependency containment evidence", () => {
  const report = new ForensicReplay().replay(incidentInput());
  assert.ok(report.dependencyCut.length >= 1);
  assert.deepEqual(report.dependencyCycles, []);
  assert.ok(report.narrative.some((line) => line.includes("Dependency containment")));
});

test("forensic replay verifies packets and plans storage movement", () => {
  const report = new ForensicReplay().replay(incidentInput());
  assert.equal(report.packetComplete, true);
  assert.deepEqual(report.packetMissing, []);
  assert.match(report.packetDigest, /^[0-9a-f]{16}$/);
  assert.ok(report.migrationWaves.length >= 1);
  assert.equal(report.storageConflicts.length, 0);
});

test("forensic replay explains missing packet data", () => {
  const input = incidentInput();
  const report = new ForensicReplay().replay({
    ...input,
    frames: input.frames.filter((entry) => entry.ordinal !== 1 && entry.ordinal !== 2),
  });
  assert.equal(report.packetComplete, false);
  assert.deepEqual(report.packetMissing, [1, 2]);
  assert.ok(report.narrative.some((line) => line.includes("Packet reconstruction")));
});

test("forensic replay reports malformed dependency references", () => {
  const input = incidentInput();
  const report = new ForensicReplay().replay({
    ...input,
    dependencies: [
      ...input.dependencies,
      { id: "isolated", account: "x", cost: 1, prerequisites: ["absent"], labels: [] },
    ],
  });
  assert.ok(report.chronologyFindings.includes("missing-dependency:isolated:absent"));
  assert.ok(report.chronologyFindings.some((message) => message.startsWith("sequence-rewind:acct-a")) === false);
});

test("forensic replay rejects missing incident identity", () => {
  const input = incidentInput();
  assert.throws(() => new ForensicReplay().replay({ ...input, incidentId: " " }), /identity/);
  assert.throws(() => new ForensicReplay().replay({ ...input, boundary: Number.NaN }), /boundary/);
});

test("forensic account correlation sorts highest severity first", () => {
  const replay = new ForensicReplay();
  const correlations = replay.correlateAccounts(
    tradeStream,
    observationSeries,
    new Map([
      ["acct-a", [3, 5, 6]],
      ["acct-b", []],
    ]),
    ["queue-depth", "latency"],
  );
  assert.equal(correlations[0].account, "acct-a");
  assert.ok(correlations[0].estimatedSeverity >= correlations[1].estimatedSeverity);
});

test("forensic narrative remains within its configured width", () => {
  const report = new ForensicReplay().replay(incidentInput());
  assert.ok(report.narrative.length > 10);
  assert.ok(report.narrative.every((line) => [...line].length <= 100));
  assert.ok(report.narrative[0].includes("INCIDENT"));
});
