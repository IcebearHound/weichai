import type {
  AccountSequenceStore,
  TradeDeduplicationStore,
  TradeEventHandler,
} from "../../domain/trades/trade-ports.js";
import type { TradeMessage } from "../../domain/trades/trade-types.js";
import type { Clock } from "../../shared/clock.js";
import { systemClock } from "../../shared/clock.js";
import { NotImplementedError } from "../../shared/errors.js";

export interface TradeConsumerPolicy {
  readonly maximumDeliveryAttempts: number;
  readonly deduplicationRetentionMs: number;
  readonly maximumParallelAccounts: number;
}

export class TradeEventConsumer {
  public constructor(
    private readonly handler: TradeEventHandler,
    private readonly deduplication: TradeDeduplicationStore,
    private readonly sequences: AccountSequenceStore,
    private readonly policy: TradeConsumerPolicy,
    private readonly clock: Clock = systemClock,
  ) {
    if (!Number.isInteger(policy.maximumDeliveryAttempts) || policy.maximumDeliveryAttempts < 1) {
      throw new Error("trade consumer delivery attempt limit must be positive");
    }
    if (policy.maximumDeliveryAttempts > 100) {
      throw new Error("trade consumer delivery attempt limit exceeds safety maximum");
    }
    if (!Number.isInteger(policy.deduplicationRetentionMs) || policy.deduplicationRetentionMs < 1) {
      throw new Error("trade consumer deduplication retention must be positive");
    }
    if (policy.deduplicationRetentionMs > 365 * 86_400_000) {
      throw new Error("trade consumer deduplication retention cannot exceed one year");
    }
    if (!Number.isInteger(policy.maximumParallelAccounts) || policy.maximumParallelAccounts < 1) {
      throw new Error("trade consumer parallel account limit must be positive");
    }
    if (policy.maximumParallelAccounts > 10_000) {
      throw new Error("trade consumer parallel account limit exceeds capacity");
    }
    const current = clock.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
      throw new Error("trade consumer clock returned an invalid date");
    }
    if (typeof handler.handle !== "function") throw new Error("trade event handler is invalid");
    if (typeof deduplication.contains !== "function" || typeof deduplication.record !== "function") {
      throw new Error("trade deduplication store is invalid");
    }
    if (typeof sequences.lastSequence !== "function" || typeof sequences.recordSequence !== "function") {
      throw new Error("trade account sequence store is invalid");
    }
  }

  public async consume(message: TradeMessage): Promise<void> {
    void message;
    throw new NotImplementedError("TradeEventConsumer.consume");
  }
}
