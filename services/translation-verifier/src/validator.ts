import { generateDriverSource, generateSourceDriverSource } from "./driver/driver-codegen.js";
import type { TestDescription, VerifierLanguage } from "./description.js";
import type { DriverExecutor, SideSpec } from "./executor.js";
import { createLogger, type Logger } from "./logger.js";
import { TestMigratorAgent, type MigrationInput } from "./test-migrator.js";

/**
 * 方向 2(DISTINCT)Validator:编译诊断 → 反馈 → 重生成。
 *
 * 问题:extractDescription 的重试只处理 schema/JSON 校验失败,但 LLM 生成的描述可能让驱动
 * 编译失败(非法 TypedValue 字面量、构造参数与签名不匹配、输入类型冲突等),这些要到 verify()
 * 的 compile 阶段才暴露,且当前没有反馈给 LLM。
 *
 * 方案:描述生成后、正式验证前做双侧试编译;失败且错误行位于【驱动生成文件】
 * (Driver_xxx.java / Driver.cs / driver.py / driver.ts)→ 组装诊断反馈 → LLM 重生成描述
 * (提示词注明\"是驱动/描述问题,不是目标翻译问题\")→ 重验(最多 maxRounds 轮)。
 * 错误属于目标翻译/源实现文件(非驱动)时**不触发描述重生成**——那是翻译质量问题,属
 * repair-loop 范畴,避免 Validator 越权。
 */

const DEFAULT_MAX_VALIDATOR_ROUNDS = 3;

export interface DescriptionValidatorOptions {
  agent: TestMigratorAgent;
  executor: DriverExecutor;
  /** 重生成轮数上限;默认 3(与设计文档 MAX_VALIDATOR_RETRIES=3 一致)。 */
  maxRounds?: number;
  /** 注入的 logger;默认 createLogger("validator")。 */
  logger?: Logger;
}

/**
 * 描述试编译验证器:extractDescription → 双侧试编译 → 驱动错误反馈重生成(有界循环)。
 * 成功返回描述(编译诊断经 logger 记录);超限或错误归属非驱动文件时抛错。
 */
export class DescriptionValidator {
  readonly #agent: TestMigratorAgent;
  readonly #executor: DriverExecutor;
  readonly #maxRounds: number;
  readonly #logger: Logger;

  constructor(options: DescriptionValidatorOptions) {
    this.#agent = options.agent;
    this.#executor = options.executor;
    this.#maxRounds = options.maxRounds ?? DEFAULT_MAX_VALIDATOR_ROUNDS;
    this.#logger = options.logger ?? createLogger("validator");
  }

  async extractDescriptionVerified(
    input: MigrationInput,
    sourceSide: SideSpec,
    targetSide: SideSpec,
    signal?: AbortSignal,
  ): Promise<TestDescription> {
    let description = await this.#agent.extractDescription(input, signal);
    for (let attempt = 0; ; attempt += 1) {
      // 由描述重建双侧驱动(复用 driver-codegen;源侧需 sourceInvocation,无法重建时退回模板 driverSource)。
      const targetDriver = generateDriverSource(description);
      const sourceDriver = input.sourceInvocation
        ? generateSourceDriverSource(description, input.sourceInvocation)
        : sourceSide.driverSource;
      const sourceCompile = await this.#executor.compile({ ...sourceSide, driverSource: sourceDriver });
      const targetCompile = await this.#executor.compile({ ...targetSide, driverSource: targetDriver });
      this.#logCompile(sourceSide, sourceCompile, sourceDriver);
      this.#logCompile(targetSide, targetCompile, targetDriver);
      if (sourceCompile.success && targetCompile.success) {
        this.#logger.info(`试编译通过(第 ${attempt + 1} 次尝试)`);
        return description;
      }
      // 错误归属过滤:只对位于驱动生成文件的错误做重生成。
      const driverErrors = [
        ...filterDriverErrors(sourceCompile.errors, driverFileNames(sourceSide.language, sourceDriver)),
        ...filterDriverErrors(targetCompile.errors, driverFileNames(targetSide.language, targetDriver)),
      ];
      if (driverErrors.length === 0) {
        // 错误属于目标翻译/源实现文件(非驱动)→ 翻译质量问题,不触发描述重生成(避免 Validator 越权)。
        const allErrors = [...sourceCompile.errors, ...targetCompile.errors];
        throw new Error(
          `DescriptionValidator: 编译错误不在驱动生成文件中,不触发描述重生成(属于翻译/源实现质量问题): ${allErrors.join("; ") || "无解析错误行"}`,
        );
      }
      if (attempt >= this.#maxRounds) {
        throw new Error(
          `DescriptionValidator: 超过最大重试次数(${this.#maxRounds}),最近驱动编译错误:\n${driverErrors.join("\n")}`,
        );
      }
      this.#logger.info(`试编译失败(第 ${attempt + 1} 次),${driverErrors.length} 条驱动错误 → LLM 重生成`);
      const feedback = buildValidatorFeedbackPrompt(input, driverErrors);
      this.#logger.debug(`Validator 反馈 prompt:\n${feedback}`);
      description = await this.#agent.extractDescription({ ...input, validationFeedback: feedback }, signal);
    }
  }

