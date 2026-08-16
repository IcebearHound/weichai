/**
 * 场景固件:为测试套件提供统一的领域对象构造器与标准数据集。
 * 所有构造器都带确定性默认值,保证跨测试稳定可复现。
 */
import {
  currency,
  type AuditEntry,
  type CurrencyPair,
  type DependencyNode,
  type MarketQuote,
  type PacketFrame,
  type RetryTicket,
  type SegmentExtent,
  type SettlementIntent,
  type TradeSignal,
  type WindowObservation,
} from "../src/index.js";

/** 常用币种常量。 */
export const USD = currency("USD");
export const EUR = currency("EUR");
export const GBP = currency("GBP");
export const JPY = currency("JPY");
export const CHF = currency("CHF");

/** 构造货币对,默认 USD/EUR。 */
export const pair = (base = USD, counter = EUR): CurrencyPair => ({ base, counter });

/** 构造一条报价:序列号驱动观测时刻与价格,附带场所/延迟/会话属性。 */
export const quote = (
  sequence: number,
  provider = "north-feed",
  observedAt = 1_000 + sequence * 20,
  bid = 1.08 + sequence / 10_000,
  ask = bid + 0.0002,
  market = pair(),
): MarketQuote => ({
  pair: market,
  bid,
  ask,
  observedAt,
  provider,
  sequence,
  attributes: {
    venue: provider.includes("north") ? "LN" : "NY",
    latencyMs: String(12 + sequence),
    session: observedAt < 1_200 ? "open" : "continuous",
  },
});

/** 构造一条结算意图,默认 100 USD、2026-07-13 起息、优先级 50。 */
export const settlement = (
  identity: string,
  account = "acct-a",
  amount = 100,
  currencyCode = USD,
  valueDate = "2026-07-13",
  priority = 50,
): SettlementIntent => ({
  identity,
  account,
  currency: currencyCode,
  amount,
  valueDate,
  priority,
});

/** 构造一条交易信号:消息 ID 形如 “account-m<sequence>”,买/卖对应不同标的。 */
export const trade = (
  account: string,
  sequence: number,
  occurredAt = 2_000 + sequence,
  side: "buy" | "sell" = "buy",
  quantity = 10,
): TradeSignal => ({
  messageId: `${account}-m${sequence}`,
  account,
  sequence,
  occurredAt,
  instrument: side === "buy" ? "EURUSD" : "GBPUSD",
  side,
  quantity,
  tags: sequence % 2 === 0 ? ["automated", "liquid"] : ["manual"],
});

/** 构造一条审计条目:携带主体、账户与模拟环境字段。 */
export const audit = (
  identity: string,
  subject: string,
  account = "acct-a",
  occurredAt = 3_000,
  category = "settlement",
): AuditEntry => ({
  identity,
  occurredAt,
  category,
  actor: "scenario-suite",
  fields: {
    subject,
    account,
    environment: "simulation",
    approved: true,
  },
});

/** 构造一条窗口观测,默认状态为 ready、权重 1。 */
export const observation = (
  sensor: string,
  account: string,
  sequence: number,
  observedAt: number,
  value: number,
  status: WindowObservation["status"] = "ready",
  weight = 1,
): WindowObservation => ({
  sensor,
  account,
  sequence,
  observedAt,
  value,
  weight,
  status,
});

/** 构造一张重试票据,默认第 1 次尝试、无截止时间。 */
export const retry = (
  identity: string,
  account: string,
  dueAt: number,
  cost: number,
  attempt = 1,
  deadline?: number,
): RetryTicket => ({
  identity,
  account,
  dueAt,
  attempt,
  cost,
  deadline,
});

/** 按 FNV-1a 风格计算帧校验和(覆盖负载与序号),与源码实现一致。 */
export const checksum = (ordinal: number, payload: Uint8Array): number => {
  let value = 2166136261;
  for (const byte of payload) {
    value ^= byte;
    value = Math.imul(value, 16777619) >>> 0;
  }
  value ^= ordinal;
  return Math.imul(value, 16777619) >>> 0;
};

/** 构造一帧数据包,自动计算合法校验和。 */
export const frame = (
  ordinal: number,
  bytes: readonly number[],
  final = false,
  stream = "prices-20260712",
): PacketFrame => {
  const payload = Uint8Array.from(bytes);
  return {
    stream,
    ordinal,
    payload,
    checksum: checksum(ordinal, payload),
    final,
  };
};

/** 构造一段 extent,校验和默认由偏移与长度派生。 */
export const extent = (
  segment: string,
  offset: number,
  length: number,
  live = true,
  checksumValue = offset * 31 + length,
): SegmentExtent => ({
  segment,
  offset,
  length,
  live,
  checksum: checksumValue,
});

/** 构造一个依赖节点,默认成本 1、账户 platform、无标签。 */
export const node = (
  id: string,
  prerequisites: readonly string[] = [],
  cost = 1,
  account = "platform",
  labels: readonly string[] = [],
): DependencyNode => ({
  id,
  account,
  cost,
  prerequisites,
  labels,
});

