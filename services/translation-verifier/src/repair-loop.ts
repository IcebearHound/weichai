import { runClaude, type ClaudeClientOptions } from "./claude-client.js";
import type { TypedValue } from "./description.js";
import type { CaseResult } from "./result-capture.js";
import { verify, type VerificationJob, type VerificationReport } from "./verifier.js";
import type { DriverExecutor, SideSpec } from "./executor.js";
import { createLogger, type Logger } from "./logger.js";

export interface RepairDiagnosis {
  caseId: string;
  inputs: TypedValue[];
  source: CaseResult | null;
  target: CaseResult | null;
  details: string[];
  /** 需求裁决(差异探测器语义):目标侧是否符合需求。 */
  requirementVerdict?: "target-conforms" | "target-diverges";
}

export interface RepairAgentOptions extends ClaudeClientOptions {}

export interface RepairInput {
  sourceLanguage: string;
  sourceCode: string;
  target: { language: "Java"; className: string; method: string; signature: string };
  previousMethodCode: string;
  /** 用户需求原文(需求第一:修复以需求为准)。 */
  requirement: string;
  diagnosis: RepairDiagnosis[];
  /** 修复轮次(供日志展示;由 RepairLoop 传入)。 */
  round?: number;
}

export interface RepairAgentLike {
  repair(input: RepairInput, signal?: AbortSignal): Promise<string>;
}

const REPAIR_SYSTEM_PROMPT = `You are a translation repair specialist. A previous translation of a method
failed differential verification. Repair the target method implementation so that it matches the source
behavior for every failing case. Preserve the immutable target signature exactly. Output ONLY the repaired
target method code — a complete compilable file containing the target type with the method, no markdown
fences, no explanation.`;

