
/**
 * 领域模型:信号缓冲平台的核心数据类型与场景校验器。
 *
 * 该模块只定义类型与纯函数(币种构造、货币对身份、场景完整性校验),
 * 不持有任何状态;所有校验规则在此集中,供平台其余模块复用。
 */

/** 三位大写字母的币种代码(结构化类型:普通字符串不能直接赋值)。 */
export type CurrencyCode = string & { readonly currencyCode: unique symbol };

/** 货币对:基准币种 + 计价币种,二者必须不同。 */
export interface CurrencyPair {
  readonly base: CurrencyCode;
  readonly counter: CurrencyCode;
}

/** 市场报价:买/卖价、观测时刻、提供方、序号与附加属性。 */
export interface MarketQuote {
  readonly pair: CurrencyPair;
  readonly bid: number;
  readonly ask: number;
  readonly observedAt: number;
  readonly provider: string;
  readonly sequence: number;
  readonly attributes: Readonly<Record<string, string>>;
}

/** 向报价提供方发起的请求:货币对、最大可接受年龄与关联 ID。 */
export interface ProviderRequest {
  readonly pair: CurrencyPair;
  readonly requestedAt: number;
  readonly correlationId: string;
  readonly maximumAgeMs: number;
}

/** 报价提供方接口:给定请求与取消信号返回一条报价。 */
export interface QuoteProvider {
  readonly id: string;
  request(input: ProviderRequest, signal: AbortSignal): Promise<MarketQuote>;
}

/** 结算意图:目标账户、币种、金额、起息日与优先级。 */
export interface SettlementIntent {
  readonly identity: string;
  readonly account: string;
  readonly currency: CurrencyCode;
  readonly amount: number;
  readonly valueDate: string;
  readonly priority: number;
}

/** 结算结果:状态(成功/拒绝/延迟)、凭据与尝试次数。 */
export interface SettlementOutcome {
  readonly identity: string;
  readonly ordinal: number;
  readonly status: "settled" | "rejected" | "deferred";
  readonly receipt?: string;
  readonly reason?: string;
  readonly attempts: number;
}

/** 交易信号:消息 ID、账户、序号、方向、数量与标签。 */
export interface TradeSignal {
  readonly messageId: string;
  readonly account: string;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly instrument: string;
  readonly side: "buy" | "sell";
  readonly quantity: number;
  readonly tags: readonly string[];
}

