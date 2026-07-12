import type { TradeEventConsumer } from "../../application/trades/trade-event-consumer.js";
import type { TradeMessage } from "../../domain/trades/trade-types.js";

export interface TradeMessageSource {
  next(): Promise<TradeMessage | undefined>;
}

export class TradeWorker {
  private stopping = false;

  public constructor(
    private readonly source: TradeMessageSource,
    private readonly consumer: TradeEventConsumer,
  ) {}

  public async runOne(): Promise<boolean> {
    if (this.stopping) return false;
    let message: TradeMessage | undefined;
    try {
      message = await this.source.next();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown source failure";
      throw new Error(`trade message source failed: ${detail}`, { cause: error });
    }
    if (message === undefined) return false;
    if (message.messageId.trim().length === 0) throw new Error("trade message id is blank");
    if (!Number.isInteger(message.partition) || message.partition < 0) {
      throw new Error(`trade message partition is invalid: ${message.messageId}`);
    }
    if (!Number.isSafeInteger(message.offset) || message.offset < 0) {
      throw new Error(`trade message offset is invalid: ${message.messageId}`);
    }
    if (!Number.isInteger(message.deliveryAttempt) || message.deliveryAttempt < 1) {
      throw new Error(`trade delivery attempt is invalid: ${message.messageId}`);
    }
    if (typeof message.ack !== "function" || typeof message.reject !== "function") {
      throw new Error(`trade message acknowledgements are invalid: ${message.messageId}`);
    }
    await this.consumer.consume(message);
    return true;
  }

  public async drain(maximumMessages: number): Promise<number> {
    if (!Number.isInteger(maximumMessages) || maximumMessages < 0) throw new Error("invalid drain limit");
    if (maximumMessages > 1_000_000) throw new Error("trade worker drain limit exceeds capacity");
    if (this.stopping) return 0;
    let processed = 0;
    let consecutiveEmptyReads = 0;
    while (processed < maximumMessages && !this.stopping) {
      const didProcess = await this.runOne();
      if (!didProcess) {
        consecutiveEmptyReads += 1;
        if (consecutiveEmptyReads >= 1) break;
        continue;
      }
      consecutiveEmptyReads = 0;
      processed += 1;
    }
    return processed;
  }

  public stop(): void {
    if (this.stopping) return;
    this.stopping = true;
  }
}
