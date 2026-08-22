/**
 * AIDVerifier 编排(verifyWithVariants):变体轨道 = 参考组(源+变体) vs 目标(C#)的差分。
 * 流程:变体生成 → 变体过滤(基础输入集 + 同语言差分)→ 输入生成器 → 批量合成
 * → 参考组批量执行 → 共识 oracle(规则 R0)→ 目标执行 → compareAgainstConsensus → 报告。
 * 现有 verify 双轨语义零改动(executeSide 已提取为公共辅助);本模块只新增不侵入。
 */
import { validateAgainstExpected, type CaseComparison } from "../comparator.js";
import type { TestDescription, TypedValue } from "../description.js";
import { generateDriverSource } from "../driver/driver-codegen.js";
import type { DriverExecutor, SideSpec } from "../executor.js";
import { createLogger, type Logger } from "../logger.js";
import type { CaseResult, SideResults } from "../result-capture.js";
import { executeSide } from "../verifier.js";
import {
  DISPUTED_DETAIL_PREFIX,
  buildConsensus,
  compareAgainstConsensus,
  oracleAsResult,
  type ConsensusOracle,
  type ConsensusOptions,
} from "./consensus.js";
import { runInputGenerator, toBatchDescription, type InputGeneratorAgent } from "./input-generator.js";
import {
  buildReferenceSide,
  buildVariantSideSpec,
  filterVariants,
  parseMethodSignature,
  parseSourceContract,
  type FilteredVariant,
  type SourceContract,
} from "./variant-filter.js";
import type { VariantGeneratorAgent } from "./variant-generator.js";

export interface AIDJobOptions {
  /** 生成变体数;默认 3。 */
  variantCount?: number;
  /** 生成器目标输入数;默认 50。 */
  inputCount?: number;
  /** k-共识触发门槛;默认 2。 */
  minAgreeingSides?: number;
}

export interface AIDJob {
  /** 需求 + 目标契约 + 基础 cases(仅用 inputs;expected 保留用于冲突标注)。 */
  description: TestDescription;
  /** 源侧(真实实现;sourceFiles 同时提供源方法文件)。 */
  source: SideSpec;
  /** 目标翻译产物侧。 */
  target: SideSpec;
  options?: AIDJobOptions;
}

export interface AIDVerificationReport {
  schemaVersion: "1.0";
  /** 变体清单(含剔除者与原因)。 */
  variants: FilteredVariant[];
  oracleSummary: { consensusCount: number; disputedCount: number };
  /** 目标 vs 共识的比较(verdict: pass / fail / divergent[=disputed])。 */
  comparisons: CaseComparison[];
  passRate: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  /** 低置信 case 数(disputed,复用 divergent 枚举 + details 标注)。 */
  disputedCases: number;
  /** 共识 vs description.expected 冲突的 caseId 列表(供人工复核与二期演进)。 */
  consensusExpectedConflicts: string[];
}

