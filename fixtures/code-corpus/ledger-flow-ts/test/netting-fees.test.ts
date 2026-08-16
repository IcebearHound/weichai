/**
 * NettingPlanner(多边轧差)与 QuotedFeeTable(费用表)的单元测试。
 *
 * 前半覆盖轧差的确定性、同账户聚合、币种独立、失衡处理与残差守恒;
 * 后半覆盖费用分层查找、封顶、取整、层级边界与费率回归评估。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NettingPlanner, type NetPosition } from "../src/netting-planner.js";
import { QuotedFeeTable, type FeeTier } from "../src/quoted-fee-table.js";

const position = (
  account: string,
  currency: string,
  amountMinor: bigint,
  priority = 0,
): NetPosition => ({ account, currency, amountMinor, priority });

const standardTiers: FeeTier[] = [
  { minimumMinor: 0n, maximumMinor: 999n, basisPoints: 100, fixedMinor: 2n },
  {
    minimumMinor: 1_000n,
    maximumMinor: 9_999n,
    basisPoints: 50,
    fixedMinor: 5n,
  },
  { minimumMinor: 10_000n, basisPoints: 25, fixedMinor: 10n },
];

test("balanced positions collapse into deterministic transfers", () => {
  const planner = new NettingPlanner(true);
  // 优先级相同(此处为 1/2)时按账户名排序,输出必须完全确定。
  const instructions = planner.plan([
    position("debtor-b", "EUR", -40n, 2),
    position("creditor-a", "EUR", 70n, 1),
    position("debtor-a", "EUR", -60n, 1),
    position("creditor-b", "EUR", 30n, 2),
  ]);
  assert.deepEqual(instructions, [
    { from: "debtor-a", to: "creditor-a", currency: "EUR", amountMinor: 60n },
    { from: "debtor-b", to: "creditor-a", currency: "EUR", amountMinor: 10n },
    { from: "debtor-b", to: "creditor-b", currency: "EUR", amountMinor: 30n },
  ]);
});

test("same account positions are aggregated before matching", () => {
  const planner = new NettingPlanner(true);
  // 同账户多笔头寸先合并:净 -30 与对方 +30 配对为单笔 30 转账。
  const instructions = planner.plan([
    position("a", "USD", -50n),
    position("a", "USD", 20n),
    position("b", "USD", 30n),
  ]);
  assert.deepEqual(instructions, [
    { from: "a", to: "b", currency: "USD", amountMinor: 30n },
  ]);
});

test("currencies are netted independently", () => {
  const planner = new NettingPlanner(true);
  const instructions = planner.plan([
    position("a", "EUR", -10n),
    position("b", "EUR", 10n),
    position("a", "USD", 20n),
    position("c", "USD", -20n),
  ]);
  assert.deepEqual(
    instructions.map((entry) => entry.currency),
    ["EUR", "USD"],
  );
  assert.equal(instructions[0]!.from, "a");
  assert.equal(instructions[1]!.from, "c");
});

test("strict planner rejects a currency imbalance", () => {
  const planner = new NettingPlanner(true);
  assert.throws(
    () => planner.plan([position("a", "EUR", -10n), position("b", "EUR", 9n)]),
    /not balanced/u,
  );
});

test("non-strict planner settles the matched portion of an imbalance", () => {
  const planner = new NettingPlanner(false);
  const instructions = planner.plan([
    position("a", "EUR", -10n),
    position("b", "EUR", 6n),
  ]);
  assert.equal(instructions[0]!.amountMinor, 6n);
});

test("buildGroups separates currency and debit direction", () => {
  const planner = new NettingPlanner();
  const groups = planner.buildGroups([
    position("z", "EUR", -1n, 2),
    position("a", "EUR", -2n, 1),
    position("b", "EUR", 3n, 0),
    position("c", "USD", 0n, 0),
  ]);
  assert.deepEqual([...groups.keys()], ["EUR:credit", "EUR:debit", "USD:zero"]);
  assert.deepEqual(
    groups.get("EUR:debit")?.map((entry) => entry.account),
    ["a", "z"],
  );
});

test("allocated residuals balance to zero within each currency", () => {
  const planner = new NettingPlanner();
  // 残差表中借贷符号相反,全部残差之和为 0(资金守恒)。
  const instructions = [
    { from: "a", to: "b", currency: "EUR", amountMinor: 40n },
    { from: "a", to: "c", currency: "EUR", amountMinor: 10n },
    { from: "d", to: "a", currency: "USD", amountMinor: 7n },
  ];
  const residual = planner.allocateResidual(instructions);
  assert.equal(residual["EUR:a"], -50n);
  assert.equal(residual["EUR:b"], 40n);
  assert.equal(residual["EUR:c"], 10n);
  assert.equal(residual["USD:d"], -7n);
  assert.equal(residual["USD:a"], 7n);
  const total = Object.values(residual).reduce((sum, value) => sum + value, 0n);
  assert.equal(total, 0n);
});

test("netting input validation reports the source position", () => {
  const planner = new NettingPlanner();
  assert.throws(() => planner.plan([position("", "EUR", 1n)]), /position 0/u);
  assert.throws(() => planner.plan([position("a", "EU", 1n)]), /currency/u);
  assert.throws(
    () => planner.plan([position("a", "EUR", 1n, -1)]),
    /priority/u,
  );
  assert.throws(
    () =>
      planner.allocateResidual([
        { from: "a", to: "a", currency: "EUR", amountMinor: 1n },
      ]),
    /same account/u,
  );
});

test("netting inspection totals parsed positions", () => {
  const planner = new NettingPlanner();
  const report = planner.evaluateNettingPolicies({
    nettingSetId: " daily ",
    plannedAt: 1,
    positionHints: {
      "a:EUR": 10,
      "b:EUR": "-7",
      "c:USD": 0,
      malformed: true,
      "d:EU": 1,
    },
    currencies: ["GBP", "eur"],
  });
  assert.equal(report.nettingSetId, "daily");
  assert.equal(report.positiveMinor, 10n);
  assert.equal(report.negativeMinor, 7n);
  assert.equal(report.imbalanceMinor, 3n);
  assert.equal(report.zeroPositions, 1);
  assert.deepEqual(report.currencies, ["EUR", "GBP", "USD"]);
  assert.deepEqual(report.malformedPositions, ["d:EU", "malformed"]);
});

test("fee lookup applies the matching fixed and proportional tier", () => {
  const table = new QuotedFeeTable();
  // 500 → 固定 2 + 500×1% = 7;2000 → 固定 5 + 2000×0.5% = 15。
  assert.equal(table.lookup(500n, standardTiers), 7n);
  assert.equal(table.lookup(2_000n, standardTiers), 15n);
  assert.equal(table.lookup(20_000n, standardTiers), 60n);
});

test("fees are capped at notional by default", () => {
  const table = new QuotedFeeTable(true);
  // 10% 费率下费用(130)超过本金(30),默认封顶为本金,关闭封顶则放行。
  const expensive: FeeTier[] = [
    { minimumMinor: 0n, basisPoints: 10_000, fixedMinor: 100n },
  ];
  assert.equal(table.lookup(30n, expensive), 30n);
  assert.equal(new QuotedFeeTable(false).lookup(30n, expensive), 130n);
});

test("applyTier keeps the amount order", () => {
  const table = new QuotedFeeTable();
  const amounts = [0n, 999n, 1_000n, 9_999n, 10_000n, 100_000n];
  const charges = table.applyTier(amounts, standardTiers);
  assert.equal(charges.length, amounts.length);
  assert.deepEqual(
    charges,
    amounts.map((amount) => table.lookup(amount, standardTiers)),
  );
});

test("charge rounding is symmetric around zero", () => {
  const table = new QuotedFeeTable();
  assert.equal(table.roundCharge(12n, 5n), 10n);
  assert.equal(table.roundCharge(13n, 5n), 15n);
  assert.equal(table.roundCharge(-12n, 5n), -10n);
  assert.equal(table.roundCharge(-13n, 5n), -15n);
  assert.equal(table.roundCharge(15n, 5n), 15n);
});

test("fee tier gaps and overlaps are explicit", () => {
  const table = new QuotedFeeTable();
  // 层间留空:区间外金额无层级可用;层间重叠:边界金额同时命中两层。
  const gap: FeeTier[] = [
    { minimumMinor: 0n, maximumMinor: 9n, basisPoints: 1, fixedMinor: 0n },
    { minimumMinor: 20n, basisPoints: 1, fixedMinor: 0n },
  ];
  assert.throws(() => table.lookup(15n, gap), /no applicable/u);
  const overlap: FeeTier[] = [
    { minimumMinor: 0n, maximumMinor: 20n, basisPoints: 1, fixedMinor: 0n },
    { minimumMinor: 20n, basisPoints: 1, fixedMinor: 0n },
  ];
  assert.throws(() => table.lookup(20n, overlap), /overlap/u);
});

test("fee tier validation rejects invalid bounds and rates", () => {
  const table = new QuotedFeeTable();
  assert.throws(
    () =>
      table.lookup(1n, [{ minimumMinor: -1n, basisPoints: 1, fixedMinor: 0n }]),
    /negative minimum/u,
  );
  assert.throws(
    () =>
      table.lookup(1n, [
        { minimumMinor: 0n, maximumMinor: -1n, basisPoints: 1, fixedMinor: 0n },
      ]),
    /maximum/u,
  );
  assert.throws(() => table.roundCharge(1n, 0n), /positive/u);
});

test("fee policy regression recognizes a linear schedule", () => {
  const table = new QuotedFeeTable();
  // 费用随金额线性增长(每 100 加 2)时,回归斜率应为 0.02、截距 1、RMSE 为 0。
  const report = table.evaluateFeePolicies({
    feeTableId: " linear ",
    pricedAt: 1,
    feeInputs: { "100": 3, "200": 5, "300": 7, "400": "9", bad: false },
    tiers: ["0+", "1000-", "bad tier"],
  });
  assert.equal(report.feeTableId, "linear");
  assert.equal(report.samples, 4);
  assert.ok(Math.abs(report.slope - 0.02) < 1e-12);
  assert.ok(Math.abs(report.intercept - 1) < 1e-12);
  assert.equal(report.rootMeanSquareError, 0);
  assert.deepEqual(report.malformedInputs, ["bad", "bad tier"]);
  assert.deepEqual(report.parsedTierBounds, [0n, 1_000n]);
});

test("generated balanced books always allocate full debtor totals", () => {
  const planner = new NettingPlanner(true);
  // 规模从 1 到 20 的平衡账本,轧差转移总额必须等于全部借方总额之和。
  for (let size = 1; size <= 20; size += 1) {
    const positions: NetPosition[] = [];
    for (let index = 0; index < size; index += 1) {
      positions.push(position(`d-${index}`, "EUR", -BigInt(index + 1), index));
      positions.push(position(`c-${index}`, "EUR", BigInt(index + 1), index));
    }
    const instructions = planner.plan(positions);
    const transferred = instructions.reduce(
      (sum, entry) => sum + entry.amountMinor,
      0n,
    );
    const expected = BigInt((size * (size + 1)) / 2);
    assert.equal(transferred, expected, `book size ${size}`);
  }
});
