import type { AnalyzerLike, ConsistencyReport } from "./analyzer.js";
import type { DriverExecutor } from "./executor.js";
import { createLogger, type Logger } from "./logger.js";
import { verify, type VerificationJob, type VerificationReport } from "./verifier.js";

/**
 * 方向 2(DISTINCT)验证闭环编排层:verify(现有双轨,不动) → Analyzer 分支级一致性分析
 * → flag-fail 标记(方式 A/B)→ 有界补测重验(augmentation)。
 *
 * verifier.ts / comparator.ts 保持不动:Analyzer 通过方式 A(仅报告标记)或方式 B(strictNld,
 * 复制改判)在外部标注 NLD 裁决,不修改差分验证内部语义。
 */

export interface ConsistencyResult {
  report: VerificationReport;
  consistency: ConsistencyReport;
  /** 是否发生了 augmentation 并入后的重验(有界,默认 1 轮)。 */
  augmented: boolean;
}

export interface ConsistencyVerifierOptions {
  /** 严格 NLD 裁决:recommend=flag-fail 且差分 verdict=pass 的 case 改判 fail 计入报告统计(方式 B)。 */
  strictNld?: boolean;
  /** 覆盖缺口补测预算(并入新 case 重验的最大轮数);默认 0 = 只出报告与标记,不补测。 */
  augmentationBudget?: number;
  /** 注入的 logger;默认 createLogger("consistency-verifier")。 */
  logger?: Logger;
}

/**
 * 运行描述引导的分支一致性验证闭环:
 * 1. verify(job, executor) 现有双轨(不动);
 * 2. analyzer.buildBranchInventory(sourceCode, requirement) —— LLM,一次;
 * 3. analyzer.analyzeCases(description, report, inventory) —— LLM,批量;
 * 4. 差分覆盖率统计(covered / uncovered,按 inventory 分支 id 对齐);
 * 5. flag-fail 标记:方式 A(默认,仅 consistency 报告)或方式 B(strictNld,改判 report);
 * 6. uncovered 非空且 augmentationBudget > 0 → generateAugmentations → 并入描述 → 重验(有界)。
 */
export async function runConsistencyVerification(
  job: VerificationJob,
  executor: DriverExecutor,
  analyzer: AnalyzerLike,
  options: ConsistencyVerifierOptions = {},
): Promise<ConsistencyResult> {
  const logger = options.logger ?? createLogger("consistency-verifier");
  const strictNld = options.strictNld ?? false;
  const augmentationBudget = options.augmentationBudget ?? 0;

  // 1. 现有双轨验证(差异探测器,不改 verify 本体)。
  const report = await verify(job, executor, logger);

  // 2. 分支清单构建(源方法侧;源文件可能有多个,拼接为完整上下文)。
  const sourceCode = job.source.sourceFiles.map((f) => f.content).join("\n\n");
  const requirement = job.description.requirement ?? "";
  logger.info("编排层:buildBranchInventory(LLM 分支清单)");
  const inventory = await analyzer.buildBranchInventory(sourceCode, requirement);

  // 3. case 一致性判定(LLM,批量)。
  logger.info("编排层:analyzeCases(LLM case 一致性判定)");
  const consistencies = await analyzer.analyzeCases(job.description, report, inventory);

  // 4. 差分覆盖率统计:covered = 各 case 触达分支的并集(仅统计 inventory 中存在的分支 id,
  //    防 LLM 幻觉 id 污染);uncovered = 清单中未被任何 case 触达的分支。
  const branchIds = new Set(inventory.branches.map((b) => b.id));
  const covered = new Set<string>();
  for (const c of consistencies) {
    for (const id of c.touchedBranches) {
      if (branchIds.has(id)) covered.add(id);
    }
  }
  const uncovered = inventory.branches.filter((b) => !covered.has(b.id)).map((b) => b.id);
  const consistency: ConsistencyReport = {
    inventory,
    cases: consistencies,
    coverage: { covered: [...covered], uncovered },
    augmentations: [],
  };
  logger.info(
    `编排层:差分覆盖率 = ${covered.size}/${inventory.branches.length} 分支 (uncovered=${uncovered.length})`,
  );

  // 5. flag-fail 标记:方式 B(strictNld)复制改判;方式 A(默认)仅报告标记,verdict 不变。
  if (strictNld) {
    applyStrictNld(report, consistencies, logger);
  }

  // 6. 覆盖缺口补测(有界,默认 0 轮 = 关闭)。
  if (uncovered.length > 0 && augmentationBudget > 0) {
    logger.info(`编排层:generateAugmentations(uncovered=${uncovered.length} 分支)`);
    const newCases = await analyzer.generateAugmentations(inventory, job.description);
    if (newCases.length > 0) {
      const augmentedDescription = { ...job.description, cases: [...job.description.cases, ...newCases] };
      logger.info(`编排层:并入 ${newCases.length} 个新 case 重验(augmentationBudget=${augmentationBudget})`);
      const augmentedReport = await verify({ ...job, description: augmentedDescription }, executor, logger);
      consistency.augmentations = newCases;
      if (strictNld) applyStrictNld(augmentedReport, consistencies, logger);
      return { report: augmentedReport, consistency, augmented: true };
    }
    logger.info("编排层:generateAugmentations 未产出新 case,保持原报告");
  }

  return { report, consistency, augmented: false };
}

/** 方式 B:recommend=flag-fail 且差分 verdict=pass 的 comparison 改判 fail(复制一份语义,记录原因)。 */
function applyStrictNld(
  report: VerificationReport,
  consistencies: ConsistencyReport["cases"],
  logger: Logger,
): void {
  let flagged = 0;
  for (const c of consistencies) {
    if (c.recommend !== "flag-fail") continue;
    const comparison = report.comparisons.find((cmp) => cmp.caseId === c.caseId);
    if (!comparison || comparison.verdict !== "pass") continue;
    comparison.verdict = "fail";
    comparison.details = [...c.reasons, ...comparison.details];
    flagged += 1;
  }
  if (flagged > 0) {
    // 重算报告统计(差分语义本身未改,仅 NLD 裁决改判;passRate 同步)。
    const passedCases = report.comparisons.filter((cmp) => cmp.verdict === "pass").length;
    const failedCases = report.comparisons.filter((cmp) => cmp.verdict === "fail").length;
    const divergentCases = report.comparisons.filter((cmp) => cmp.verdict === "divergent").length;
    report.passedCases = passedCases;
    report.failedCases = failedCases;
    report.divergentCases = divergentCases;
    report.passRate = report.totalCases === 0 ? 0 : passedCases / report.totalCases;
    logger.warn(`编排层(strictNld):${flagged} 个\"双侧一致但偏离需求\"的 case 改判 fail`);
  }
}
