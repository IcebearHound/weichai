import type { TestDescription, VerifierLanguage } from "./description.js";
import { compareCases, validateAgainstExpected, type CaseComparison, type ComparisonOptions } from "./comparator.js";
import { parseSideResults, type SideResults } from "./result-capture.js";
import type { CompileOutcome, DriverExecutor, RunOutcome, SideSpec } from "./executor.js";
import { createLogger, type Logger } from "./logger.js";

export interface VerificationJob {
  description: TestDescription;
  source: SideSpec;
  target: SideSpec;
  options?: ComparisonOptions;
}

export interface SideRunInfo {
  language: VerifierLanguage;
  compile: CompileOutcome;
  run: RunOutcome | null;
  results: SideResults | null;
}

/**
 * 公共辅助:compile → run(编译成功才跑)→ parseSideResults(运行成功才解析)。
 * verify(双轨)与 aid-verifier(变体轨道)共用;label 仅作结果侧标记
 * (现有双轨传 "source"/"target",变体轨道传 "Variant_<k>"),默认 "source"。
 */
export async function executeSide(
  executor: DriverExecutor,
  side: SideSpec,
  label: string = "source",
): Promise<SideRunInfo> {
  const compile = await executor.compile(side);
  const run = compile.success ? await executor.run(side) : null;
  const results = run && run.exitCode === 0 ? parseSideResults(label, run.stdout) : null;
  return { language: side.language, compile, run, results };
}

export interface VerificationReport {
  schemaVersion: "1.0";
  source: SideRunInfo;
  target: SideRunInfo;
  comparisons: CaseComparison[];
  passRate: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  divergentCases: number;
}

/**
 * 双轨道验证编排器:
 * 1. 双侧 compile → 编译成功才 run → 运行成功才 parseSideResults;
 * 2. compareCases 做差分比较(差异探测器);
 * 3. 黄金校验(需求第一):用描述声明的 expected(需求黄金值)校验目标侧,产出 requirementVerdict,
 *    并把「两侧一致但都偏离 expected」改判为 fail —— 差分验证只探测差异,不充当裁判。
 */
export async function verify(
  job: VerificationJob,
  executor: DriverExecutor,
  logger: Logger = createLogger("verify"),
): Promise<VerificationReport> {
  const sourceInfo = await executeSide(executor, job.source, "source");
  const targetInfo = await executeSide(executor, job.target, "target");
  const sourceCompile = sourceInfo.compile;
  const targetCompile = targetInfo.compile;
  const sourceRun = sourceInfo.run;
  const targetRun = targetInfo.run;
  const sourceResults = sourceInfo.results;
  const targetResults = targetInfo.results;

  // 「可用结果」= 该侧解析成功且至少有一个 case 结果。parseSideResults 在 stdout 非法/无 results 数组时
  // 返回 results=[] + parseErrors 的非空对象(而非 null),仅靠 truthiness 判断会误入比较分支,
  // 两侧都解析失败时 compareCases 产出空 comparisons → totalCases=0。这里显式要求两侧均有可用结果,
  // 否则按描述 case 全 DIVERGENT 兜底。
  const sourceUsable = sourceResults !== null && sourceResults.results.length > 0;
  const targetUsable = targetResults !== null && targetResults.results.length > 0;

  let comparisons: CaseComparison[];
  if (sourceUsable && targetUsable) {
    comparisons = compareCases(sourceResults, targetResults, job.options);
    // 黄金校验 + 需求裁决(需求第一:差分验证是差异探测器而非裁判)。
    const expectedByCase = new Map(job.description.cases.map((c) => [c.id, c.expected]));
    for (const comparison of comparisons) {
      const expected = expectedByCase.get(comparison.caseId);
      if (!expected || !comparison.target) continue;
      const issues = validateAgainstExpected(comparison.target, expected);
      if (comparison.verdict !== "pass") {
        // 两侧不一致:需求裁决 —— 目标侧是否符合需求(expected)。
        if (issues.length === 0) {
          comparison.requirementVerdict = "target-conforms";
          comparison.details = ["target matches declared requirement; divergence is source-side", ...comparison.details];
        } else {
          comparison.requirementVerdict = "target-diverges";
          comparison.details = [...comparison.details, ...issues];
        }
      } else if (issues.length > 0) {
        // 两侧一致但都偏离声明期望 → fail。
        comparison.verdict = "fail";
        comparison.details = issues;
      }
    }
  } else {
    comparisons = job.description.cases.map((c) => ({
      caseId: c.id,
      verdict: "divergent",
      source: null,
      target: null,
      details: [
        sourceUsable ? "" : "Source side produced no usable results.",
        targetUsable ? "" : "Target side produced no usable results.",
      ].filter(Boolean),
    }));
  }

  // 报告按描述声明的 case 顺序呈现(比较本身按 caseId 对齐)。
  const caseOrder = new Map(job.description.cases.map((c, i) => [c.id, i]));
  comparisons.sort((a, b) => (caseOrder.get(a.caseId) ?? Number.POSITIVE_INFINITY) - (caseOrder.get(b.caseId) ?? Number.POSITIVE_INFINITY));

  const passedCases = comparisons.filter((c) => c.verdict === "pass").length;
  const failedCases = comparisons.filter((c) => c.verdict === "fail").length;
  const divergentCases = comparisons.filter((c) => c.verdict === "divergent").length;
  const totalCases = comparisons.length;
  const passRate = totalCases === 0 ? 0 : passedCases / totalCases;

  logger.info(`验证完成:passRate=${passRate.toFixed(2)} (pass=${passedCases} fail=${failedCases} divergent=${divergentCases})`);
  for (const comparison of comparisons) {
    logger.debug(
      `case ${comparison.caseId}: ${comparison.verdict}${comparison.requirementVerdict ? ` [${comparison.requirementVerdict}]` : ""}`,
    );
  }

  return {
    schemaVersion: "1.0",
    source: sourceInfo,
    target: targetInfo,
    comparisons,
    passRate,
    totalCases,
    passedCases,
    failedCases,
    divergentCases,
  };
}
