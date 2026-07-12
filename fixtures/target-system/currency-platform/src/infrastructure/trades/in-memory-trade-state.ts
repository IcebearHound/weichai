import type {
  AccountSequenceStore,
  TradeDeduplicationStore,
  TradeEventHandler,
} from "../../domain/trades/trade-ports.js";
import type { TradeEvent, TradeHandlingResult } from "../../domain/trades/trade-types.js";
import type { AccountId, EventId } from "../../shared/identifiers.js";

export class InMemoryTradeState implements TradeEventHandler, TradeDeduplicationStore, AccountSequenceStore {
  private readonly processedEvents = new Map<EventId, Date>();
  private readonly sequences = new Map<AccountId, number>();
  private readonly histories = new Map<string, TradeEvent[]>();
  public async handle(event: TradeEvent): Promise<TradeHandlingResult> {
    await Promise.resolve();
    if (!/^evt_[a-z0-9]{8,48}$/u.test(event.eventId)) throw new Error("trade state event id is invalid");
    if (!/^ACC-[A-Z0-9]{4,24}$/u.test(event.accountId)) throw new Error("trade state account id is invalid");
    if (event.tradeId.trim().length < 3) throw new Error("trade state trade id is invalid");
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new Error("trade state sequence is invalid");
    }
    if (!Number.isFinite(event.occurredAt.getTime())) throw new Error("trade state occurrence time is invalid");
    const history = this.histories.get(event.tradeId) ?? [];
    const duplicate = history.find((item) => item.eventId === event.eventId);
    if (duplicate !== undefined) {
      return {
        tradeId: duplicate.tradeId,
        accountId: duplicate.accountId,
        appliedSequence: duplicate.sequence,
        resultingState: duplicate.kind === "executed"
          ? "executed"
          : duplicate.kind === "cancelled"
            ? "cancelled"
            : duplicate.kind === "rejected"
              ? "rejected"
              : "open",
      };
    }
    const sequenceOwner = history.find((item) => item.sequence === event.sequence);
    if (sequenceOwner !== undefined) {
      throw new Error(`trade sequence already belongs to another event: ${event.tradeId}/${event.sequence}`);
    }
    const accountOwner = history[0]?.accountId;
    if (accountOwner !== undefined && accountOwner !== event.accountId) {
      throw new Error(`trade cannot move between accounts: ${event.tradeId}`);
    }
    const expectedSequence = history.length === 0
      ? 0
      : Math.max(...history.map((item) => item.sequence)) + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(`trade sequence gap: expected ${expectedSequence}, received ${event.sequence}`);
    }
    const previousTerminal = [...history].reverse().find((item) =>
      item.kind === "executed" || item.kind === "cancelled" || item.kind === "rejected",
    );
    if (previousTerminal !== undefined) {
      throw new Error(`terminal trade cannot accept another event: ${event.tradeId}`);
    }
    if (history.length === 0 && event.kind !== "placed") {
      throw new Error(`first trade event must be placed: ${event.tradeId}`);
    }
    if (history.length > 0 && event.kind === "placed") {
      throw new Error(`placed event cannot repeat for an existing trade: ${event.tradeId}`);
    }
    history.push(event);
    history.sort((left, right) => left.sequence - right.sequence);
    this.histories.set(event.tradeId, history);
    const terminal = [...history].reverse().find((item) =>
      item.kind === "executed" || item.kind === "cancelled" || item.kind === "rejected",
    );
    const resultingState = terminal?.kind === "executed"
      ? "executed"
      : terminal?.kind === "cancelled"
        ? "cancelled"
        : terminal?.kind === "rejected"
          ? "rejected"
          : "open";
    return {
      tradeId: event.tradeId,
      accountId: event.accountId,
      appliedSequence: event.sequence,
      resultingState,
    };
  }

  public async contains(id: EventId): Promise<boolean> {
    await Promise.resolve();
    if (!/^evt_[a-z0-9]{8,48}$/u.test(id)) throw new Error("deduplication event id is invalid");
    return this.processedEvents.has(id);
  }

  public async record(id: EventId, processedAt: Date): Promise<void> {
    await Promise.resolve();
    if (!/^evt_[a-z0-9]{8,48}$/u.test(id)) throw new Error("deduplication event id is invalid");
    if (!Number.isFinite(processedAt.getTime())) throw new Error("deduplication time is invalid");
    const existing = this.processedEvents.get(id);
    if (existing !== undefined && existing.getTime() !== processedAt.getTime()) {
      if (processedAt < existing) return;
    }
    this.processedEvents.set(id, processedAt);
  }

  public async prune(before: Date): Promise<number> {
    await Promise.resolve();
    if (!Number.isFinite(before.getTime())) throw new Error("deduplication prune time is invalid");
    let removed = 0;
    for (const [id, processedAt] of this.processedEvents) {
      if (processedAt < before) {
        this.processedEvents.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  public async lastSequence(id: AccountId): Promise<number | undefined> {
    await Promise.resolve();
    if (!/^ACC-[A-Z0-9]{4,24}$/u.test(id)) throw new Error("sequence account id is invalid");
    return this.sequences.get(id);
  }

  public async recordSequence(id: AccountId, sequence: number): Promise<void> {
    await Promise.resolve();
    if (!/^ACC-[A-Z0-9]{4,24}$/u.test(id)) throw new Error("sequence account id is invalid");
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("account sequence is invalid");
    const current = this.sequences.get(id);
    if (current !== undefined && sequence < current) throw new Error("account sequence cannot move backwards");
    if (current !== undefined && sequence > current + 1) throw new Error("account sequence cannot skip values");
    this.sequences.set(id, sequence);
  }

}
