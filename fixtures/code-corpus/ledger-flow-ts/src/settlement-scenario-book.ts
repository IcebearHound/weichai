/**
 * 确定性合成结算场景的构建与演练(集成取向的固件模块)。
 *
 * 校验多边头寸簿、推导双边指令、附加费用与路由,以受限并发执行结果工作,
 * 并在汇总时保留部分失败而不隐藏,供端到端测试与基准演练使用。
 */

/** 场景中的单条净头寸:账户、币种、最小货币单位金额与优先级。 */
export interface ScenarioPosition {
  readonly account: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly priority: number;
}

/** 单币种费用规则:按基点比例 + 固定费用,且费用在 [minimumFeeMinor, maximumFeeMinor] 区间内。 */
export interface ScenarioFeeRule {
  readonly currency: string;
  readonly basisPoints: number;
  readonly fixedMinor: bigint;
  readonly minimumFeeMinor: bigint;
  readonly maximumFeeMinor?: bigint;
}

/** 场景定义:头寸簿、费用规则、账户路由与可选的阻断账户列表。 */
export interface ScenarioDefinition {
  readonly scenarioId: string;
  readonly positions: readonly ScenarioPosition[];
  readonly feeRules: readonly ScenarioFeeRule[];
  readonly accountRoutes: Readonly<Record<string, string>>;
  readonly blockedAccounts?: readonly string[];
}

/** 编译产出的单条指令:本金、费用、总借项与路由,槽位与输入序号一致。 */
export interface ScenarioInstruction {
  readonly index: number;
  readonly instructionId: string;
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly principalMinor: bigint;
  readonly feeMinor: bigint;
  readonly debitMinor: bigint;
  readonly route: readonly string[];
  readonly priority: number;
}

/** 场景编译结果:指令列表、内容指纹、按币种未轧差金额与账户统计。 */
export interface CompiledScenario {
  readonly scenarioId: string;
  readonly fingerprint: string;
  readonly instructions: readonly ScenarioInstruction[];
  readonly currencies: readonly string[];
  readonly accountCount: number;
  readonly grossPrincipalMinor: bigint;
  readonly totalFeesMinor: bigint;
  readonly unmatchedByCurrency: Readonly<Record<string, bigint>>;
}

/** 单条指令的执行记录:状态(成功/失败/阻断)、尝试次数与耗时。 */
export interface ScenarioExecutionRecord {
  readonly index: number;
  readonly instructionId: string;
  readonly currency: string;
  readonly from: string;
  readonly to: string;
  readonly principalMinor: bigint;
  readonly feeMinor: bigint;
  readonly status: "settled" | "failed" | "blocked";
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly receipt?: string;
  readonly error?: string;
}

/** 执行汇总:成功/失败/阻断计数、凭据去重、重试直方图与延迟分位。 */
export interface ScenarioSummary {
  readonly instructionCount: number;
  readonly settled: number;
  readonly failed: number;
  readonly blocked: number;
  readonly receipts: number;
  readonly duplicateReceipts: readonly string[];
  readonly attempts: number;
  readonly retryHistogram: Readonly<Record<string, number>>;
  readonly settledPrincipalByCurrency: Readonly<Record<string, bigint>>;
  readonly feeByCurrency: Readonly<Record<string, bigint>>;
  readonly debitByAccount: Readonly<Record<string, bigint>>;
  readonly creditByAccount: Readonly<Record<string, bigint>>;
  readonly errorCounts: Readonly<Record<string, number>>;
  readonly minimumLatencyMs: number;
  readonly maximumLatencyMs: number;
  readonly averageLatencyMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
}

// 轧差过程中的可变余额(账户内同币种多笔头寸先合并)。
interface MutableBalance {
  account: string;
  amountMinor: bigint;
  priority: number;
}

/**
 * Builds and exercises deterministic synthetic settlement scenarios.
 *
 * 该模块是面向集成的固件:校验多边头寸簿、推导双边指令、附加费用与路由,
 * 以受限并发执行结果工作,并在汇总时保留部分失败而不隐藏。
 */
