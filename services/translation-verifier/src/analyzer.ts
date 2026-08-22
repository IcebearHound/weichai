import { runClaude, type ClaudeClientOptions } from "./claude-client.js";
import type { TestCase, TestDescription } from "./description.js";
import type { DriverExecutor, SideSpec } from "./executor.js";
import { createLogger, type Logger } from "./logger.js";
import type { VerificationReport } from "./verifier.js";

/**
 * 方向 2(DISTINCT):描述引导的分支一致性分析器。
 *
 * 核心主张:非回归场景下被测方法本身可能带缺陷,自动测试生成会把缺陷实现当 ground truth,
 * 产出\"复制缺陷行为\"的测试(差分两侧一致 → 全 PASS,但 DDR=0)。Analyzer 以 NLD
 * (需求 + case.description + case.branches)为唯一 truth anchor,做分支级一致性判定:
 * - 分支清单构建(Branch Inventory):对源方法做一次 LLM 控制流分析,逐分支给出语义与需求一致性;
 * - case 触达判定(Branch Touching):判定每个 case 触达哪些分支(近似覆盖,无插桩证据);
 * - 断言语义一致性判定(Assertion Consistency):expected 是否符合 NLD 语义,而非符合(可能有缺陷的)源实现。
 *
 * 覆盖率退化方案:预留 CoverageProvider 接口,有插桩时返回真实分支覆盖(analyzeCases 采用插桩
 * 证据,不再依赖 LLM 触达判定),无插桩返回 null → 退回 LLM 判定。Analyzer 主体不变。
 */

// ---------------------------------------------------------------------------
// 分支清单模型
// ---------------------------------------------------------------------------

/** 单个控制流分支(源方法侧;跨语言时源侧是唯一有完整代码的一侧)。 */
export interface BranchInfo {
  id: string; // "b1","b2",...
  kind: "if" | "switch" | "loop" | "boundary" | "implicit" | "error";
  location: string; // 代码位置描述
  condition: string; // 分支条件的自然语言化
  semantics: string; // 该分支在需求下的预期行为
  nldConsistent: boolean; // 与需求是否一致
  defectNote?: string; // 不一致时的疑似缺陷
}

/** LLM 分支清单(对应论文 Analyzer step 1+2 合并)。 */
export interface BranchInventory {
  methodId: string; // `${className}.${method}`
  methodSummary: string; // LLM 重述的需求语义(补充 NLD)
  branches: BranchInfo[];
}

// ---------------------------------------------------------------------------
// case 一致性模型
// ---------------------------------------------------------------------------

/** 单个 case 的 NLD 一致性判定。 */
export interface CaseConsistency {
  caseId: string;
  touchedBranches: string[]; // 判定触达的分支 id
  assertionConsistent: boolean; // expected 与 NLD 语义一致(而非与源实现一致)
  nldVerdict: "conforms" | "diverges" | "unverified"; // 三态裁决,宁可不判不误报
  recommend: "ok" | "flag-fail" | "fix-assertion" | "add-case";
  reasons: string[];
}

/** Analyzer 完整输出。 */
export interface ConsistencyReport {
  inventory: BranchInventory;
  cases: CaseConsistency[];
  coverage: { covered: string[]; uncovered: string[] }; // 差分覆盖率 = covered.length / total
  augmentations: TestCase[]; // LLM 为覆盖缺口生成的新 case(由调用方决定是否并入描述重验)
}

// ---------------------------------------------------------------------------
// 覆盖率提供者(退化方案:无插桩 → null → 退回 LLM 判定)
// ---------------------------------------------------------------------------

/** 插桩分支覆盖结果;covered 为触达的分支 id(与 BranchInventory.branches[].id 对齐)。 */
export interface BranchCoverage {
  covered: string[];
  /** 插桩证据描述(供 prompt/日志)。 */
  evidence?: string;
}