  #logCompile(side: SideSpec, outcome: { success: boolean; errors: string[] }, driver: string): void {
    if (outcome.success) {
      this.#logger.debug(`试编译成功(${side.language}, 驱动 ${driverFileName(side.language, driver)})`);
      return;
    }
    const errors = outcome.errors.length > 0 ? outcome.errors.join("; ") : "(无解析错误行)";
    this.#logger.error(`试编译失败(${side.language}): ${errors}`);
  }
}

/** 驱动生成文件的文件名(Java 按 public class 名;其余语言固定脚本名)。 */
function driverFileName(language: VerifierLanguage, driverSource: string): string {
  return driverFileNames(language, driverSource)[0] ?? `${language}.driver`;
}

/**
 * 驱动生成文件的文件名列表(与 executor.writeSideFiles 的落盘文件名一致):
 * Java = Driver_<sha8>.java(按 public class 名),C# = Driver.cs,Python = driver.py,TS = driver.ts。
 */
export function driverFileNames(language: VerifierLanguage, driverSource: string): string[] {
  if (language === "Java") {
    const match = /public\s+class\s+(\w+)/.exec(driverSource);
    return match?.[1] ? [`${match[1]}.java`] : ["Driver.java"];
  }
  if (language === "C#") return ["Driver.cs"];
  if (language === "Python") return ["driver.py"];
  return ["driver.ts"];
}

/**
 * 按文件路径过滤编译错误行:只保留错误行中出现任一驱动文件名的行。
 * (parseJavaErrors / parseDotnetErrors 等已把编译错误按行解析,这里做归属过滤。)
 */
export function filterDriverErrors(errors: string[], driverFileNames: string[]): string[] {
  return errors.filter((line) => driverFileNames.some((name) => line.includes(name)));
}

/**
 * 组装 Validator 反馈 prompt:注明\"是驱动/描述问题,不是目标翻译问题\",要求重生成描述。
 */
export function buildValidatorFeedbackPrompt(input: MigrationInput, driverErrors: string[]): string {
  return `VALIDATION_FEEDBACK (试编译失败,错误位于驱动生成文件)

上次生成的测试描述导致驱动试编译失败。以下编译错误行位于驱动生成文件
(Driver_*.java / Driver.cs / driver.py / driver.ts)——这是测试描述本身的问题
(如 TypedValue 字面量与目标/源方法签名不匹配、构造参数错误、输入类型冲突),
不是目标翻译实现的质量问题,不要修改目标方法。

请根据诊断修正测试描述(输入类型与值、构造参数、异常类型、方法签名等),
保持 schemaVersion="1.0" 与 schema 结构不变,重新输出完整 TestDescription JSON。

COMPILER_DIAGNOSTICS
${driverErrors.join("\n")}`;
}
