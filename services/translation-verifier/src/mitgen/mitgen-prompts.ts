/**
 * MitGen 三组 prompt builder(冻结为稳定输出,供测试断言关键段落)。
 *
 * 1. buildScoringPrompt:片段批量打分(CamPri 简化版,单次调用);
 * 2. buildInputGenerationPrompt:片段级定向输入生成(受 pathCondition 引导);
 * 3. buildCorrespondencePrompt:目标侧片段对应性检查(允许结构重组,要求行为等价)。
 *
 * 设计要点:
 * - REQUIREMENT 永远排在最前(需求第一原则,与 TestMigrator 一致);
 * - pathCondition 必须出现在输入生成 prompt 中(片段级生成的关键载体);
 * - correspondence prompt 明确「允许结构重组,要求行为等价;correspondence 只进报告不进 verdict」。
 */
import type { CodeFragment } from "./types.js";

const SCORING_SCHEMA = `{
  "scores": [
    { "fragmentId": "frag-01", "llmRiskScore": 0.8, "llmFixabilityScore": 0.7, "rationale": "一句话理由" }
  ]
}`;

const INPUT_SCHEMA = `{
  "cases": [
    {
      "description": "该输入想覆盖的语义(一句话)",
      "inputs": [ { "type": "string|number|boolean|null|list|map", "value": ... } ]
    }
  ]
}`;

const CORRESPONDENCE_SCHEMA = `{
  "correspondences": [
    { "fragmentId": "frag-01", "correspondence": "equivalent|missing|divergent|unknown", "note": "一句话说明" }
  ]
}`;

/** 需求段(最高优先级,始终在最前)。 */
function requirementSection(requirement: string): string {
  return `REQUIREMENT
${requirement}`;
}

/** 源方法上下文段(带语言/仓库/路径元数据)。 */
function sourceSection(input: {
  sourceLanguage: string;
  sourceCode: string;
  repository?: string;
  sourcePath?: string;
}): string {
  return `SOURCE_METHOD
Source language: ${input.sourceLanguage}${input.repository ? `\nRepository: ${input.repository}` : ""}${input.sourcePath ? `\nPath: ${input.sourcePath}` : ""}
\`\`\`
${input.sourceCode}
\`\`\``;
}

/**
 * 片段批量打分 prompt(CamPri 简化版):输入源方法 + 候选片段,输出每个片段的
 * 翻译出错风险 / 替代实现易生成性 / 理由。单次 LLM 调用覆盖全部候选。
 */
export function buildScoringPrompt(
  input: { requirement: string; sourceLanguage: string; sourceCode: string; repository?: string; sourcePath?: string },
  fragments: CodeFragment[],
): string {
  const fragmentList = fragments
    .map((f) => `- id: ${f.id}
  kind: ${f.kind}
  pathCondition: ${f.pathCondition}
  features: ${f.features.join(", ") || "(无)"}
  code:
    ${f.code.split("\n").join("\n    ")}`)
    .join("\n");
  return `${requirementSection(input.requirement)}

${sourceSection(input)}

CANDIDATE_FRAGMENTS
The source method is decomposed into fragments (id/kind/pathCondition/features/code). For each fragment,
score two things:
- llmRiskScore: how likely a code translation of this fragment is to contain a bug (comparison boundaries,
  null/empty handling, string/collection operations, arithmetic are risk-prone). 0..1.
- llmFixabilityScore: how easy it is to generate a correct alternative implementation of this fragment
  (simple, self-contained fragments score high). 0..1.
Output one JSON object matching this exact schema (no markdown):
${SCORING_SCHEMA}

${fragmentList}`;
}

/**
 * 片段级定向输入生成 prompt:LLM 不需要推理整个方法的输出,只需构造满足
 * pathCondition 的整方法输入(每个片段最多 casesPerFragment 个),并覆盖该片段的
 * 边界(循环首/末次迭代、比较边界值、null/空输入等)。
 */