/**
 * 覆盖率提供者接口:有插桩时返回真实分支覆盖,无插桩返回 null → Analyzer 退回 LLM 判断。
 * 未来接入 JaCoCo / dotnet-coverage 时实现该接口即可,Analyzer 主体不变。
 */
export interface CoverageProvider {
  getCoverage(side: SideSpec, executor: DriverExecutor, description: TestDescription): Promise<BranchCoverage | null>;
}

/** 无插桩时的默认提供者:恒返回 null(触发 LLM 退化判定)。 */
export class NoneCoverageProvider implements CoverageProvider {
  async getCoverage(): Promise<null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Analyzer 接口与 LLM 实现
// ---------------------------------------------------------------------------

export interface AnalyzerLike {
  buildBranchInventory(sourceCode: string, requirement: string, signal?: AbortSignal): Promise<BranchInventory>;
  analyzeCases(
    description: TestDescription,
    report: VerificationReport,
    inventory: BranchInventory,
    signal?: AbortSignal,
  ): Promise<CaseConsistency[]>;
  generateAugmentations(inventory: BranchInventory, description: TestDescription, signal?: AbortSignal): Promise<TestCase[]>;
}

export interface LlmAnalyzerOptions extends ClaudeClientOptions {
  coverageProvider?: CoverageProvider;
  /**
   * coverage 查询使用的侧(通常为目标侧,含驱动与源文件);使用 coverageProvider 时必须注入。
   */
  coverageSide?: SideSpec;
  /** 透传给 CoverageProvider.getCoverage 的执行器;使用 coverageProvider 时必须注入。 */
  executor?: DriverExecutor;
}

const ANALYZER_SYSTEM_PROMPT = `You are a branch-level consistency analyzer for differential translation verification.
You judge whether test expectations match the natural-language requirement (NLD), NOT whether they match
the (possibly defective) source implementation. The requirement is the ONLY ground truth. The source
method is a reference implementation that may contain defects.
Respond with ONLY the requested JSON, no markdown, no explanation.`;

/**
 * LLM 分支一致性分析器:三个方法各一次 LLM 调用(方法级),统一走 claude 子进程(runClaude,可注入)。
 */
export class LlmAnalyzer implements AnalyzerLike {
  readonly #options: LlmAnalyzerOptions;
  readonly #logger: Logger;

  constructor(options: LlmAnalyzerOptions) {
    this.#options = options;
    this.#logger = options.logger ?? createLogger("analyzer");
  }

  /** 1. 分支清单构建:对源方法做一次 LLM 控制流分析(枚举分支 + 需求一致性判定)。 */
  async buildBranchInventory(sourceCode: string, requirement: string, signal?: AbortSignal): Promise<BranchInventory> {
    this.#logger.info("buildBranchInventory 开始(LLM 分支清单构建)");
    const raw = await runClaude(
      `${ANALYZER_SYSTEM_PROMPT}\n\n${buildInventoryPrompt(sourceCode, requirement)}`,
      this.#options,
    );
    this.#logger.debug(`buildBranchInventory LLM 原始返回:\n${raw}`);
    const parsed = parseLlmJson(raw);
    return normalizeInventory(parsed);
  }

  /**
   * 2+3. case 一致性判定:判定每个 case 触达的分支、断言与 NLD 的一致性。
   * 若注入的 CoverageProvider 返回真实覆盖 → 把插桩证据并入 prompt(触达判定以插桩为准);
   * 返回 null → 完全走 LLM 退化判定。
   */
  async analyzeCases(
    description: TestDescription,
    report: VerificationReport,
    inventory: BranchInventory,
    signal?: AbortSignal,
  ): Promise<CaseConsistency[]> {
    this.#logger.info("analyzeCases 开始(LLM case 一致性判定)");
    let coverageEvidence: string | null = null;
    if (this.#options.coverageProvider) {
      if (!this.#options.coverageSide || !this.#options.executor) {
        throw new Error(
          "LlmAnalyzer: coverageProvider 已注入但缺少 coverageSide/executor(使用真实插桩覆盖时必须提供)。",
        );
      }
      const coverage = await this.#options.coverageProvider.getCoverage(
        this.#options.coverageSide,
        this.#options.executor,
        description,
      );
      coverageEvidence = coverage ? `INSTRUMENTED_COVERAGE\n${JSON.stringify(coverage)}\n` : null;
      this.#logger.info(coverageEvidence ? "analyzeCases: 使用插桩覆盖证据(非 LLM 退化判定)" : "analyzeCases: 无插桩覆盖,退回 LLM 判定");
    }
    const raw = await runClaude(
      `${ANALYZER_SYSTEM_PROMPT}\n\n${buildConsistencyPrompt(description, report, inventory, coverageEvidence)}`,
      this.#options,
    );
    this.#logger.debug(`analyzeCases LLM 原始返回:\n${raw}`);
    const parsed = parseLlmJson(raw);
    return normalizeConsistencies(parsed, description);
  }

