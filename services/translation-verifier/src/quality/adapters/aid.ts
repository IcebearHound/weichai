/**
 * aid 适配器:verifyWithVariants 变体轨道(方向 3)。
 *
 * 接入方式:
 * 1. TestMigratorAgent 生成 base 描述(需求第一;AID 本身不产出 TestDescription,
 *    base 描述作为其输入契约与 GeneratedTest.description);
 * 2. verifyWithVariants(base 描述, 源侧, 目标侧)跑完整变体轨道:
 *    变体生成 → 过滤 → 输入生成 → 参考组(源+变体)批量执行 → 共识 oracle
 *    → 目标执行 → compareAgainstConsensus → AIDVerificationReport;
 * 3. GeneratedTest.meta.signal = 共识差分结果(consensus 差分 fail 即检出信号);
 * 4. detectOnTarget(扩展方法,非 GeneratorAdapter 接口成员):对注入 bug 的目标
 *    复用 clean 轨道的冻结 oracle，仅重放目标侧；新增 fail case 才算检出，从而把
 *    数据集「需求≠检索代码」导致的合法共识差异(两侧都出现)排除在检出之外。
 *
 * 成本:base 描述(1+重试)+ 变体(variantCount×尝试)+ 输入生成(1),偏高;评估场景
 * 建议 variantCount=2/inputCount=20(AdapterContext 可配),quick 模式 1 策略。
 */
import {
  verifyTargetAgainstAIDBaseline,
  verifyWithVariants,
  type AIDVerificationReport,
} from "../../variant/aid-verifier.js";
import { VariantGeneratorAgent } from "../../variant/variant-generator.js";
import { InputGeneratorAgent } from "../../variant/input-generator.js";
import { TestMigratorAgent } from "../../test-migrator.js";
import type { DriverExecutor } from "../../executor.js";
import type { QualityTask, GeneratedTest, GeneratorAdapter } from "../types.js";
import { countedClaude, defaultLogger, type AdapterContext } from "../adapters.js";
import { alignDescriptionTarget } from "../dataset.js";
import { toMigrationInput } from "./baseline.js";
import { buildSourceSide, buildTargetSide } from "./distinct.js";

export interface AidDetectionResult {
  detected: boolean;
  failedCasesClean: number;
  failedCasesBuggy: number;
  newFailedCaseIds: string[];
  note?: string;
}

export class AidAdapter implements GeneratorAdapter {
  readonly name = "aid" as const;
  readonly #ctx: AdapterContext;
  readonly #counted: ReturnType<typeof countedClaude>;
  readonly #migrator: TestMigratorAgent;
  readonly #variants: VariantGeneratorAgent;
  readonly #inputs: InputGeneratorAgent;

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
    this.#counted = countedClaude(ctx.llm);
    const logger = defaultLogger("aid", ctx);
    this.#migrator = new TestMigratorAgent({ ...this.#counted.options, logger });
    this.#variants = ctx.agents?.variants ?? new VariantGeneratorAgent({ ...this.#counted.options, logger });
    this.#inputs = ctx.agents?.inputs ?? new InputGeneratorAgent({ ...this.#counted.options, logger });
  }

  async generateTest(task: QualityTask, signal?: AbortSignal): Promise<GeneratedTest> {
    const started = Date.now();
    this.#counted.reset();
    const logger = defaultLogger("aid", this.#ctx);

    // 1. base 描述(AID 的输入契约,也是产出描述)。
    const description = alignDescriptionTarget(await this.#migrator.extractDescription(toMigrationInput(task), signal), task.entry);

    // 2. 变体轨道(干净目标)。
    const sourceSide = buildSourceSide(description, task);
    const targetSide = buildTargetSide(description, task, task.target.sourceFiles.map((f) => f.content).join("\n"));
    const report = await verifyWithVariants(
      {
        description,
        source: sourceSide,
        target: targetSide,
        options: { variantCount: this.#ctx.variantCount ?? 2, inputCount: this.#ctx.inputCount ?? 20 },
      },
      this.#ctx.executor,
      { variants: this.#variants, inputs: this.#inputs },
      logger,
    );
    const failCases = report.comparisons.filter((c) => c.verdict === "fail").map((c) => c.caseId);
    if (report.failedCases > 0) {
      logger.warn(`aid 干净目标上共识差分 fail ${report.failedCases} 个 case(可能为跨语言噪声或需求差异):${failCases.join(", ")}`);
    }
    return {
      kind: "description",
      description,
      meta: {
        llmCalls: this.#counted.calls(),
        durationMs: Date.now() - started,
        signal: {
          kind: "aid-differential",
          caseIds: failCases,
          detail: `clean passRate=${report.passRate.toFixed(2)} failed=${report.failedCases} disputed=${report.disputedCases} consensus=${report.oracleSummary.consensusCount} variants=${report.variants.filter((v) => v.passes).length}/${report.variants.length}`,
        },
        aidBaseline: report.baseline,
      },
    };
  }

  /**
   * 注入 bug 检出(扩展方法,评估层按 name==="aid" 调用):
   * 使用 clean run 冻结的输入和 oracle 重放目标侧，detected = 出现新的失败 case。
   */
  async detectOnTarget(
    task: QualityTask,
    test: GeneratedTest,
    targetSource: string,
    signal?: AbortSignal,
  ): Promise<AidDetectionResult> {
    const logger = defaultLogger("aid", this.#ctx);
    const description = test.description;
    if (!description) {
      return { detected: false, failedCasesClean: 0, failedCasesBuggy: 0, newFailedCaseIds: [], note: "no-description" };
    }
    const baseline = test.meta.aidBaseline;
    if (!baseline) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: "clean-baseline-unavailable",
      };
    }
    if (baseline.cleanTarget?.usable !== true) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: `clean-baseline-unusable:${baseline.cleanTarget?.note ?? "missing-clean-target-status"}`,
      };
    }
    if (!baseline.oracle.some((entry) => entry.confidence === "consensus")) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: "clean-baseline-unusable:no-consensus-oracle",
      };
    }
    const targetSide = buildTargetSide(description, task, targetSource);
    let buggyReport: AIDVerificationReport;
    try {
      buggyReport = await verifyTargetAgainstAIDBaseline(
        targetSide,
        baseline,
        this.#ctx.executor,
        logger,
      );
    } catch (error) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: `aid-run-failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const targetUsable = baseline.batchDescription.cases.every((testCase) =>
      buggyReport.comparisons.some((comparison) => comparison.caseId === testCase.id && comparison.target !== null),
    );
    if (!targetUsable) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: "target-unusable",
      };
    }
    const cleanFails = new Set(baseline.cleanFailedCaseIds);
    const newFailedCaseIds = buggyReport.comparisons
      .filter((comparison) => comparison.verdict === "fail" && !cleanFails.has(comparison.caseId))
      .map((comparison) => comparison.caseId);
    return {
      detected: newFailedCaseIds.length > 0,
      failedCasesClean: cleanFails.size,
      failedCasesBuggy: buggyReport.failedCases,
      newFailedCaseIds,
    };
  }
}
