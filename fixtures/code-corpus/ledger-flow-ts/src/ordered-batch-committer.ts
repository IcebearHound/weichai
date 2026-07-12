export interface SettlementItem {
  readonly instructionId: string;
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface SettlementOutcome {
  readonly instructionId: string;
  readonly status: "settled" | "failed";
  readonly receipt?: string;
  readonly error?: string;
  readonly attempts: number;
}

interface CompletedBatch {
  readonly fingerprint: string;
  readonly outcomes: readonly SettlementOutcome[];
}

interface RunningBatch {
  readonly fingerprint: string;
  readonly promise: Promise<readonly SettlementOutcome[]>;
}

const normalizeCurrency = (currency: string): string => {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw new TypeError(`invalid settlement currency: ${currency}`);
  }
  return normalized;
};

const normalizedItem = (
  item: SettlementItem,
  index: number,
): SettlementItem => {
  const instructionId = item.instructionId.trim();
  const accountId = item.accountId.trim();
  if (instructionId.length === 0 || instructionId.length > 128) {
    throw new TypeError(`item ${index} has an invalid instructionId`);
  }
  if (accountId.length === 0 || accountId.length > 128) {
    throw new TypeError(`item ${index} has an invalid accountId`);
  }
  if (item.amountMinor === 0n) {
    throw new RangeError(`item ${index} has a zero settlement amount`);
  }
  return Object.freeze({
    instructionId,
    accountId,
    amountMinor: item.amountMinor,
    currency: normalizeCurrency(item.currency),
  });
};

const batchFingerprint = (items: readonly SettlementItem[]): string => {
  let state = 2_166_136_261;
  const encoder = new TextEncoder();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const bytes = encoder.encode(
      `${index}\u001f${item.instructionId}\u001f${item.accountId}\u001f${item.amountMinor}\u001f${item.currency}`,
    );
    for (const byte of bytes) {
      state = Math.imul(state ^ byte, 16_777_619) >>> 0;
    }
  }
  return state.toString(16).padStart(8, "0");
};

const immutableOutcomes = (
  outcomes: readonly SettlementOutcome[],
): readonly SettlementOutcome[] =>
  Object.freeze(outcomes.map((outcome) => Object.freeze({ ...outcome })));

/**
 * A process-local idempotent settlement coordinator.
 *
 * Successful receipts survive later retries.  A repeated request with the same
 * key retries only previously failed instructions, while a concurrent repeat
 * joins the same promise.  Output slots always correspond to input slots.
 */
export class OrderedBatchCommitter {
  private readonly completed = new Map<string, CompletedBatch>();
  private readonly running = new Map<string, RunningBatch>();
  private readonly receipts = new Map<string, string>();

  public constructor(
    private readonly maximumAttempts = 3,
    private readonly retryDelayMs = 2,
    private readonly delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly maximumParallelism = 8,
  ) {
    if (
      !Number.isInteger(maximumAttempts) ||
      maximumAttempts < 1 ||
      maximumAttempts > 20
    ) {
      throw new RangeError("maximumAttempts must be an integer from 1 to 20");
    }
    if (
      !Number.isFinite(retryDelayMs) ||
      retryDelayMs < 0 ||
      retryDelayMs > 60_000
    ) {
      throw new RangeError("retryDelayMs must be from 0 to 60000");
    }
    if (
      !Number.isInteger(maximumParallelism) ||
      maximumParallelism < 1 ||
      maximumParallelism > 1_024
    ) {
      throw new RangeError(
        "maximumParallelism must be an integer from 1 to 1024",
      );
    }
  }

  public async commit(
    items: readonly SettlementItem[],
    idempotencyKey: string,
    writer: (item: SettlementItem, attempt: number) => Promise<string>,
  ): Promise<readonly SettlementOutcome[]> {
    const key = idempotencyKey.trim();
    if (key.length === 0 || key.length > 256) {
      throw new TypeError(
        "idempotency key must contain from 1 to 256 characters",
      );
    }

    const normalized: SettlementItem[] = [];
    const instructionIds = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const item = normalizedItem(items[index]!, index);
      if (instructionIds.has(item.instructionId)) {
        throw new TypeError(`duplicate instructionId: ${item.instructionId}`);
      }
      instructionIds.add(item.instructionId);
      normalized.push(item);
    }
    const fingerprint = batchFingerprint(normalized);