  /** 4. 覆盖缺口补测:为未触达分支生成新 case(带 description 三要素 + branches 标签)。 */
  async generateAugmentations(
    inventory: BranchInventory,
    description: TestDescription,
    signal?: AbortSignal,
  ): Promise<TestCase[]> {
    this.#logger.info("generateAugmentations 开始(LLM 补测生成)");
    const covered = new Set<string>();
    for (const c of description.cases) for (const b of c.branches ?? []) covered.add(b);
    const uncovered = inventory.branches.filter((b) => !covered.has(b.id));
    const raw = await runClaude(
      `${ANALYZER_SYSTEM_PROMPT}\n\n${buildAugmentationPrompt(inventory, description, uncovered)}`,
      this.#options,
    );
    this.#logger.debug(`generateAugmentations LLM 原始返回:\n${raw}`);
    const parsed = parseLlmJson(raw);
    return normalizeAugmentations(parsed, inventory);
  }
}

// ---------------------------------------------------------------------------
// prompt 构建(结构参考 DISTINCT/Test_Iterator_deepseek.py 的 repair_flag==2 三步)
// ---------------------------------------------------------------------------

/** 步骤 1:方法分支分析(枚举 if/switch/循环/边界/隐式分支 + 需求语义)。 */
export function buildInventoryPrompt(sourceCode: string, requirement: string): string {
  return `REQUIREMENT (the ONLY ground truth)
${requirement}

SOURCE_METHOD (reference implementation; may contain defects)
\`\`\`
${sourceCode}
\`\`\`

Enumerate ALL control-flow branches of the source method:
- if/else branches, switch cases (including default),
- loops (including loop-exit conditions and empty-loop paths),
- boundary conditions (null, empty, 0, extremes, off-by-one),
- implicit branches (default paths, undefined behavior).
For each branch, describe its natural-language semantics under the requirement, and judge whether the
branch behavior is consistent with the requirement (nldConsistent). If inconsistent, give a defectNote
describing the suspected defect.

Output ONLY JSON:
{
  "methodId": "<ClassName>.<method>",
  "methodSummary": "<one-paragraph restatement of the requirement semantics>",
  "branches": [
    {
      "id": "b1",
      "kind": "if" | "switch" | "loop" | "boundary" | "implicit" | "error",
      "location": "<code location description>",
      "condition": "<natural-language branch condition>",
      "semantics": "<expected behavior of this branch under the requirement>",
      "nldConsistent": true,
      "defectNote": "<only when nldConsistent is false>"
    }
  ]
}`;
}

