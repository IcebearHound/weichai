import { completeWithDeepSeek } from "@forexplore/adaptation-service";
import type { TypedValue } from "./description.js";
import type { CaseResult } from "./result-capture.js";
import { verify, type VerificationJob, type VerificationReport } from "./verifier.js";
import type { DriverExecutor, SideSpec } from "./executor.js";

export interface RepairDiagnosis {
  caseId: string;
  inputs: TypedValue[];
  source: CaseResult | null;
  target: CaseResult | null;
  details: string[];
  /** 需求裁决(差异探测器语义):目标侧是否符合需求。 */
  requirementVerdict?: "target-conforms" | "target-diverges";
}

export interface RepairAgentOptions {
  apiKey: string;
  request?: typeof globalThis.fetch;
}

export interface RepairInput {
  sourceLanguage: string;
  sourceCode: string;
  target: { language: "Java"; className: string; method: string; signature: string };
  previousMethodCode: string;
  /** 用户需求原文(需求第一:修复以需求为准)。 */
  requirement: string;
  diagnosis: RepairDiagnosis[];
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
  constructor(options: RepairAgentOptions) {
    this.#options = options;
  }
  async repair(input: RepairInput, signal?: AbortSignal): Promise<string> {
    const content = await completeWithDeepSeek(
      [
        { role: "system", content: REPAIR_SYSTEM_PROMPT },
        { role: "user", content: buildRepairPrompt(input) },
      ],
      { apiKey: this.#options.apiKey, request: this.#options.request, temperature: 0.1 },
      signal,
    );
    const stripped = content.replace(/^```(?:java)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    if (!stripped) throw new Error("RepairAgent returned empty code.");
    return stripped;
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
  /** repair 抛错记录(本轮视为未修复,继续下一轮)。 */
  readonly repairErrors: unknown[] = [];

  constructor(options: RepairLoopOptions) {
    this.#maxRounds = options.maxRounds ?? 3;
    if (!options.repairAgent) throw new Error("RepairLoop requires a repairAgent.");
    this.#repairAgent = options.repairAgent;
    this.#rebuildTargetSide = options.rebuildTargetSide;
  }

  async run(job: VerificationJob, executor: DriverExecutor): Promise<RepairLoopResult> {
    const reports: VerificationReport[] = [];
    let currentJob = job;
    let rounds = 0;
    for (; rounds <= this.#maxRounds; rounds += 1) {
      const report = await verify(currentJob, executor);
      reports.push(report);
      if (report.failedCases === 0 && report.divergentCases === 0) break;
      if (rounds === this.#maxRounds) break;
      const diagnosis = buildDiagnosis(report, currentJob.description.cases);
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
        });
        currentJob = { ...currentJob, target: this.#rebuildTargetSide(methodCode) };
      } catch (error) {
        // repair 失败:本轮视为未修复,目标侧保持原样,进入下一轮验证。
        this.repairErrors.push(error);
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
