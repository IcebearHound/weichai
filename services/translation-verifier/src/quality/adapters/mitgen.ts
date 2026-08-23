/**
 * mitgen 适配器:MitGenMigratorAgent 片段级微观测试生成(方向 4)。
 *
 * 接入方式:片段划分(纯函数)→ 启发式预筛 + LLM 批量打分 → Top-K 片段逐片段
 * 定向输入生成 + 源侧插桩实跑验证可达性并录制 expected → 汇总 schema 兼容
 * TestDescription。executor 承担源侧实跑(注入 FakeDriverExecutor 可离线验收)。
 *
 * 成本:片段打分(1)+ 每片段输入生成(≤maxFragments)+ 重试(≤1)+ 目标侧
 * correspondence(1);经计数 spawnClaude 统一统计。
 */
import { MitGenMigratorAgent } from "../../mitgen/mitgen-migrator.js";
import { validateDescription } from "../../description.js";
import type { QualityTask, GeneratedTest, GeneratorAdapter } from "../types.js";
import { countedClaude, defaultLogger, type AdapterContext } from "../adapters.js";
import { toMigrationInput } from "./baseline.js";

export class MitGenAdapter implements GeneratorAdapter {
  readonly name = "mitgen" as const;
  readonly #ctx: AdapterContext;
  readonly #counted: ReturnType<typeof countedClaude>;
  readonly #mitgen: MitGenMigratorAgent;

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
    this.#counted = countedClaude(ctx.llm);
    this.#mitgen = new MitGenMigratorAgent({
      ...this.#counted.options,
      logger: defaultLogger("mitgen", ctx),
      maxFragments: ctx.maxFragments ?? 5,
      casesPerFragment: ctx.casesPerFragment ?? 3,
    });
  }

  async generateTest(task: QualityTask, signal?: AbortSignal): Promise<GeneratedTest> {
    const started = Date.now();
    this.#counted.reset();
    const input = toMigrationInput(task);
    // MitGen 需要在源侧实跑录制 expected,方法名定位默认取源方法。
    const result = await this.#mitgen.generate(input, this.#ctx.executor, signal);
    // 产出描述必须通过 schema 校验(与 MitGen 自身验收同口径)。
    validateDescription(result.description);
    const verified = result.fragments.filter((f) => f.reachability === "verified").length;
    return {
      kind: "description",
      description: result.description,
      meta: {
        llmCalls: this.#counted.calls(),
        durationMs: Date.now() - started,
        signal: {
          kind: "mitgen-fragments",
          detail: `fragments=${result.fragments.length} verified=${verified} cases=${result.description.cases.length}`,
        },
      },
    };
  }
}