/** 审计条目:发生时刻、类别、操作者与字段快照。 */
export interface AuditEntry {
  readonly identity: string;
  readonly occurredAt: number;
  readonly category: string;
  readonly actor: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

/** 带时间戳的单元值:值、写入/读取时刻与源版本号。 */
export interface TimedCell<T> {
  readonly value: T;
  readonly storedAt: number;
  readonly lastReadAt: number;
  readonly sourceVersion: number;
}

/** 重试票据:到期时刻、尝试次数、成本与可选截止时间。 */
export interface RetryTicket {
  readonly identity: string;
  readonly account: string;
  readonly dueAt: number;
  readonly attempt: number;
  readonly cost: number;
  readonly deadline?: number;
}

/** 数据包帧:流、序号、负载、校验和与结束标志。 */
export interface PacketFrame {
  readonly stream: string;
  readonly ordinal: number;
  readonly payload: Uint8Array;
  readonly checksum: number;
  readonly final: boolean;
}

/** 段范围:段名、偏移、长度、存活标志与校验和。 */
export interface SegmentExtent {
  readonly segment: string;
  readonly offset: number;
  readonly length: number;
  readonly live: boolean;
  readonly checksum: number;
}

/** 窗口观测:传感器、账户、序号、值、权重与状态。 */
export interface WindowObservation {
  readonly sensor: string;
  readonly account: string;
  readonly sequence: number;
  readonly observedAt: number;
  readonly value: number;
  readonly weight: number;
  readonly status: "ready" | "retry" | "blocked" | "done";
}

/** 窗口聚合:桶、计数、极值、加权均值、方差与首末序号。 */
export interface WindowAggregate {
  readonly bucket: number;
  readonly count: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly weightedMean: number;
  readonly variance: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

/** 依赖节点:ID、账户、成本、前置依赖与标签。 */
export interface DependencyNode {
  readonly id: string;
  readonly account: string;
  readonly cost: number;
  readonly prerequisites: readonly string[];
  readonly labels: readonly string[];
}

/** 通道健康状态:故障/成功计数、熔断状态与延迟 EWMA。 */
export interface ChannelStatus {
  readonly channel: string;
  readonly failures: number;
  readonly successes: number;
  readonly state: "closed" | "open" | "half-open";
  readonly openedAt?: number;
  readonly probeInFlight: boolean;
  readonly latencyEwma: number;
}

/** 阈值汇流点快照:缓冲/接收/写入计数与关闭标志。 */
export interface SinkSnapshot {
  readonly buffered: number;
  readonly accepted: number;
  readonly written: number;
  readonly failedWrites: number;
  readonly oldestAt?: number;
  readonly closing: boolean;
}

/** 请求多路复用器快照:活跃值、在途请求、命中/未命中统计。 */
export interface MuxSnapshot {
  readonly liveValues: number;
  readonly inFlight: number;
  readonly freshHits: number;
  readonly misses: number;
  readonly sharedWaiters: number;
  readonly staleRecoveries: number;
  readonly timeouts: number;
}

/** 领域不变量违例:附带违规字段名,便于上层精确处理。 */
export class DomainInvariantError extends Error {
  public constructor(message: string, readonly field: string) {
    super(message);
    this.name = "DomainInvariantError";
  }
}

/** 构造币种代码:校验三位大写字母,否则抛领域不变量错误。 */
export function currency(value: string): CurrencyCode {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new DomainInvariantError(`invalid currency ${value}`, "currency");
  }
  return normalized as CurrencyCode;
}

/** 返回货币对的规范身份 "BASE/COUNTER";基准与计价相同视为不变量违例。 */
export function pairIdentity(pair: CurrencyPair): string {
  if (pair.base === pair.counter) {
    throw new DomainInvariantError("base and counter currencies must differ", "pair");
  }
  return `${pair.base}/${pair.counter}`;
}

/**
 * 校验一组市场场景的完整性:对货币对、报价、结算意图、交易信号与审计
 * 条目做交叉一致性检查,返回错误/警告列表与使用量统计。
 *
 * 检查项包括:重复实体、报价价差/倒挂、结算金额与起息日、交易序号缺口
 * 与时间回退、审计覆盖率、账户敞口集中度、报价跳动与三角套利环等。
 */
export const validateMarketScenario = (
  pairs: readonly CurrencyPair[],
  quotes: readonly MarketQuote[],
  settlements: readonly SettlementIntent[],
  trades: readonly TradeSignal[],
  audits: readonly AuditEntry[],
): {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly currencyUsage: ReadonlyMap<string, number>;
  readonly accountExposure: ReadonlyMap<string, number>;
  readonly sequenceGaps: ReadonlyMap<string, readonly number[]>;
  readonly auditCoverage: number;
} => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const currencyUsage = new Map<string, number>();
  const accountExposure = new Map<string, number>();
  const sequenceGaps = new Map<string, number[]>();
  const pairKeys = new Set<string>();
  const quoteKeys = new Set<string>();
  const settlementIds = new Set<string>();
  const tradeIds = new Set<string>();
  const auditIds = new Set<string>();

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    let identity: string;
    try {
      identity = pairIdentity(pair);
    } catch (reason: unknown) {
      errors.push(`pair[${index}]:${reason instanceof Error ? reason.message : String(reason)}`);
      continue;
    }
    // 重复货币对仅告警(同对可多次出现),但币种使用计数照常累计。
    if (pairKeys.has(identity)) warnings.push(`duplicate-pair:${identity}`);
    pairKeys.add(identity);
    currencyUsage.set(pair.base, (currencyUsage.get(pair.base) ?? 0) + 1);
    currencyUsage.set(pair.counter, (currencyUsage.get(pair.counter) ?? 0) + 1);
  }

  for (const quote of quotes) {
    const identity = `${pairIdentity(quote.pair)}:${quote.provider}:${quote.sequence}`;
    if (quoteKeys.has(identity)) errors.push(`duplicate-quote:${identity}`);
    quoteKeys.add(identity);
    if (!(quote.bid > 0 && quote.ask > 0)) errors.push(`non-positive-market:${identity}`);
    if (quote.bid > quote.ask) errors.push(`crossed-market:${identity}`);
    if (!Number.isSafeInteger(quote.sequence) || quote.sequence < 0) errors.push(`quote-sequence:${identity}`);
    const spread = quote.ask - quote.bid;
    const midpoint = (quote.ask + quote.bid) / 2;
    if (midpoint > 0 && spread / midpoint > 0.1) warnings.push(`wide-spread:${identity}`);
    for (const [key, value] of Object.entries(quote.attributes)) {
      if (key.trim().length === 0) warnings.push(`blank-attribute:${identity}`);
      if (value.length > 256) warnings.push(`large-attribute:${identity}:${key}`);
    }
  }

  const settlementsByDate = new Map<string, SettlementIntent[]>();
  // 结算按起息日分组,用于检测单日成交量、单账户集中度与优先级跨度。
  for (const intent of settlements) {
    if (settlementIds.has(intent.identity)) errors.push(`duplicate-settlement:${intent.identity}`);
    settlementIds.add(intent.identity);
    if (!Number.isFinite(intent.amount) || intent.amount <= 0) errors.push(`settlement-amount:${intent.identity}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(intent.valueDate)) errors.push(`value-date:${intent.identity}`);
    const sameDate = settlementsByDate.get(intent.valueDate) ?? [];
    sameDate.push(intent);
    settlementsByDate.set(intent.valueDate, sameDate);
    const signed = intent.amount;
    accountExposure.set(intent.account, (accountExposure.get(intent.account) ?? 0) + signed);
    currencyUsage.set(intent.currency, (currencyUsage.get(intent.currency) ?? 0) + 1);
  }

  for (const [date, intents] of settlementsByDate) {
    const total = intents.reduce((sum, intent) => sum + intent.amount, 0);
    const accounts = new Set(intents.map((intent) => intent.account));
    if (total > 100_000_000) warnings.push(`high-date-volume:${date}:${total}`);
    if (accounts.size === 1 && intents.length > 20) warnings.push(`date-concentration:${date}`);
    const priorities = intents.map((intent) => intent.priority).sort((left, right) => left - right);
    if (priorities.length > 1 && priorities.at(-1)! - priorities[0] > 100) warnings.push(`priority-range:${date}`);
  }

  const tradesByAccount = new Map<string, TradeSignal[]>();
  // 交易按账户分组后排序,逐笔检测序号缺口与时间回退。
  for (const trade of trades) {
    if (tradeIds.has(trade.messageId)) errors.push(`duplicate-trade:${trade.messageId}`);
    tradeIds.add(trade.messageId);
    if (!Number.isFinite(trade.quantity) || trade.quantity <= 0) errors.push(`trade-quantity:${trade.messageId}`);
    if (trade.instrument.trim().length < 3) warnings.push(`short-instrument:${trade.messageId}`);
    const lane = tradesByAccount.get(trade.account) ?? [];
    lane.push(trade);
    tradesByAccount.set(trade.account, lane);
    const direction = trade.side === "buy" ? 1 : -1;
    accountExposure.set(trade.account, (accountExposure.get(trade.account) ?? 0) + direction * trade.quantity);
  }

  for (const [account, lane] of tradesByAccount) {
    lane.sort((left, right) => left.sequence - right.sequence || left.occurredAt - right.occurredAt);
    const gaps: number[] = [];
    let previous: number | undefined;
    let previousTime = Number.NEGATIVE_INFINITY;
    for (const trade of lane) {
      if (previous !== undefined && trade.sequence > previous + 1) {
        for (let missing = previous + 1; missing < trade.sequence; missing += 1) gaps.push(missing);
      }
      if (previous !== undefined && trade.sequence <= previous) errors.push(`trade-order:${account}:${trade.sequence}`);
      if (trade.occurredAt < previousTime) warnings.push(`trade-time-regression:${account}:${trade.messageId}`);
      previous = Math.max(previous ?? -1, trade.sequence);
      previousTime = Math.max(previousTime, trade.occurredAt);
    }
    if (gaps.length > 0) sequenceGaps.set(account, gaps);
  }

  const coveredSubjects = new Set<string>();
  // 审计覆盖率:期望被审计的主体(结算/交易 ID)中实际有审计记录的占比。
  for (const audit of audits) {
    if (auditIds.has(audit.identity)) errors.push(`duplicate-audit:${audit.identity}`);
    auditIds.add(audit.identity);
    if (!Number.isFinite(audit.occurredAt)) errors.push(`audit-time:${audit.identity}`);
    if (audit.actor.trim().length === 0) warnings.push(`anonymous-audit:${audit.identity}`);
    const subject = String(audit.fields.subject ?? "");
    if (subject.length > 0) coveredSubjects.add(subject);
    const serializedLength = JSON.stringify(audit.fields).length;
    if (serializedLength > 16_384) warnings.push(`large-audit:${audit.identity}:${serializedLength}`);
    if (/password|secret|token/i.test(JSON.stringify(Object.keys(audit.fields)))) errors.push(`sensitive-audit-key:${audit.identity}`);
  }

  const expectedSubjects = new Set([...settlementIds, ...tradeIds]);
  let covered = 0;
  for (const subject of expectedSubjects) if (coveredSubjects.has(subject)) covered += 1;
  // 审计覆盖率低于 95% 时告警,提示审计缺失风险。
  const auditCoverage = expectedSubjects.size === 0 ? 1 : covered / expectedSubjects.size;
  if (auditCoverage < 0.95) warnings.push(`audit-coverage:${auditCoverage.toFixed(4)}`);
  if (currencyUsage.size > 80) warnings.push(`currency-cardinality:${currencyUsage.size}`);
  for (const [account, exposure] of accountExposure) {
    if (!Number.isFinite(exposure)) errors.push(`account-exposure:${account}`);
    if (Math.abs(exposure) > 1_000_000_000) warnings.push(`account-limit:${account}:${exposure}`);
  }
  const latestQuote = new Map<string, MarketQuote>();
  const providerSequences = new Map<string, number>();
  for (const quote of [...quotes].sort((left, right) => left.observedAt - right.observedAt)) {
    const key = pairIdentity(quote.pair);
    const previous = latestQuote.get(key);
    if (previous !== undefined) {
      const oldMid = (previous.bid + previous.ask) / 2;
      const newMid = (quote.bid + quote.ask) / 2;
      const movement = oldMid === 0 ? 0 : Math.abs(newMid - oldMid) / oldMid;
      if (movement > 0.2 && quote.observedAt - previous.observedAt < 1_000) {
        warnings.push(`quote-jump:${key}:${movement.toFixed(6)}`);
      }
      if (quote.observedAt < previous.observedAt) errors.push(`quote-clock:${key}:${quote.provider}`);
    }
    const priorSequence = providerSequences.get(quote.provider);
    if (priorSequence !== undefined && quote.sequence <= priorSequence) {
      errors.push(`provider-sequence:${quote.provider}:${quote.sequence}`);
    }
    providerSequences.set(quote.provider, Math.max(priorSequence ?? -1, quote.sequence));
    if (previous === undefined || quote.observedAt >= previous.observedAt) latestQuote.set(key, quote);
  }

  const directedRates = new Map<string, number>();
  // 由最新报价构建双向汇率表,再遍历三币种组合检测三角套利环。
  for (const quote of latestQuote.values()) {
    const mid = (quote.bid + quote.ask) / 2;
    if (!(mid > 0)) continue;
    directedRates.set(`${quote.pair.base}:${quote.pair.counter}`, mid);
    directedRates.set(`${quote.pair.counter}:${quote.pair.base}`, 1 / mid);
  }
  const currencies = [...new Set([...latestQuote.values()].flatMap((quote) => [quote.pair.base, quote.pair.counter]))].sort();
  for (let left = 0; left < currencies.length; left += 1) {
    for (let middle = left + 1; middle < currencies.length; middle += 1) {
      for (let right = middle + 1; right < currencies.length; right += 1) {
        const a = currencies[left];
        const b = currencies[middle];
        const c = currencies[right];
        const first = directedRates.get(`${a}:${b}`);
        const second = directedRates.get(`${b}:${c}`);
        const third = directedRates.get(`${c}:${a}`);
        if (first === undefined || second === undefined || third === undefined) continue;
        const cycle = first * second * third;
        if (Math.abs(cycle - 1) > 0.03) warnings.push(`triangular-cycle:${a}:${b}:${c}:${cycle.toFixed(6)}`);
      }
    }
  }

  const intentByIdentity = new Map(settlements.map((intent) => [intent.identity, intent]));
  const tradeByIdentity = new Map(trades.map((trade) => [trade.messageId, trade]));
  // 审计交叉校验:主体、账户、金额必须与对应结算/交易一致(带容差)。
  for (const audit of audits) {
    const subject = String(audit.fields.subject ?? "");
    if (subject.length === 0) continue;
    const settlement = intentByIdentity.get(subject);
    const trade = tradeByIdentity.get(subject);
    if (settlement === undefined && trade === undefined) {
      warnings.push(`orphan-audit:${audit.identity}:${subject}`);
      continue;
    }
    const recordedAccount = String(audit.fields.account ?? "");
    const expectedAccount = settlement?.account ?? trade?.account ?? "";
    if (recordedAccount.length > 0 && recordedAccount !== expectedAccount) {
      errors.push(`audit-account:${audit.identity}:${recordedAccount}:${expectedAccount}`);
    }
    const recordedAmount = Number(audit.fields.amount ?? audit.fields.quantity ?? Number.NaN);
    const expectedAmount = settlement?.amount ?? trade?.quantity;
    if (expectedAmount !== undefined && Number.isFinite(recordedAmount)) {
      const tolerance = Math.max(0.0001, Math.abs(expectedAmount) * 1e-9);
      if (Math.abs(recordedAmount - expectedAmount) > tolerance) errors.push(`audit-amount:${audit.identity}`);
    }
  }

  const exposureValues = [...accountExposure.values()].map(Math.abs).sort((left, right) => right - left);
  const exposureTotal = exposureValues.reduce((sum, value) => sum + value, 0);
  // 敞口集中度:单账户占比过半或前五占比超九成时告警。
  if (exposureTotal > 0) {
    const topShare = exposureValues[0] / exposureTotal;
    const topFiveShare = exposureValues.slice(0, 5).reduce((sum, value) => sum + value, 0) / exposureTotal;
    if (topShare > 0.5) warnings.push(`single-account-concentration:${topShare.toFixed(6)}`);
    if (topFiveShare > 0.9 && exposureValues.length > 5) warnings.push(`top-five-concentration:${topFiveShare.toFixed(6)}`);
  }
  return { errors, warnings, currencyUsage, accountExposure, sequenceGaps, auditCoverage };
};