export async function verifyWithVariants(
  job: AIDJob,
  executor: DriverExecutor,
  agents: { variants: VariantGeneratorAgent; inputs: InputGeneratorAgent },
  logger: Logger = createLogger("aid-verifier"),
): Promise<AIDVerificationReport> {
  const description = job.description;
  const language = job.source.language;
  const sourceContent = job.source.sourceFiles.map((f) => f.content).join("\n");
  const contract = parseSourceContract(sourceContent, language);
  if (!contract) {
    throw new Error(`cannot parse source contract from source side (${language})`);
  }

  const variantCount = job.options?.variantCount ?? 3;
  const inputCount = job.options?.inputCount ?? 50;
  const consensusOptions: ConsensusOptions =
    job.options?.minAgreeingSides === undefined ? {} : { minAgreeingSides: job.options.minAgreeingSides };

  // 1. 变体生成 + 过滤(基础输入集 + 同语言差分)。
  logger.info(`AID 开始:变体生成(${variantCount} 个)→ 过滤 → 输入生成(${inputCount})`);
  const rawVariants = await agents.variants.generateVariants({
    requirement: description.requirement ?? "",
    sourceLanguage: language,
    sourceCode: sourceContent,
    target: {
      className: description.target.className,
      method: description.target.method,
      isStatic: description.target.isStatic,
    },
    variantCount,
  });
  const baseCases = description.cases.map((c) => ({ id: c.id, inputs: c.inputs }));
  const filtered = await filterVariants(rawVariants, { sourceSide: job.source, baseCases, executor, logger });
  const kept = filtered.filter((v) => v.passes);
  logger.info(`AID:变体过滤完成,保留 ${kept.length}/${filtered.length}`);
  if (kept.length === 0) {
    logger.warn("AID:全部变体被过滤,参考组退化为仅源方法(等价现有双轨),AID 不降级失败");
  }

  // 2. 输入生成器(LLM 写脚本 → 执行批量产输入);失败时退化为基础输入集。
  let generatedInputs: TypedValue[][] = [];
  const generatorErrors: string[] = [];
  try {
    const script = await agents.inputs.generate({
      requirement: description.requirement ?? "",
      sourceLanguage: language,
      sourceCode: sourceContent,
      count: inputCount,
      targetSignature: parseMethodSignature(sourceContent, contract),
    });
    const generated = await runInputGenerator(script, inputCount, executor, logger);
    generatedInputs = generated.inputs;
    generatorErrors.push(...generated.errors);
  } catch (error) {
    generatorErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (generatedInputs.length === 0) {
    logger.warn(`AID:输入生成器未产出可用输入(错误:${generatorErrors.join("; ") || "无"}),退化为基础输入集`);
  }

  // 3. 批量合成:基础 cases(回归+冲突标注)+ 生成输入,一次编译一次运行产出全部结果。
  const batchDescription = toBatchDescription(description, generatedInputs);

  // 4. 参考组批量执行(源 + 保留变体)。
  const referenceSides: SideResults[] = [];
  const runReferenceSide = async (side: SideSpec, label: string): Promise<void> => {
    const info = await executeSide(executor, side, label);
    if (info.results && info.results.results.length > 0) referenceSides.push(info.results);
  };
  await runReferenceSide(
    buildReferenceSide(batchDescription, language, contract, { sourceFiles: job.source.sourceFiles }),
    "source",
  );
  for (let i = 0; i < kept.length; i += 1) {
    const variant = kept[i] as FilteredVariant;
    const spec = buildVariantSideSpec(batchDescription, language, contract, variant.code, i + 1);
    await runReferenceSide(spec, `Variant_${i + 1}`);
  }
  logger.info(`AID:参考组执行完成,${referenceSides.length} 侧有可用结果`);

  // 5. 共识 oracle(规则 R0)。
  const oracle = buildConsensus(referenceSides, consensusOptions);

  // 6. 目标侧批量执行 + 与共识比较。
  const targetBatchSide: SideSpec = {
    language: job.target.language,
    driverSource: generateDriverSource(batchDescription),
    sourceFiles: job.target.sourceFiles,
  };
  const targetInfo = await executeSide(executor, targetBatchSide, "target");
  let comparisons: CaseComparison[];
  if (targetInfo.results && targetInfo.results.results.length > 0) {
    comparisons = compareAgainstConsensus(targetInfo.results, oracle, consensusOptions);
  } else {
    comparisons = batchDescription.cases.map((c) => ({
      caseId: c.id,
      verdict: "divergent",
      source: null,
      target: null,
      details: ["Target side produced no usable results."],
    }));
  }

  // 7. 报告统计。
  const oracles = [...oracle.values()];
  const consensusCount = oracles.filter((o) => o.confidence === "consensus").length;
  const disputedCount = oracles.filter((o) => o.confidence === "disputed").length;
  const passedCases = comparisons.filter((c) => c.verdict === "pass").length;
  const failedCases = comparisons.filter((c) => c.verdict === "fail").length;
  const disputedCases = comparisons.filter(
    (c) => c.verdict === "divergent" && c.details.some((d) => d.startsWith(DISPUTED_DETAIL_PREFIX)),
  ).length;
  const totalCases = comparisons.length;
  const passRate = totalCases === 0 ? 0 : passedCases / totalCases;
  const consensusExpectedConflicts = computeConsensusExpectedConflicts(
    description,
    oracle,
    targetInfo.results?.results ?? [],
  );

  logger.info(
    `AID 完成:passRate=${passRate.toFixed(2)} (pass=${passedCases} fail=${failedCases} disputed=${disputedCases}), oracle consensus=${consensusCount} disputed=${disputedCount}`,
  );
  return {
    schemaVersion: "1.0",
    variants: filtered,
    oracleSummary: { consensusCount, disputedCount },
    comparisons,
    passRate,
    totalCases,
    passedCases,
    failedCases,
    disputedCases,
    consensusExpectedConflicts,
  };
}

/** 共识 vs description.expected 冲突:基础 case 上共识为 consensus 且与声明期望不一致 → 冲突。 */
function computeConsensusExpectedConflicts(
  description: TestDescription,
  oracle: Map<string, ConsensusOracle>,
  targetResults: CaseResult[],
): string[] {
  const conflicts: string[] = [];
  for (const c of description.cases) {
    const o = oracle.get(c.id);
    if (!o) continue;
    if (o.confidence === "disputed") {
      conflicts.push(
        `${c.id} (reference group disagrees on this case; declared expectation cannot be verified by consensus)`,
      );
      continue;
    }
    const issues = validateAgainstExpected(oracleAsResult(o), c.expected);
    if (issues.length > 0) {
      conflicts.push(`${c.id} (consensus differs from declared expected: ${issues.join("; ")})`);
    }
  }
  void targetResults;
  return conflicts;
}