export function buildInputGenerationPrompt(
  input: { requirement: string; sourceLanguage: string; sourceCode: string; repository?: string; sourcePath?: string },
  fragment: CodeFragment,
  casesPerFragment: number,
  methodSignature?: string,
): string {
  return `${requirementSection(input.requirement)}

${sourceSection(input)}

TARGET_FRAGMENT
id: ${fragment.id}
kind: ${fragment.kind}
pathCondition: ${fragment.pathCondition}
features: ${fragment.features.join(", ") || "(无)"}
code:
  ${fragment.code.split("\n").join("\n  ")}
${methodSignature ? `\nMethod signature: ${methodSignature}\n` : ""}

TASK
Generate up to ${casesPerFragment} candidate inputs for the WHOLE method (the method is invoked once per input;
the inputs array is passed to the method in order). Each input MUST satisfy the pathCondition above, i.e. it must
actually reach the fragment at runtime (the guard/branch/loop body will be executed). Vary inputs to cover the
fragment's boundary cases: loop first/last iteration, comparison boundary values, null/empty inputs, etc.
You do NOT need to predict the method's output — the expected value is recorded by running the real source.
Each input must be JSON-safe (TypedValue: string|number|boolean|null|list|map).
Output one JSON object matching this exact schema (no markdown):
${INPUT_SCHEMA}`;
}

/**
 * 可达性失败后的反馈重试 prompt(Validator 模式,与方向2 的迭代修复同构但轻量):
 * 把「输入未到达片段」连同片段 pathCondition 反馈给 LLM,要求重新生成这些输入。
 */
export function buildRetryInputPrompt(
  input: { requirement: string; sourceLanguage: string; sourceCode: string; repository?: string; sourcePath?: string },
  fragment: CodeFragment,
  failedCases: Array<{ description: string; inputs: unknown[] }>,
): string {
  const failedList = failedCases
    .map((c, i) => `- candidate ${i + 1}: ${c.description}\n  inputs: ${JSON.stringify(c.inputs)}`)
    .join("\n");
  return `${requirementSection(input.requirement)}

${sourceSection(input)}

TARGET_FRAGMENT
id: ${fragment.id}
kind: ${fragment.kind}
pathCondition: ${fragment.pathCondition}
code:
  ${fragment.code.split("\n").join("\n  ")}

FEEDBACK
The following candidate inputs did NOT reach the fragment at runtime (the marker was not observed).
The inputs must satisfy the pathCondition so that the fragment's guard/branch/loop body actually executes.
Re-generate ${failedCases.length} replacement inputs that DO reach the fragment. Same output schema (no markdown):
${INPUT_SCHEMA}

Previous candidates (rejected):
${failedList}`;
}

/**
 * 目标侧片段对应性检查 prompt(一次性调用):把选中片段 + 目标方法交给 LLM,
 * 判断每个片段在目标侧是否行为等价。明确要求:允许结构重组(翻译可能重排/合并语句),
 * 仅当目标侧不存在等价逻辑或语义明显不同时标 missing/divergent。
 */
export function buildCorrespondencePrompt(
  input: { requirement: string; targetCode?: string },
  fragments: CodeFragment[],
): string {
  const fragmentList = fragments
    .map((f) => `- id: ${f.id}
  kind: ${f.kind}
  pathCondition: ${f.pathCondition}
  code:
    ${f.code.split("\n").join("\n    ")}`)
    .join("\n");
  return `${requirementSection(input.requirement)}

TARGET_METHOD(Java 翻译产物)
\`\`\`
${input.targetCode ?? "(目标源码未提供)"}
\`\`\`

FRAGMENTS_TO_CHECK
The source method was decomposed into the following fragments. For each fragment, determine whether the target
method contains behaviorally equivalent logic:
- equivalent: the target contains equivalent logic (structural reorganization is ALLOWED — the translation may
  reorder, merge, or restructure statements; what matters is behavioral equivalence).
- missing: the target has NO equivalent logic for this fragment (e.g. the branch was dropped).
- divergent: the target has logic that behaves differently for some input reaching this fragment.
- unknown: cannot determine.
Correspondence results go into a report only; they do not decide the verification verdict — the differential
verification is authoritative.
Output one JSON object matching this exact schema (no markdown):
${CORRESPONDENCE_SCHEMA}

${fragmentList}`;
}