/** 步骤 2:需求对比 + case 判定(触达分支 / 断言 vs NLD / 三态裁决)。 */
export function buildConsistencyPrompt(
  description: TestDescription,
  report: VerificationReport,
  inventory: BranchInventory,
  coverageEvidence: string | null,
): string {
  const comparisonLines = report.comparisons
    .map((c) =>
      JSON.stringify({
        caseId: c.caseId,
        verdict: c.verdict,
        requirementVerdict: c.requirementVerdict,
        details: c.details,
      }),
    )
    .join("\n");
  return `REQUIREMENT (the ONLY ground truth)
${description.requirement ?? "(no method-level requirement provided; use each case description as NLD)"}

TEST_DESCRIPTION
\`\`\`
${JSON.stringify(description)}
\`\`\`

DIFFERENTIAL_VERIFICATION_REPORT (per case: pass = both sides agree, fail = sides diverge)
\`\`\`
${comparisonLines}
\`\`\`

BRANCH_INVENTORY
\`\`\`
${JSON.stringify(inventory)}
\`\`\`
${coverageEvidence ? `${coverageEvidence}\n` : ""}
For each case in TEST_DESCRIPTION:
1. Determine which branches it touches (touchedBranches: subset of inventory branch ids). When
   INSTRUMENTED_COVERAGE is present, rely on it instead of guessing.
2. Judge whether the case's expected value matches the NLD semantics (requirement + case description +
   declared branches), NOT whether it matches the source implementation:
   - both sides agree (verdict "pass") but expected diverges from NLD → this is a "defect-copying
     assertion"; nldVerdict "diverges", recommend "flag-fail";
   - expected conforms to NLD → nldVerdict "conforms", recommend "ok";
   - NLD too thin / input ambiguous to judge → nldVerdict "unverified" (do NOT hard-fail).
   Use "fix-assertion" when the expected can be corrected to conform, and "add-case" when the branch
   coverage shows a gap for this case.

Output ONLY a JSON array:
[
  {
    "caseId": "<id>",
    "touchedBranches": ["b1", "b2"],
    "assertionConsistent": true,
    "nldVerdict": "conforms" | "diverges" | "unverified",
    "recommend": "ok" | "flag-fail" | "fix-assertion" | "add-case",
    "reasons": ["<reason>"]
  }
]`;
}

/** 步骤 3:为覆盖缺口生成缺失测试(有界补测)。 */
export function buildAugmentationPrompt(
  inventory: BranchInventory,
  description: TestDescription,
  uncoveredBranches: BranchInfo[],
): string {
  return `REQUIREMENT (the ONLY ground truth)
${description.requirement ?? "(no method-level requirement provided)"}

BRANCH_INVENTORY
\`\`\`
${JSON.stringify(inventory)}
\`\`\`

UNCOVERED_BRANCHES (branch coverage gap)
\`\`\`
${JSON.stringify(uncoveredBranches)}
\`\`\`

EXISTING_CASES
\`\`\`
${JSON.stringify(description.cases)}
\`\`\`

Generate additional test cases targeting the uncovered branches. Each case MUST:
- use the same TestCase schema (id, description, optional branches, inputs, expected);
- carry a rich description with the three parts: 场景 / 触发行为 / 目标分支或边界;
- declare the target branch in the "branches" field (e.g. "b3" or "boundary: off-by-one");
- derive expected from the requirement (NLD), not from the defective source implementation.
Output ONLY a JSON array of TestCase objects.`;
}

// ---------------------------------------------------------------------------
// LLM 输出解析与规范化(容错,不信任 LLM 严格遵循 schema)
// ---------------------------------------------------------------------------

/** 提取 LLM 输出中的 JSON(strip 代码围栏;顶层数组或对象均支持)。 */
function parseLlmJson(raw: string): unknown {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const arrayStart = stripped.indexOf("[");
    const startIndex = start < 0 ? arrayStart : arrayStart >= 0 && arrayStart < start ? arrayStart : start;
    if (startIndex < 0) throw new Error("Analyzer LLM output did not contain a JSON value.");
    const endIndex = Math.max(stripped.lastIndexOf("}"), stripped.lastIndexOf("]"));
    if (endIndex <= startIndex) throw new Error("Analyzer LLM output did not contain a complete JSON value.");
    return JSON.parse(stripped.slice(startIndex, endIndex + 1));
  }
}

