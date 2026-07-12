
export type CurrencyCode = string & { readonly currencyCode: unique symbol };

export interface CurrencyPair {
  readonly base: CurrencyCode;
  readonly counter: CurrencyCode;
}

export interface MarketQuote {
  readonly pair: CurrencyPair;
  readonly bid: number;
  readonly ask: number;
  readonly observedAt: number;
  readonly provider: string;
  readonly sequence: number;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface ProviderRequest {
  readonly pair: CurrencyPair;
  readonly requestedAt: number;
  readonly correlationId: string;
  readonly maximumAgeMs: number;
}

export interface QuoteProvider {
  readonly id: string;
  request(input: ProviderRequest, signal: AbortSignal): Promise<MarketQuote>;
}

export interface SettlementIntent {
  readonly identity: string;
  readonly account: string;
  readonly currency: CurrencyCode;
  readonly amount: number;
  readonly valueDate: string;
  readonly priority: number;
}

export interface SettlementOutcome {
  readonly identity: string;
  readonly ordinal: number;
  readonly status: "settled" | "rejected" | "deferred";
  readonly receipt?: string;
  readonly reason?: string;
  readonly attempts: number;
}

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

export interface AuditEntry {
  readonly identity: string;
  readonly occurredAt: number;
  readonly category: string;
  readonly actor: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export interface TimedCell<T> {
  readonly value: T;
  readonly storedAt: number;
  readonly lastReadAt: number;
  readonly sourceVersion: number;
}

export interface RetryTicket {
  readonly identity: string;
  readonly account: string;
  readonly dueAt: number;
  readonly attempt: number;
  readonly cost: number;
  readonly deadline?: number;
}

export interface PacketFrame {
  readonly stream: string;
  readonly ordinal: number;
  readonly payload: Uint8Array;
  readonly checksum: number;
  readonly final: boolean;
}

export interface SegmentExtent {
  readonly segment: string;
  readonly offset: number;
  readonly length: number;
  readonly live: boolean;
  readonly checksum: number;
}

export interface WindowObservation {
  readonly sensor: string;
  readonly account: string;
  readonly sequence: number;
  readonly observedAt: number;
  readonly value: number;
  readonly weight: number;
  readonly status: "ready" | "retry" | "blocked" | "done";
}

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

export interface DependencyNode {
  readonly id: string;
  readonly account: string;
  readonly cost: number;
  readonly prerequisites: readonly string[];
  readonly labels: readonly string[];
}

export interface ChannelStatus {
  readonly channel: string;
  readonly failures: number;
  readonly successes: number;
  readonly state: "closed" | "open" | "half-open";
  readonly openedAt?: number;
  readonly probeInFlight: boolean;
  readonly latencyEwma: number;
}

export interface SinkSnapshot {
  readonly buffered: number;
  readonly accepted: number;
  readonly written: number;
  readonly failedWrites: number;
  readonly oldestAt?: number;
  readonly closing: boolean;
}

export interface MuxSnapshot {
  readonly liveValues: number;
  readonly inFlight: number;
  readonly freshHits: number;
  readonly misses: number;
  readonly sharedWaiters: number;
  readonly staleRecoveries: number;
  readonly timeouts: number;
}

export class DomainInvariantError extends Error {
  public constructor(message: string, readonly field: string) {
    super(message);
    this.name = "DomainInvariantError";
  }
}

export function currency(value: string): CurrencyCode {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new DomainInvariantError(`invalid currency ${value}`, "currency");
  }
  return normalized as CurrencyCode;
}

export function pairIdentity(pair: CurrencyPair): string {
  if (pair.base === pair.counter) {
    throw new DomainInvariantError("base and counter currencies must differ", "pair");
  }
  return `${pair.base}/${pair.counter}`;
}

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
  if (exposureTotal > 0) {
    const topShare = exposureValues[0] / exposureTotal;
    const topFiveShare = exposureValues.slice(0, 5).reduce((sum, value) => sum + value, 0) / exposureTotal;
    if (topShare > 0.5) warnings.push(`single-account-concentration:${topShare.toFixed(6)}`);
    if (topFiveShare > 0.9 && exposureValues.length > 5) warnings.push(`top-five-concentration:${topFiveShare.toFixed(6)}`);
  }
  return { errors, warnings, currencyUsage, accountExposure, sequenceGaps, auditCoverage };
};
