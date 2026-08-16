/**
 * 进程内的幂等结算协调器:按幂等键合并批次提交,支持失败重试与并发去重。
 */

/** 单条结算指令:目标账户、金额(最小货币单位)与币种。 */
export interface SettlementItem {
  readonly instructionId: string;
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
}

/** 单条指令的结算结果:成功携带凭据,失败携带错误信息与尝试次数。 */
export interface SettlementOutcome {
  readonly instructionId: string;
  readonly status: "settled" | "failed";
  readonly receipt?: string;
  readonly error?: string;
  readonly attempts: number;
}

// 已完成批次的内部记录:指纹用于校验幂等键是否复用了不同内容。
interface CompletedBatch {
  readonly fingerprint: string;
  readonly outcomes: readonly SettlementOutcome[];
}

// 执行中批次的内部记录:指纹 + 共享 promise,并发重复请求直接复用。
interface RunningBatch {
  readonly fingerprint: string;
  readonly promise: Promise<readonly SettlementOutcome[]>;
}

/** 校验并规范化币种代码:必须为三位大写字母。 */
const normalizeCurrency = (currency: string): string => {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw new TypeError(`invalid settlement currency: ${currency}`);
  }
  return normalized;
};

/** 校验并规范化一条指令:ID/账户非空且长度受限,金额不得为零。 */
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

/**
 * 计算批次的指纹:按位置、字段内容逐字节滚动哈希。
 * 用于检测“同一幂等键先后提交了不同内容”的误用。
 */
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

/** 冻结结果列表及其中的每个结果,防止外部修改历史。 */
const immutableOutcomes = (
  outcomes: readonly SettlementOutcome[],
): readonly SettlementOutcome[] =>
  Object.freeze(outcomes.map((outcome) => Object.freeze({ ...outcome })));

/**
 * 进程内的幂等结算协调器。
 *
 * 成功的凭据在后续重试中依然有效:同一幂等键的重复请求只会重试此前
 * 失败的指令;并发重复请求则复用同一 promise。输出槽位与输入槽位一一对应,
 * 便于调用方按位置对齐结果。
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

  /**
   * 以幂等键提交一批指令并返回逐个结果。
   *
   * 流程:校验并规范化指令、计算指纹;若该键已在运行且内容一致则加入其
   * promise;若已完成且全部成功则直接返回缓存;否则以受限并发执行 writer,
   * 失败指令按线性退避重试。
   */
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
    // 并发重复请求:内容一致时直接加入同一 promise,避免同一批次执行两次。
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) {
        throw new Error("idempotency key is already running another batch");
      }
      return active.promise;
    }

    const prior = this.completed.get(key);
    // 已完成批次只补重试失败项;全部成功的批次直接返回缓存结果。
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
        // 幂等凭据:同一指令此前若已成功,直接复用凭据,不再调用 writer。
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
            // 线性退避:延迟随尝试次数递增,并封顶 60 秒防止长时间阻塞。
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
        // 无锁任务分发:各 worker 从共享计数器取下一个下标,天然避免
        // 重复处理,同时保证槽位与输入顺序一致。
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

  /**
   * 查询已完成的批次结果;未提交过或仍在运行的键返回 undefined。
   */
  public inspect(
    idempotencyKey: string,
  ): readonly SettlementOutcome[] | undefined {
    const key = idempotencyKey.trim();
    const batch = this.completed.get(key);
    return batch?.outcomes;
  }

  /**
   * 遗忘一个幂等键的已完成结果;正在运行的键不可遗忘,返回是否成功。
   */
  public forget(idempotencyKey: string): boolean {
    const key = idempotencyKey.trim();
    if (key.length === 0 || this.running.has(key)) {
      return false;
    }
    return this.completed.delete(key);
  }

  /** 当前累计的成功凭据数量(供监控与泄漏排查)。 */
  public receiptCount(): number {
    return this.receipts.size;
  }
}