export class SettlementScenarioBook {
  public constructor(
    private readonly maximumAttempts = 3,
    private readonly clock: () => number = Date.now,
  ) {
    if (
      !Number.isInteger(maximumAttempts) ||
      maximumAttempts < 1 ||
      maximumAttempts > 20
    ) {
      throw new RangeError("maximumAttempts must be an integer from 1 to 20");
    }
    if (!Number.isFinite(clock())) {
      throw new RangeError("clock must return a finite epoch value");
    }
  }

  /**
   * 编译场景定义:校验头寸/费率/路由,按币种轧差出双边指令并附加费用与
   * 路由,最后生成内容指纹(供幂等缓存与对比)。
   */
  public compile(definition: ScenarioDefinition): CompiledScenario {
    const scenarioId = definition.scenarioId.normalize("NFKC").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(scenarioId)) {
      throw new TypeError("scenarioId is invalid");
    }

    const blockedAccounts = new Set<string>();
    for (const rawAccount of definition.blockedAccounts ?? []) {
      const account = rawAccount.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(account)) {
        throw new TypeError(`invalid blocked account: ${rawAccount}`);
      }
      blockedAccounts.add(account);
    }

    const routes = new Map<string, readonly string[]>();
    for (const [rawAccount, encodedRoute] of Object.entries(
      definition.accountRoutes,
    )) {
      const account = rawAccount.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(account)) {
        throw new TypeError(`invalid route account: ${rawAccount}`);
      }
      const hops = encodedRoute
        .split(/(?:->|\/|:)/u)
        .map((hop) => hop.trim().toUpperCase())
        .filter((hop) => hop.length > 0);
      if (
        hops.length < 2 ||
        hops.some((hop) => !/^[A-Z0-9_-]{2,24}$/u.test(hop))
      ) {
        throw new TypeError(`invalid route for account ${account}`);
      }
      routes.set(account, Object.freeze(hops));
    }

    const feeRules = new Map<string, ScenarioFeeRule>();
    for (let index = 0; index < definition.feeRules.length; index += 1) {
      const rawRule = definition.feeRules[index]!;
      const currency = rawRule.currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/u.test(currency)) {
        throw new TypeError(`fee rule ${index} has an invalid currency`);
      }
      if (feeRules.has(currency)) {
        throw new TypeError(`duplicate fee rule for ${currency}`);
      }
      if (
        !Number.isInteger(rawRule.basisPoints) ||
        rawRule.basisPoints < 0 ||
        rawRule.basisPoints > 10_000
      ) {
        throw new RangeError(`fee rule ${index} has invalid basisPoints`);
      }
      if (rawRule.fixedMinor < 0n || rawRule.minimumFeeMinor < 0n) {
        throw new RangeError(`fee rule ${index} contains a negative fee`);
      }
      if (
        rawRule.maximumFeeMinor !== undefined &&
        rawRule.maximumFeeMinor < rawRule.minimumFeeMinor
      ) {
        throw new RangeError(`fee rule ${index} maximum is below its minimum`);
      }
      feeRules.set(currency, Object.freeze({ ...rawRule, currency }));
    }

    const balances = new Map<string, Map<string, MutableBalance>>();
    const accounts = new Set<string>();
    // 先按币种、再按账户聚合头寸,同账户同币种的多笔头寸合并为单条净额。
    for (let index = 0; index < definition.positions.length; index += 1) {
      const rawPosition = definition.positions[index]!;
      const account = rawPosition.account.trim();
      const currency = rawPosition.currency.trim().toUpperCase();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(account)) {
        throw new TypeError(`position ${index} has an invalid account`);
      }
      if (!/^[A-Z]{3}$/u.test(currency)) {
        throw new TypeError(`position ${index} has an invalid currency`);
      }
      if (
        !Number.isSafeInteger(rawPosition.priority) ||
        rawPosition.priority < 0
      ) {
        throw new RangeError(`position ${index} has an invalid priority`);
      }
      accounts.add(account);
      const currencyBalances =
        balances.get(currency) ?? new Map<string, MutableBalance>();
      const prior = currencyBalances.get(account) ?? {
        account,
        amountMinor: 0n,
        priority: rawPosition.priority,
      };
      prior.amountMinor += rawPosition.amountMinor;
      prior.priority = Math.min(prior.priority, rawPosition.priority);
      currencyBalances.set(account, prior);
      balances.set(currency, currencyBalances);
    }

    const instructions: ScenarioInstruction[] = [];
    const unmatchedByCurrency: Record<string, bigint> = {};
    let grossPrincipalMinor = 0n;
    let totalFeesMinor = 0n;
    let instructionIndex = 0;
    for (const [currency, currencyBalances] of [...balances].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const debtors = [...currencyBalances.values()]
        .filter((balance) => balance.amountMinor < 0n)
        .map((balance) => ({ ...balance, amountMinor: -balance.amountMinor }))
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            left.account.localeCompare(right.account),
        );
      const creditors = [...currencyBalances.values()]
        .filter((balance) => balance.amountMinor > 0n)
        .map((balance) => ({ ...balance }))
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            left.account.localeCompare(right.account),
        );
      const totalDebit = debtors.reduce(
        (sum, balance) => sum + balance.amountMinor,
        0n,
      );
      const totalCredit = creditors.reduce(
        (sum, balance) => sum + balance.amountMinor,
        0n,
      );
      unmatchedByCurrency[currency] = totalCredit - totalDebit;

      let debtorIndex = 0;
      let creditorIndex = 0;
      while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
        const debtor = debtors[debtorIndex]!;
        const creditor = creditors[creditorIndex]!;
        const principalMinor =
          debtor.amountMinor < creditor.amountMinor
            ? debtor.amountMinor
            : creditor.amountMinor;
        if (principalMinor <= 0n) {
          throw new Error(
            "scenario compilation failed to make netting progress",
          );
        }

        const feeRule = feeRules.get(currency);
        let feeMinor = 0n;
        // 费用 = 本金 × 基点 / 10000(余数达半步进位)+ 固定费用,并夹在
        // [minimumFeeMinor, maximumFeeMinor] 区间内。
        if (feeRule !== undefined) {
          const numerator = principalMinor * BigInt(feeRule.basisPoints);
          feeMinor = numerator / 10_000n + feeRule.fixedMinor;
          if (numerator % 10_000n >= 5_000n) feeMinor += 1n;
          feeMinor =
            feeMinor < feeRule.minimumFeeMinor
              ? feeRule.minimumFeeMinor
              : feeMinor;
          if (
            feeRule.maximumFeeMinor !== undefined &&
            feeMinor > feeRule.maximumFeeMinor
          ) {
            feeMinor = feeRule.maximumFeeMinor;
          }
        }

        const route =
          routes.get(debtor.account) ?? routes.get(creditor.account) ?? [];
        const instructionId = `${scenarioId}-${currency}-${instructionIndex
          .toString(36)
          .padStart(4, "0")}`;
        instructions.push(
          Object.freeze({
            index: instructionIndex,
            instructionId,
            from: debtor.account,
            to: creditor.account,
            currency,
            principalMinor,
            feeMinor,
            debitMinor: principalMinor + feeMinor,
            route: Object.freeze([...route]),
            priority: Math.min(debtor.priority, creditor.priority),
          }),
        );
        instructionIndex += 1;
        grossPrincipalMinor += principalMinor;
        totalFeesMinor += feeMinor;
        debtor.amountMinor -= principalMinor;
        creditor.amountMinor -= principalMinor;
        if (debtor.amountMinor === 0n) debtorIndex += 1;
        if (creditor.amountMinor === 0n) creditorIndex += 1;
      }
    }

    instructions.sort(
      (left, right) =>
        left.priority - right.priority ||
        left.currency.localeCompare(right.currency) ||
        left.index - right.index,
    );
    // 内容指纹:对每条指令的 ID/账户/金额逐字节滚动哈希,任何字段变化都
    // 会改变指纹,用于检测相同场景的重复编译。
    const encoder = new TextEncoder();
    let fingerprintState = 2_166_136_261;
    for (const instruction of instructions) {
      const encoded = encoder.encode(
        `${instruction.instructionId}|${instruction.from}|${instruction.to}|${instruction.debitMinor}`,
      );
      for (const byte of encoded) {
        fingerprintState = Math.imul(fingerprintState ^ byte, 16_777_619) >>> 0;
      }
    }
    return Object.freeze({
      scenarioId,
      fingerprint: fingerprintState.toString(16).padStart(8, "0"),
      instructions: Object.freeze(instructions),
      currencies: Object.freeze([...balances.keys()].sort()),
      accountCount: accounts.size,
      grossPrincipalMinor,
      totalFeesMinor,
      unmatchedByCurrency: Object.freeze(unmatchedByCurrency),
    });
  }

  /**
   * 执行已编译场景:受限并发逐条调用 writer,失败按 maximumAttempts 重试,
   * 凭据跨指令去重(同一凭据被两个指令复用即判定失败),并记录每次耗时。
   */
  public async execute(
    scenario: CompiledScenario,
    writer: (
      instruction: ScenarioInstruction,
      attempt: number,
    ) => Promise<string>,
    maximumParallelism = 4,
    blockedAccounts: ReadonlySet<string> = new Set(),
  ): Promise<readonly ScenarioExecutionRecord[]> {
    if (
      !Number.isInteger(maximumParallelism) ||
      maximumParallelism < 1 ||
      maximumParallelism > 256
    ) {
      throw new RangeError(
        "maximumParallelism must be an integer from 1 to 256",
      );
    }
    const output = new Array<ScenarioExecutionRecord>(
      scenario.instructions.length,
    );
    const receipts = new Map<string, string>();
    let cursor = 0;

    const worker = async (): Promise<void> => {
      // 无锁任务分发:各 worker 从共享游标取下一条指令,避免重复执行,
      // 输出槽位与输入顺序一一对应。
      while (true) {
        const outputIndex = cursor;
        cursor += 1;
        if (outputIndex >= scenario.instructions.length) return;
        const instruction = scenario.instructions[outputIndex]!;
        const startedAt = this.clock();
        if (!Number.isFinite(startedAt))
          throw new RangeError("clock must return a finite value");

        if (
          blockedAccounts.has(instruction.from) ||
          blockedAccounts.has(instruction.to)
        ) {
          // 阻断账户:涉及任一阻断账户的指令直接标记为 blocked,不调用 writer。
          output[outputIndex] = Object.freeze({
            index: instruction.index,
            instructionId: instruction.instructionId,
            currency: instruction.currency,
            from: instruction.from,
            to: instruction.to,
            principalMinor: instruction.principalMinor,
            feeMinor: instruction.feeMinor,
            status: "blocked",
            attempts: 0,
            elapsedMs: 0,
            error: "account blocked",
          });
          continue;
        }

        let errorMessage = "writer failed";
        for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
          try {
            const proposedReceipt = (await writer(instruction, attempt)).trim();
            if (proposedReceipt.length === 0 || proposedReceipt.length > 512) {
              throw new TypeError("writer returned an invalid receipt");
            }
            const priorInstruction = receipts.get(proposedReceipt);
            // 凭据去重:同一凭据若已被其他指令使用,说明写入方异常,按失败处理。
            if (
              priorInstruction !== undefined &&
              priorInstruction !== instruction.instructionId
            ) {
              throw new Error(`receipt ${proposedReceipt} was reused`);
            }
            receipts.set(proposedReceipt, instruction.instructionId);
            const completedAt = this.clock();
            output[outputIndex] = Object.freeze({
              index: instruction.index,
              instructionId: instruction.instructionId,
              currency: instruction.currency,
              from: instruction.from,
              to: instruction.to,
              principalMinor: instruction.principalMinor,
              feeMinor: instruction.feeMinor,
              status: "settled",
              attempts: attempt,
              elapsedMs: Math.max(0, completedAt - startedAt),
              receipt: proposedReceipt,
            });
            break;
          } catch (error) {
            errorMessage =
              error instanceof Error ? error.message : String(error);
            if (attempt === this.maximumAttempts) {
              const failedAt = this.clock();
              output[outputIndex] = Object.freeze({
                index: instruction.index,
                instructionId: instruction.instructionId,
                currency: instruction.currency,
                from: instruction.from,
                to: instruction.to,
                principalMinor: instruction.principalMinor,
                feeMinor: instruction.feeMinor,
                status: "failed",
                attempts: attempt,
                elapsedMs: Math.max(0, failedAt - startedAt),
                error: errorMessage,
              });
            }
          }
        }
      }
    };

    const workers = Math.min(
      maximumParallelism,
      Math.max(1, scenario.instructions.length),
    );
    await Promise.all(Array.from({ length: workers }, worker));
    return Object.freeze(output);
  }

  /**
   * 汇总执行记录:统计成功/失败/阻断、凭据去重、重试直方图、按币种/账户
   * 的金额归集与延迟分位(p50/p95),并对非法记录抛错。
   */
  public summarize(
    records: readonly ScenarioExecutionRecord[],
  ): ScenarioSummary {
    const receiptOwners = new Map<string, string>();
    const duplicateReceipts: string[] = [];
    const retryHistogram: Record<string, number> = {};
    const settledPrincipalByCurrency: Record<string, bigint> = {};
    const feeByCurrency: Record<string, bigint> = {};
    const debitByAccount: Record<string, bigint> = {};
    const creditByAccount: Record<string, bigint> = {};
    const errorCounts: Record<string, number> = {};
    const latencies: number[] = [];
    let settled = 0;
    let failed = 0;
    let blocked = 0;
    let attempts = 0;

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (!Number.isSafeInteger(record.index) || record.index < 0) {
        throw new RangeError(`record ${index} has an invalid index`);
      }
      if (!Number.isFinite(record.elapsedMs) || record.elapsedMs < 0) {
        throw new RangeError(`record ${index} has an invalid elapsedMs`);
      }
      attempts += record.attempts;
      latencies.push(record.elapsedMs);
      retryHistogram[String(record.attempts)] =
        (retryHistogram[String(record.attempts)] ?? 0) + 1;

      if (record.status === "settled") {
        settled += 1;
        settledPrincipalByCurrency[record.currency] =
          (settledPrincipalByCurrency[record.currency] ?? 0n) +
          record.principalMinor;
        feeByCurrency[record.currency] =
          (feeByCurrency[record.currency] ?? 0n) + record.feeMinor;
        debitByAccount[record.from] =
          (debitByAccount[record.from] ?? 0n) +
          record.principalMinor +
          record.feeMinor;
        creditByAccount[record.to] =
          (creditByAccount[record.to] ?? 0n) + record.principalMinor;
        // 凭据所有者登记:同一凭据被多个指令使用时记入重复凭据。
        if (record.receipt !== undefined) {
          const owner = receiptOwners.get(record.receipt);
          if (owner !== undefined && owner !== record.instructionId) {
            duplicateReceipts.push(record.receipt);
          } else {
            receiptOwners.set(record.receipt, record.instructionId);
          }
        }
      } else if (record.status === "failed") {
        failed += 1;
        const error = record.error?.trim() || "unknown failure";
        errorCounts[error] = (errorCounts[error] ?? 0) + 1;
      } else {
        blocked += 1;
        const reason = record.error?.trim() || "blocked";
        errorCounts[reason] = (errorCounts[reason] ?? 0) + 1;
      }
    }

    latencies.sort((left, right) => left - right);
    const at = (fraction: number): number => {
      if (latencies.length === 0) return 0;
      const position = (latencies.length - 1) * fraction;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      return (
        latencies[lower]! +
        (latencies[upper]! - latencies[lower]!) * (position - lower)
      );
    };
    const latencyTotal = latencies.reduce((sum, latency) => sum + latency, 0);
    return Object.freeze({
      instructionCount: records.length,
      settled,
      failed,
      blocked,
      receipts: receiptOwners.size,
      duplicateReceipts: Object.freeze([...new Set(duplicateReceipts)].sort()),
      attempts,
      retryHistogram: Object.freeze(retryHistogram),
      settledPrincipalByCurrency: Object.freeze(settledPrincipalByCurrency),
      feeByCurrency: Object.freeze(feeByCurrency),
      debitByAccount: Object.freeze(debitByAccount),
      creditByAccount: Object.freeze(creditByAccount),
      errorCounts: Object.freeze(errorCounts),
      minimumLatencyMs: latencies[0] ?? 0,
      maximumLatencyMs: latencies.at(-1) ?? 0,
      averageLatencyMs:
        latencies.length === 0 ? 0 : latencyTotal / latencies.length,
      p50LatencyMs: at(0.5),
      p95LatencyMs: at(0.95),
    });
  }
}
