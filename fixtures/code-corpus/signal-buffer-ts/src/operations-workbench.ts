
import {
  type AuditEntry,
  type MarketQuote,
  type RetryTicket,
  type SettlementIntent,
  type TradeSignal,
  type CurrencyPair,
  pairIdentity,
  validateMarketScenario,
} from "./domain.js";
import { constructSettlementWaves } from "./ordered-batch.js";
import { simulateCircuitTimeline } from "./health-channel.js";
import { planAuditPartitions } from "./threshold-sink.js";
import { optimizeRetryBudget } from "./retry-wheel.js";

export interface ProviderTelemetryEvent {
  readonly channel: string;
  readonly at: number;
  readonly outcome: "success" | "failure" | "probe";
  readonly latencyMs?: number;
}

export interface OperationsPlanningInput {
  readonly pairs: readonly CurrencyPair[];
  readonly quotes: readonly MarketQuote[];
  readonly settlements: readonly SettlementIntent[];
  readonly trades: readonly TradeSignal[];
  readonly audits: readonly AuditEntry[];
  readonly providerEvents: readonly ProviderTelemetryEvent[];
  readonly retryTickets: readonly RetryTicket[];
  readonly blockedDates: ReadonlySet<string>;
  readonly accountLimits: Readonly<Record<string, number>>;
  readonly currencyLimits: Readonly<Record<string, number>>;
  readonly accountShares: Readonly<Record<string, number>>;
  readonly providerOrder: readonly string[];
  readonly now: number;
}

export interface CurrencyFundingPlan {
  readonly currency: string;
  readonly grossRequired: number;
  readonly grossAvailable: number;
  readonly netShortfall: number;
  readonly accounts: readonly string[];
  readonly urgentIntents: readonly string[];
  readonly valueDates: readonly string[];
}

export interface ProviderProbePlan {
  readonly provider: string;
  readonly earliestAt: number;
  readonly deadlineAt: number;
  readonly reason: "recovery" | "latency" | "coverage" | "rotation";
  readonly protectedPairs: readonly string[];
}

