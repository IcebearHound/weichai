/**
 * distinct 适配器:baseline 描述 + LlmAnalyzer 分支一致性(方向 2)。
 *
 * 接入方式:
 * 1. TestMigratorAgent 生成 baseline 描述(需求第一);
 * 2. 构造差分 job(描述 → 双侧驱动)并经 verify 产出 VerificationReport;
 * 3. LlmAnalyzer.buildBranchInventory(源方法,需求)→ LLM 分支清单(一次调用);
 * 4. LlmAnalyzer.analyzeCases(描述,报告,清单)→ case 级 NLD 三态裁决(一次调用);
 * 5. flag-fail 即「偏离需求信号」:recommend=flag-fail / nldVerdict=diverges 的 case
 *    汇总进 meta.signal,供报告可观测;描述本体不变(修正语义由 strictNld 选项控制,
 *    默认仅标记,不篡改差分结果)。
 *
 * 成本:baseline 描述(1+重试)+ 分支清单(1)+ case 裁决(1),共 3+ 次 LLM 调用。
 */
import { LlmAnalyzer } from "../../analyzer.js";
import { basename } from "node:path";
import { generateDriverSource, generateSourceDriverSource } from "../../driver/driver-codegen.js";
import type { SourceInvocation } from "../../driver/source-invocation.js";
import { verify } from "../../verifier.js";
import { TestMigratorAgent } from "../../test-migrator.js";
import { normalizeSourceSignature } from "../dataset.js";
import type { SideSpec } from "../../executor.js";
import type { QualityTask, GeneratedTest, GeneratorAdapter } from "../types.js";
import { countedClaude, defaultLogger, type AdapterContext } from "../adapters.js";
import { toMigrationInput } from "./baseline.js";

export class DistinctAdapter implements GeneratorAdapter {
  readonly name = "distinct" as const;
  readonly #ctx: AdapterContext;
  readonly #counted: ReturnType<typeof countedClaude>;
  readonly #migrator: TestMigratorAgent;

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
    this.#counted = countedClaude(ctx.llm);
    this.#migrator = new TestMigratorAgent({ ...this.#counted.options, logger: defaultLogger("distinct", ctx) });
  }

  async generateTest(task: QualityTask, signal?: AbortSignal): Promise<GeneratedTest> {
    const started = Date.now();
    this.#counted.reset();
    const logger = defaultLogger("distinct", this.#ctx);

    // 1. baseline 描述。
    const description = await this.#migrator.extractDescription(toMigrationInput(task), signal);

    // 2. 双侧驱动 + 差分验证(分支一致性分析需要真实差分报告)。
    const sourceSide = buildSourceSide(description, task);
    const targetSide = buildTargetSide(description, task, task.target.sourceFiles.map((f) => f.content).join("\n"));
    const report = await verify({ description, source: sourceSide, target: targetSide }, this.#ctx.executor, logger);

    // 3+4. Analyzer 分支清单 + case 一致性(LLM)。
    const analyzer = new LlmAnalyzer({ ...this.#counted.options, logger });
    const sourceCode = task.source.sourceFiles.map((f) => f.content).join("\n\n");
    const inventory = await analyzer.buildBranchInventory(sourceCode, task.entry.requirement, signal);
    const consistencies = await analyzer.analyzeCases(description, report, inventory, signal);

    // 5. flag-fail 即偏离需求信号。
    const flagged = consistencies.filter(
      (c) => c.recommend === "flag-fail" || c.nldVerdict === "diverges",
    );
    const caseIds = flagged.map((c) => c.caseId);
    if (caseIds.length > 0) {
      logger.warn(`distinct 检出 ${caseIds.length} 个偏离需求 case:${caseIds.join(", ")}`);
    }
    return {
      kind: "description",
      description,
      meta: {
        llmCalls: this.#counted.calls(),
        durationMs: Date.now() - started,
        signal:
          caseIds.length > 0
            ? {
                kind: "flag-fail",
                caseIds,
                detail: flagged.map((c) => `${c.caseId}:${c.nldVerdict}/${c.recommend}`).join("; "),
              }
            : undefined,
      },
    };
  }
}

/** 从描述 + task 构造目标侧 SideSpec(驱动 + 目标模块文件;保留项目文件结构,替换模块内容)。 */
export function buildTargetSide(
  description: Parameters<typeof generateDriverSource>[0],
  task: QualityTask,
  targetContent: string,
): SideSpec {
  const targetFile = basename(task.entry.target.file);
  const sourceFiles = task.target.sourceFiles.map((f) =>
    f.relativePath === targetFile ? { ...f, content: targetContent } : f,
  );
  return {
    ...task.target,
    driverSource: generateDriverSource(description),
    sourceFiles,
  };
}

/** 从描述 + task 构造源侧 SideSpec(源驱动 + 源模块文件;签名经规范化:package→FQN、静态性探测)。 */
export function buildSourceSide(
  description: Parameters<typeof generateDriverSource>[0],
  task: QualityTask,
): SideSpec {
  const entry = task.entry;
  const sourceCode = task.source.sourceFiles.map((f) => f.content).join("\n");
  const signature = normalizeSourceSignature(entry, sourceCode, task.source.projectRoot);
  const invocation: SourceInvocation = {
    language: task.source.language,
    className: signature.className,
    method: signature.method,
    isStatic: signature.isStatic,
    constructorArgs: signature.constructorArgs,
  };
  return {
    ...task.source,
    driverSource: generateSourceDriverSource(description, invocation),
  };
}