function normalizeInventory(value: unknown): BranchInventory {
  const v = (value ?? {}) as Record<string, unknown>;
  const branches = Array.isArray(v.branches) ? v.branches : [];
  const methodId = typeof v.methodId === "string" && v.methodId.trim() ? v.methodId : "unknown.unknown";
  const methodSummary = typeof v.methodSummary === "string" ? v.methodSummary : "";
  const normalized: BranchInfo[] = [];
  branches.forEach((raw, i) => {
    const b = (raw ?? {}) as Record<string, unknown>;
    const kinds = new Set(["if", "switch", "loop", "boundary", "implicit", "error"]);
    const kind = kinds.has(String(b.kind)) ? (b.kind as BranchInfo["kind"]) : "implicit";
    const defectNote = typeof b.defectNote === "string" && b.defectNote.trim() ? b.defectNote : undefined;
    normalized.push({
      id: typeof b.id === "string" && b.id.trim() ? b.id : `b${i + 1}`,
      kind,
      location: typeof b.location === "string" ? b.location : "",
      condition: typeof b.condition === "string" ? b.condition : "",
      semantics: typeof b.semantics === "string" ? b.semantics : "",
      nldConsistent: b.nldConsistent !== false,
      ...(defectNote === undefined ? {} : { defectNote }),
    });
  });
  return { methodId, methodSummary, branches: normalized };
}

function normalizeConsistencies(value: unknown, description: TestDescription): CaseConsistency[] {
  const rawList = Array.isArray(value) ? value : Array.isArray((value as Record<string, unknown>)?.cases)
    ? ((value as Record<string, unknown>).cases as unknown[])
    : [];
  const validIds = new Set(description.cases.map((c) => c.id));
  const result: CaseConsistency[] = [];
  for (const raw of rawList) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const caseId = typeof c.caseId === "string" ? c.caseId : "";
    if (!caseId || !validIds.has(caseId)) continue;
    const touched = Array.isArray(c.touchedBranches)
      ? c.touchedBranches.filter((b): b is string => typeof b === "string" && b.trim() !== "")
      : [];
    const verdicts = new Set(["conforms", "diverges", "unverified"]);
    const recommends = new Set(["ok", "flag-fail", "fix-assertion", "add-case"]);
    const nldVerdict = verdicts.has(String(c.nldVerdict)) ? (c.nldVerdict as CaseConsistency["nldVerdict"]) : "unverified";
    const recommend = recommends.has(String(c.recommend)) ? (c.recommend as CaseConsistency["recommend"]) : "ok";
    const reasons = Array.isArray(c.reasons) ? c.reasons.filter((r): r is string => typeof r === "string") : [];
    result.push({
      caseId,
      touchedBranches: touched,
      assertionConsistent: c.assertionConsistent !== false,
      nldVerdict,
      recommend,
      reasons,
    });
  }
  return result;
}

function normalizeAugmentations(value: unknown, inventory: BranchInventory): TestCase[] {
  const rawList = Array.isArray(value) ? value : Array.isArray((value as Record<string, unknown>)?.cases)
    ? ((value as Record<string, unknown>).cases as unknown[])
    : [];
  const result: TestCase[] = [];
  for (const raw of rawList) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const c = raw as Record<string, unknown>;
    const id = typeof c.id === "string" && c.id.trim() ? c.id : "";
    if (!id) continue;
    const branches = Array.isArray(c.branches)
      ? c.branches.filter((b): b is string => typeof b === "string" && b.trim() !== "")
      : undefined;
    result.push({
      id,
      ...(typeof c.description === "string" ? { description: c.description } : {}),
      ...(branches === undefined ? {} : { branches }),
      inputs: Array.isArray(c.inputs) ? (c.inputs as TestCase["inputs"]) : [],
      expected: c.expected as TestCase["expected"],
    });
  }
  // 引用分支 id 时只保留 inventory 中存在的(防 LLM 幻觉污染覆盖统计)。
  const known = new Set(inventory.branches.map((b) => b.id));
  for (const testCase of result) {
    if (testCase.branches !== undefined) {
      testCase.branches = testCase.branches.filter((b) => known.has(b));
    }
  }
  return result;
}