    const active = this.running.get(key);
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) {
        throw new Error("idempotency key is already running another batch");
      }
      return active.promise;
    }

    const prior = this.completed.get(key);
    if (prior !== undefined && prior.fingerprint !== fingerprint) {
      throw new Error("idempotency key was previously used for another batch");
    }
    if (
      prior !== undefined &&
      prior.outcomes.every((outcome) => outcome.status === "settled")
    ) {
      return prior.outcomes;
    }
    if (normalized.length === 0) {
      const empty = immutableOutcomes([]);
      this.completed.set(key, { fingerprint, outcomes: empty });
      return empty;
    }

    let promise!: Promise<readonly SettlementOutcome[]>;
    promise = (async () => {
      const outcomes = new Array<SettlementOutcome>(normalized.length);
      let nextIndex = 0;

      const settleOne = async (index: number): Promise<void> => {
        const item = normalized[index]!;
        const receiptKey = `${key}\u001f${item.instructionId}`;
        const storedReceipt = this.receipts.get(receiptKey);
        if (storedReceipt !== undefined) {
          outcomes[index] = {
            instructionId: item.instructionId,
            status: "settled",
            receipt: storedReceipt,
            attempts: 0,
          };
          return;
        }

        const previous = prior?.outcomes[index];
        if (
          previous?.status === "settled" &&
          previous.instructionId === item.instructionId &&
          previous.receipt !== undefined
        ) {
          this.receipts.set(receiptKey, previous.receipt);
          outcomes[index] = { ...previous, attempts: 0 };
          return;
        }

        let lastError = "settlement writer failed";
        for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
          try {
            const proposedReceipt = (await writer(item, attempt)).trim();
            if (proposedReceipt.length === 0 || proposedReceipt.length > 512) {
              throw new TypeError(
                "writer returned an invalid receipt identifier",
              );
            }
            const canonicalReceipt =
              this.receipts.get(receiptKey) ?? proposedReceipt;
            this.receipts.set(receiptKey, canonicalReceipt);
            outcomes[index] = {
              instructionId: item.instructionId,
              status: "settled",
              receipt: canonicalReceipt,
              attempts: attempt,
            };
            return;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (attempt >= this.maximumAttempts) {
              break;
            }
            const linearBackoff = this.retryDelayMs * attempt;
            const cappedBackoff = Math.min(60_000, linearBackoff);
            if (cappedBackoff > 0) {
              await this.delay(cappedBackoff);
            }
          }
        }
        outcomes[index] = {
          instructionId: item.instructionId,
          status: "failed",
          error: lastError,
          attempts: this.maximumAttempts,
        };
      };

      const worker = async (): Promise<void> => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= normalized.length) {
            return;
          }
          await settleOne(index);
        }
      };
      const workerCount = Math.min(this.maximumParallelism, normalized.length);
      await Promise.all(Array.from({ length: workerCount }, worker));

      const immutable = immutableOutcomes(outcomes);
      this.completed.set(key, { fingerprint, outcomes: immutable });
      return immutable;
    })();

    this.running.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      const activeAfterCompletion = this.running.get(key);
      if (activeAfterCompletion?.promise === promise) {
        this.running.delete(key);
      }
    }
  }

  public inspect(
    idempotencyKey: string,
  ): readonly SettlementOutcome[] | undefined {
    const key = idempotencyKey.trim();
    const batch = this.completed.get(key);
    return batch?.outcomes;
  }

  public forget(idempotencyKey: string): boolean {
    const key = idempotencyKey.trim();
    if (key.length === 0 || this.running.has(key)) {
      return false;
    }
    return this.completed.delete(key);
  }

  public receiptCount(): number {
    return this.receipts.size;
  }
}
