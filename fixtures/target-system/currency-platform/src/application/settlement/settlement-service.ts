import type { Clock, Sleeper } from "../../shared/clock.js";
import { systemClock, systemSleeper } from "../../shared/clock.js";
import { NotImplementedError } from "../../shared/errors.js";
import type {
  ReceiptRepository,
  SettlementFailureClassifier,
  SettlementProcessor,
} from "../../domain/settlement/settlement-ports.js";
import type {
  SettlementBatchRequest,
  SettlementBatchResult,
} from "../../domain/settlement/settlement-types.js";

export interface SettlementRetryPolicy {
  readonly firstDelayMs: number;
  readonly multiplier: number;
  readonly maximumDelayMs: number;
}

export class SettlementService {
  public constructor(
    private readonly processor: SettlementProcessor,
    private readonly receipts: ReceiptRepository,
    private readonly classifier: SettlementFailureClassifier,
    private readonly retryPolicy: SettlementRetryPolicy,
    private readonly clock: Clock = systemClock,
    private readonly sleeper: Sleeper = systemSleeper,
  ) {
    if (!Number.isInteger(retryPolicy.firstDelayMs) || retryPolicy.firstDelayMs < 0) {
      throw new Error("settlement first retry delay cannot be negative");
    }
    if (retryPolicy.firstDelayMs > 3_600_000) {
      throw new Error("settlement first retry delay cannot exceed one hour");
    }
    if (!Number.isFinite(retryPolicy.multiplier) || retryPolicy.multiplier < 1) {
      throw new Error("settlement retry multiplier must be at least one");
    }
    if (retryPolicy.multiplier > 10) throw new Error("settlement retry multiplier cannot exceed ten");
    if (!Number.isInteger(retryPolicy.maximumDelayMs) || retryPolicy.maximumDelayMs < 0) {
      throw new Error("settlement maximum retry delay cannot be negative");
    }
    if (retryPolicy.maximumDelayMs < retryPolicy.firstDelayMs) {
      throw new Error("settlement maximum delay cannot be below first delay");
    }
    if (retryPolicy.maximumDelayMs > 86_400_000) {
      throw new Error("settlement maximum retry delay cannot exceed one day");
    }
    const current = clock.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
      throw new Error("settlement clock returned an invalid date");
    }
    const sampleClassification = classifier.classify(new Error("settlement-service-construction-check"));
    if (sampleClassification.code.trim().length === 0) {
      throw new Error("settlement failure classifier returned a blank code");
    }
    if (sampleClassification.message.trim().length === 0) {
      throw new Error("settlement failure classifier returned a blank message");
    }
    if (typeof processor.process !== "function") throw new Error("settlement processor is invalid");
    if (typeof receipts.find !== "function" || typeof receipts.save !== "function") {
      throw new Error("settlement receipt repository is invalid");
    }
    if (typeof sleeper.sleep !== "function") throw new Error("settlement sleeper is invalid");
  }

  public async settleBatch(request: SettlementBatchRequest): Promise<SettlementBatchResult> {
    void request;
    throw new NotImplementedError("SettlementService.settleBatch");
  }
}