export class RepairAgent implements RepairAgentLike {
  readonly #options: RepairAgentOptions;
  readonly #logger: Logger;
  constructor(options: RepairAgentOptions) {
    this.#options = options;
    this.#logger = options.logger ?? createLogger("repair");
  }
  async repair(input: RepairInput, signal?: AbortSignal): Promise<string> {
    this.#logger.info(`修复开始(round ${input.round ?? "?"},失败 ${input.diagnosis.length} 个 case)`);
    this.#logger.debug(`buildRepairPrompt 输出:\n${buildRepairPrompt(input)}`);
    try {
      // 架构修正:LLM 调度统一走 claude 子进程("Claude Code + DeepSeek" agent 架构),
      // 不再 DeepSeek HTTP 直调;system 提示与 user prompt 合并为单一 prompt。
      const content = await runClaude(`${REPAIR_SYSTEM_PROMPT}\n\n${buildRepairPrompt(input)}`, this.#options);
      const stripped = content.replace(/^```(?:java)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      if (!stripped) throw new Error("RepairAgent returned empty code.");
      this.#logger.debug(`修复产物:\n${stripped}`);
      return stripped;
    } catch (error) {
      this.#logger.error(`修复失败:${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}

export function buildRepairPrompt(input: RepairInput): string {
  const diagnosisText = input.diagnosis
    .map((d) =>
      JSON.stringify({
        caseId: d.caseId,
        inputs: d.inputs,
        source: d.source,
        target: d.target,
        details: d.details,
        requirementVerdict: d.requirementVerdict,
      }),
    )
    .join("\n");
  return `USER_REQUIREMENT (highest priority)
${input.requirement}

Source language: ${input.sourceLanguage}
Target signature: ${input.target.signature}

SOURCE_METHOD
\`\`\`
${input.sourceCode}
\`\`\`

PREVIOUS_TARGET_FILE
\`\`\`
${input.previousMethodCode}
\`\`\`

DIFFERENTIAL_DIAGNOSIS (failing cases)
${diagnosisText}

Repair the method so every failing case matches the source behavior. Preserve the target signature exactly.`;
}

export interface RepairLoopOptions {
  maxRounds?: number;
  repairAgent?: RepairAgentLike;
  rebuildTargetSide: (methodCode: string) => SideSpec;
  /** 注入的 logger;默认 createLogger("repair-loop")。 */
  logger?: Logger;
}

export interface RepairLoopResult {
  rounds: number;
  reports: VerificationReport[];
  finalReport: VerificationReport;
}

/**
 * 反馈修复闭环:verify → 仍有 fail/divergent 且轮次 < maxRounds → 构建诊断
 * (buildDiagnosis 从 report.comparisons 提取非 pass 项的 requirementVerdict)→
 * repairAgent.repair(携带需求原文)→ rebuildTargetSide(methodCode)→ 重新 verify。
 * 收敛:全 PASS(无 fail/divergent)或达到 maxRounds(验证 maxRounds+1 次)。
 * repair 抛错时该轮视为未修复(目标侧保持原样),错误记录在 repairErrors,继续下一轮。
 */
export class RepairLoop {
  readonly #maxRounds: number;
  readonly #repairAgent: RepairAgentLike;
  readonly #rebuildTargetSide: (methodCode: string) => SideSpec;
  readonly #logger: Logger;
  /** repair 抛错记录(本轮视为未修复,继续下一轮)。 */
  readonly repairErrors: unknown[] = [];

  constructor(options: RepairLoopOptions) {
    this.#maxRounds = options.maxRounds ?? 3;
    if (!options.repairAgent) throw new Error("RepairLoop requires a repairAgent.");
    this.#repairAgent = options.repairAgent;
    this.#rebuildTargetSide = options.rebuildTargetSide;
    this.#logger = options.logger ?? createLogger("repair-loop");
  }

  async run(job: VerificationJob, executor: DriverExecutor): Promise<RepairLoopResult> {
    const reports: VerificationReport[] = [];
    let currentJob = job;
    let rounds = 0;
    for (; rounds <= this.#maxRounds; rounds += 1) {
      const report = await verify(currentJob, executor);
      reports.push(report);
      const failedIds = report.comparisons.filter((c) => c.verdict === "fail").map((c) => c.caseId);
      const divergentIds = report.comparisons.filter((c) => c.verdict === "divergent").map((c) => c.caseId);
      this.#logger.info(
        `round ${rounds + 1} 验证:passRate=${report.passRate.toFixed(2)}, failed=[${failedIds.join(",")}], divergent=[${divergentIds.join(",")}]`,
      );
      if (report.failedCases === 0 && report.divergentCases === 0) break;
      if (rounds === this.#maxRounds) break;
      const diagnosis = buildDiagnosis(report, currentJob.description.cases);
      this.#logger.debug(
        `round ${rounds + 1} 诊断详情:\n${diagnosis.map((d) => JSON.stringify(d)).join("\n")}`,
      );
      try {
        const methodCode = await this.#repairAgent.repair({
          sourceLanguage: currentJob.source.language,
          sourceCode: firstSourceContent(currentJob.source),
          target: {
            language: "Java",
            className: currentJob.description.target.className,
            method: currentJob.description.target.method,
            signature: `${currentJob.description.target.className}.${currentJob.description.target.method}`,
          },
          previousMethodCode: firstSourceContent(currentJob.target),
          requirement: currentJob.description.requirement ?? "",
          diagnosis,
          round: rounds + 1,
        });
        currentJob = { ...currentJob, target: this.#rebuildTargetSide(methodCode) };
      } catch (error) {
        // repair 失败:本轮视为未修复,目标侧保持原样,进入下一轮验证。
        this.repairErrors.push(error);
        this.#logger.warn(`修复无效(round ${rounds + 1}):${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { rounds: rounds + 1, reports, finalReport: reports.at(-1) as VerificationReport };
  }
}

/** 从报告提取非 pass 项的诊断(携带需求裁决 requirementVerdict)。 */
function buildDiagnosis(report: VerificationReport, cases: VerificationJob["description"]["cases"]): RepairDiagnosis[] {
  const caseByInput = new Map(cases.map((c) => [c.id, c.inputs]));
  return report.comparisons
    .filter((c) => c.verdict !== "pass")
    .map((c) => ({
      caseId: c.caseId,
      inputs: caseByInput.get(c.caseId) ?? [],
      source: c.source,
      target: c.target,
      details: c.details,
      requirementVerdict: c.requirementVerdict,
    }));
}

function firstSourceContent(side: SideSpec): string {
  return side.sourceFiles.map((f) => f.content).join("\n");
}