/** 流动性市场报价:8 条双向报价覆盖 4 个货币对,来自 4 个提供方。 */
export const liquidMarket: readonly MarketQuote[] = [
  quote(1, "north-feed", 1_000, 1.0810, 1.0812, pair(USD, EUR)),
  quote(2, "north-feed", 1_020, 0.9258, 0.9260, pair(EUR, USD)),
  quote(3, "east-feed", 1_040, 1.2710, 1.2714, pair(GBP, USD)),
  quote(4, "east-feed", 1_060, 0.7864, 0.7867, pair(USD, GBP)),
  quote(5, "alpine-feed", 1_080, 0.8950, 0.8953, pair(EUR, CHF)),
  quote(6, "alpine-feed", 1_100, 1.1168, 1.1172, pair(CHF, EUR)),
  quote(7, "tokyo-feed", 1_120, 158.10, 158.14, pair(USD, JPY)),
  quote(8, "tokyo-feed", 1_140, 0.00632, 0.00634, pair(JPY, USD)),
];

/** 标准结算账本:10 条跨币种、跨优先级、跨起息日的意图。 */
export const settlementBook: readonly SettlementIntent[] = [
  settlement("s-001", "acct-a", 120_000, USD, "2026-07-13", 95),
  settlement("s-002", "acct-b", 80_000, EUR, "2026-07-13", 70),
  settlement("s-003", "acct-a", 45_000, GBP, "2026-07-14", 35),
  settlement("s-004", "acct-c", 310_000, USD, "2026-07-13", 100),
  settlement("s-005", "acct-d", 20_000, CHF, "2026-07-15", 15),
  settlement("s-006", "acct-b", 63_000, EUR, "2026-07-14", 82),
  settlement("s-007", "acct-e", 900_000, JPY, "2026-07-13", 55),
  settlement("s-008", "acct-c", 13_000, GBP, "2026-07-16", 48),
  settlement("s-009", "acct-f", 4_000, USD, "2026-07-13", 5),
  settlement("s-010", "acct-d", 72_000, CHF, "2026-07-15", 66),
];

/** 标准交易流:10 条跨账户信号(含 acct-a 的序号缺口 3)。 */
export const tradeStream: readonly TradeSignal[] = [
  trade("acct-a", 1, 2_001, "buy", 10),
  trade("acct-b", 1, 2_002, "sell", 8),
  trade("acct-a", 2, 2_003, "sell", 4),
  trade("acct-c", 1, 2_004, "buy", 90),
  trade("acct-b", 2, 2_005, "buy", 11),
  trade("acct-a", 4, 2_006, "buy", 7),
  trade("acct-d", 1, 2_007, "sell", 32),
  trade("acct-c", 2, 2_008, "sell", 25),
  trade("acct-e", 1, 2_009, "buy", 2),
  trade("acct-b", 3, 2_010, "sell", 12),
];

/** 标准观测序列:3 组传感器 × 4 条(含 retry/blocked 状态),跨 3 账户。 */
export const observationSeries: readonly WindowObservation[] = [
  observation("queue-depth", "acct-a", 1, 900, 8),
  observation("queue-depth", "acct-a", 2, 950, 9),
  observation("queue-depth", "acct-a", 3, 1_010, 30, "retry"),
  observation("queue-depth", "acct-a", 5, 1_070, 36, "blocked"),
  observation("latency", "acct-b", 1, 910, 12),
  observation("latency", "acct-b", 2, 970, 13),
  observation("latency", "acct-b", 3, 1_020, 65, "retry"),
  observation("latency", "acct-b", 4, 1_080, 72, "blocked"),
  observation("reject-rate", "acct-c", 1, 920, 0.01),
  observation("reject-rate", "acct-c", 2, 980, 0.02),
  observation("reject-rate", "acct-c", 3, 1_030, 0.25, "retry"),
  observation("reject-rate", "acct-c", 4, 1_090, 0.31, "blocked"),
];

/** 标准依赖图:从 ingest 到 publish 的 9 节点流水线(含两条关键路径)。 */
export const dependencyFixture: readonly DependencyNode[] = [
  node("ingest", [], 2, "platform", ["edge"]),
  node("normalize", ["ingest"], 3, "platform", ["quote"]),
  node("price", ["normalize"], 8, "pricing", ["critical"]),
  node("risk", ["normalize"], 6, "risk", ["critical"]),
  node("authorize", ["risk"], 4, "risk", ["control"]),
  node("settle", ["price", "authorize"], 9, "settlement", ["critical"]),
  node("receipt", ["settle"], 2, "settlement", ["durable"]),
  node("audit", ["settle"], 3, "compliance", ["durable"]),
  node("publish", ["receipt", "audit"], 1, "platform", ["edge"]),
];

/** 标准数据包流:4 帧乱序到达,末帧 ordinal=3。 */
export const packetFixture: readonly PacketFrame[] = [
  frame(3, [31, 32, 33], true),
  frame(0, [1, 2, 3]),
  frame(2, [21, 22, 23]),
  frame(1, [11, 12, 13]),
];

/** 标准段布局:3 个段共 7 条 extent,含死区(供压缩/迁移测试)。 */
export const extentFixture: readonly SegmentExtent[] = [
  extent("old-a", 0, 160, true, 101),
  extent("old-a", 160, 64, false, 102),
  extent("old-a", 224, 96, true, 103),
  extent("old-b", 0, 48, true, 104),
  extent("old-b", 48, 80, false, 105),
  extent("old-b", 128, 192, true, 106),
  extent("old-c", 0, 256, true, 107),
];
