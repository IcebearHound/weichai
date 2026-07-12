import type { AccountId, EventId } from "../../shared/identifiers.js";
import type { TradeEvent, TradeHandlingResult } from "./trade-types.js";

export interface TradeEventHandler {
  handle(event: TradeEvent): Promise<TradeHandlingResult>;
}

export interface TradeDeduplicationStore {
  contains(eventId: EventId): Promise<boolean>;
  record(eventId: EventId, processedAt: Date): Promise<void>;
  prune(before: Date): Promise<number>;
}

export interface AccountSequenceStore {
  lastSequence(accountId: AccountId): Promise<number | undefined>;
  recordSequence(accountId: AccountId, sequence: number): Promise<void>;
}