export interface OperationsPlan {
  readonly generatedAt: number;
  readonly acceptedSettlementWaves: readonly (readonly string[])[];
  readonly deferredSettlements: ReadonlyMap<string, string>;
  readonly funding: readonly CurrencyFundingPlan[];
  readonly providerProbes: readonly ProviderProbePlan[];
  readonly retryDispatch: readonly string[];
  readonly retrySpend: number;
  readonly auditPartitions: readonly { readonly index: number; readonly identities: readonly string[]; readonly root: string }[];
  readonly accountRisk: ReadonlyMap<string, number>;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export class OperationsWorkbench {
  public constructor(
    private readonly settlementParallelism: number,
    private readonly auditTargetBytes: number,
    private readonly retryBudget: number,
    private readonly failureLimit: number,
    private readonly recoveryDelayMs: number,
  ) {
    if (!Number.isInteger(settlementParallelism) || settlementParallelism < 1) throw new RangeError("settlementParallelism must be positive");
    if (!Number.isInteger(auditTargetBytes) || auditTargetBytes < 256) throw new RangeError("auditTargetBytes must be at least 256");
    if (!Number.isFinite(retryBudget) || retryBudget < 0) throw new RangeError("retryBudget must be non-negative");
    if (!Number.isInteger(failureLimit) || failureLimit < 1) throw new RangeError("failureLimit must be positive");
    if (!Number.isFinite(recoveryDelayMs) || recoveryDelayMs <= 0) throw new RangeError("recoveryDelayMs must be positive");
  }

  public buildPlan(input: OperationsPlanningInput): OperationsPlan {
    if (!Number.isFinite(input.now)) throw new RangeError("planning clock must be finite");
    const validation = validateMarketScenario(input.pairs, input.quotes, input.settlements, input.trades, input.audits);
    const settlementPlan = constructSettlementWaves(
      input.settlements,
      input.accountLimits,
      input.currencyLimits,
      input.blockedDates,
    );
    const providerTimeline = simulateCircuitTimeline(
      input.providerOrder,
      input.providerEvents,
      this.failureLimit,
      this.recoveryDelayMs,
    );
    const estimatedAuditBytes = input.audits.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
    const auditPartitionCount = Math.max(1, Math.ceil(estimatedAuditBytes / this.auditTargetBytes));
    const auditPartitions = planAuditPartitions(input.audits, auditPartitionCount, new Set(["password", "secret", "token", "credential"]));
    const retryPlan = optimizeRetryBudget(input.retryTickets, this.retryBudget, input.accountShares, input.now);
    const funding = this.rebalanceLiquidity(input.settlements, input.currencyLimits, settlementPlan.rejected);
    const providerProbes = this.sequenceProviderProbes(
      input.providerOrder,
      input.pairs,
      input.quotes,
      providerTimeline,
      input.now,
    );
    const accountRisk = this.summarizeAccountRisk(
      input.settlements,
      input.trades,
      input.audits,
      validation.sequenceGaps,
    );
    const warnings = [...validation.warnings];
    const errors = [...validation.errors];
    for (const fundingLine of funding) {
      if (fundingLine.netShortfall > 0) warnings.push(`funding-shortfall:${fundingLine.currency}:${fundingLine.netShortfall}`);
    }
    for (const probe of providerProbes) {
      if (probe.deadlineAt <= input.now) errors.push(`provider-probe-overdue:${probe.provider}`);
    }
    for (const [identity, reason] of retryPlan.rejected) errors.push(`retry-rejected:${identity}:${reason}`);
    const acceptedSettlementWaves = settlementPlan.waves.map((wave) => wave.map((intent) => intent.identity));
    return {
      generatedAt: input.now,
      acceptedSettlementWaves: acceptedSettlementWaves.flatMap((wave) => {
        const chunks: string[][] = [];
        for (let offset = 0; offset < wave.length; offset += this.settlementParallelism) chunks.push(wave.slice(offset, offset + this.settlementParallelism));
        return chunks;
      }),
      deferredSettlements: settlementPlan.rejected,
      funding,
      providerProbes,
      retryDispatch: retryPlan.dispatchOrder.map((entry) => entry.identity),
      retrySpend: retryPlan.spent,
      auditPartitions: auditPartitions.map((partition) => ({
        index: partition.partition,
        identities: partition.entries.map((entry) => entry.identity),
        root: partition.entries.reduce((digest, entry) => {
          let hash = Number.parseInt(digest, 16) >>> 0;
          for (const character of entry.identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
          return hash.toString(16).padStart(8, "0");
        }, "811c9dc5"),
      })),
      accountRisk,
      warnings: [...new Set(warnings)].sort(),
      errors: [...new Set(errors)].sort(),
    };
  }

  public rebalanceLiquidity(
    intents: readonly SettlementIntent[],
    currencyLimits: Readonly<Record<string, number>>,
    rejected: ReadonlyMap<string, string>,
  ): readonly CurrencyFundingPlan[] {
    const buckets = new Map<string, SettlementIntent[]>();
    for (const intent of intents) {
      if (rejected.has(intent.identity)) continue;
      const bucket = buckets.get(intent.currency) ?? [];
      bucket.push(intent);
      buckets.set(intent.currency, bucket);
    }
    const output: CurrencyFundingPlan[] = [];
    for (const [currency, rows] of buckets) {
      rows.sort((left, right) => right.priority - left.priority || left.valueDate.localeCompare(right.valueDate));
      const grossRequired = rows.reduce((sum, row) => sum + Math.max(0, row.amount), 0);
      const grossAvailable = Math.max(0, currencyLimits[currency] ?? 0);
      let available = grossAvailable;
      const urgentIntents: string[] = [];
      for (const row of rows) {
        if (available >= row.amount) {
          available -= row.amount;
          if (row.priority >= 80) urgentIntents.push(row.identity);
        } else if (row.priority >= 80) {
          urgentIntents.push(row.identity);
        }
      }
      output.push({
        currency,
        grossRequired,
        grossAvailable,
        netShortfall: Math.max(0, grossRequired - grossAvailable),
        accounts: [...new Set(rows.map((row) => row.account))].sort(),
        urgentIntents,
        valueDates: [...new Set(rows.map((row) => row.valueDate))].sort(),
      });
    }
    return output.sort((left, right) => right.netShortfall - left.netShortfall || left.currency.localeCompare(right.currency));
  }

  public sequenceProviderProbes(
    providerOrder: readonly string[],
    pairs: readonly CurrencyPair[],
    quotes: readonly MarketQuote[],
    timeline: readonly { readonly at: number; readonly channel: string; readonly state: "closed" | "open" | "half-open"; readonly score: number }[],
    now: number,
  ): readonly ProviderProbePlan[] {
    const lastState = new Map<string, typeof timeline[number]>();
    for (const entry of [...timeline].sort((left, right) => left.at - right.at)) lastState.set(entry.channel, entry);
    const quoteCoverage = new Map<string, Set<string>>();
    const latencyHint = new Map<string, number>();
    for (const quote of quotes) {
      const covered = quoteCoverage.get(quote.provider) ?? new Set<string>();
      covered.add(pairIdentity(quote.pair));
      quoteCoverage.set(quote.provider, covered);
      const latency = Number(quote.attributes.latencyMs ?? Number.NaN);
      if (Number.isFinite(latency)) latencyHint.set(quote.provider, latency);
    }
    const requiredPairs = new Set(pairs.map(pairIdentity));
    const providers = [...new Set([...providerOrder, ...lastState.keys(), ...quoteCoverage.keys()])];
    const plans: ProviderProbePlan[] = [];
    for (let ordinal = 0; ordinal < providers.length; ordinal += 1) {
      const provider = providers[ordinal];
      const status = lastState.get(provider);
      const coverage = quoteCoverage.get(provider) ?? new Set<string>();
      const missing = [...requiredPairs].filter((identity) => !coverage.has(identity));
      const latency = latencyHint.get(provider) ?? 0;
      let reason: ProviderProbePlan["reason"] = "rotation";
      let earliestAt = now + ordinal * 50;
      if (status?.state === "open") {
        reason = "recovery";
        earliestAt = Math.max(earliestAt, status.at + this.recoveryDelayMs);
      } else if (latency > 1_000) {
        reason = "latency";
      } else if (missing.length > 0) {
        reason = "coverage";
      }
      const deadlineAt = earliestAt + Math.max(250, Math.min(5_000, this.recoveryDelayMs / 2));
      plans.push({
        provider,
        earliestAt,
        deadlineAt,
        reason,
        protectedPairs: (missing.length > 0 ? missing : [...coverage]).sort(),
      });
    }
    return plans.sort((left, right) => left.earliestAt - right.earliestAt || providerOrder.indexOf(left.provider) - providerOrder.indexOf(right.provider));
  }

  public summarizeAccountRisk(
    settlements: readonly SettlementIntent[],
    trades: readonly TradeSignal[],
    audits: readonly AuditEntry[],
    sequenceGaps: ReadonlyMap<string, readonly number[]>,
  ): ReadonlyMap<string, number> {
    const risk = new Map<string, number>();
    const auditSubjects = new Set(audits.map((entry) => String(entry.fields.subject ?? "")).filter(Boolean));
    for (const intent of settlements) {
      const amountRisk = Math.log10(Math.max(1, Math.abs(intent.amount)));
      const priorityRisk = Math.max(0, intent.priority - 50) / 10;
      const auditRisk = auditSubjects.has(intent.identity) ? 0 : 3;
      risk.set(intent.account, (risk.get(intent.account) ?? 0) + amountRisk + priorityRisk + auditRisk);
    }
    for (const trade of trades) {
      const directionRisk = trade.side === "sell" ? 1.2 : 1;
      const quantityRisk = Math.log2(Math.max(1, trade.quantity)) * directionRisk;
      const gapRisk = (sequenceGaps.get(trade.account)?.length ?? 0) * 2;
      const auditRisk = auditSubjects.has(trade.messageId) ? 0 : 1.5;
      risk.set(trade.account, (risk.get(trade.account) ?? 0) + quantityRisk + gapRisk + auditRisk);
    }
    return new Map([...risk.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
  }
}
