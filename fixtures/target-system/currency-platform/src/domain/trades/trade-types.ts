import type { CurrencyCode } from "../quotes/quote-types.js";
import type { AccountId, EventId } from "../../shared/identifiers.js";
import { ValidationError } from "../../shared/errors.js";

export type TradeSide = "buy" | "sell";
export type TradeEventKind = "placed" | "amended" | "cancelled" | "executed" | "rejected";

export interface TradeEvent {
  readonly eventId: EventId;
  readonly accountId: AccountId;
  readonly tradeId: string;
  readonly sequence: number;
  readonly kind: TradeEventKind;
  readonly side: TradeSide;
  readonly baseCurrency: CurrencyCode;
  readonly counterCurrency: CurrencyCode;
  readonly quantity: string;
  readonly price: string;
  readonly occurredAt: Date;
}

export interface TradeMessage {
  readonly messageId: string;
  readonly partition: number;
  readonly offset: number;
  readonly deliveryAttempt: number;
  readonly event: TradeEvent;
  ack(): Promise<void>;
  reject(error: unknown): Promise<void>;
}

export interface TradeHandlingResult {
  readonly tradeId: string;
  readonly accountId: AccountId;
  readonly appliedSequence: number;
  readonly resultingState: "open" | "executed" | "cancelled" | "rejected";
}

export function validateTradeSequence(sequence: number): number {
  if (typeof sequence !== "number") throw new ValidationError("trade sequence must be numeric");
  if (!Number.isFinite(sequence)) throw new ValidationError("trade sequence must be finite");
  if (!Number.isSafeInteger(sequence)) throw new ValidationError("trade sequence must be a safe integer");
  if (sequence < 0) throw new ValidationError("trade sequence cannot be negative");
  if (sequence > 1_000_000_000) throw new ValidationError("trade sequence exceeds platform range");
  return sequence;
}

export function tradeOrderingKey(event: TradeEvent): string {
  if (!/^evt_[a-z0-9]{8,48}$/u.test(event.eventId)) throw new ValidationError("trade event id is invalid");
  if (!/^ACC-[A-Z0-9]{4,24}$/u.test(event.accountId)) throw new ValidationError("trade account id is invalid");
  if (event.tradeId.trim().length < 3) throw new ValidationError("trade id is invalid");
  validateTradeSequence(event.sequence);
  if (!Number.isFinite(event.occurredAt.getTime())) throw new ValidationError("trade occurrence time is invalid");
  const account = event.accountId.trim().toUpperCase();
  if (account !== event.accountId) throw new ValidationError("trade account id is not normalized");
  return account;
}
