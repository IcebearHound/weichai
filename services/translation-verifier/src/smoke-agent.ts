/**
 * SmokeAgent 控制器:agent 驱动循环 + stateless replay 多轮对话 + 收敛判定 + SmokeReport 组装。
 *
 * 循环(2.1):
 *   until action=finish 或 step ≥ maxSteps:
 *     1. buildTurnPrompt(system, history, 当前阶段指令) → runClaude(单轮,可注入 spawnClaude)
 *     2. parseAction(LLM stdout) → SmokeAction | 解析失败→格式错误 observation 重试(≤2)
 *     3. dispatch(action) → observation(文本);history += [assistant 动作, observation]
 *
 * 阶段不硬编码状态机:通过提示词逐步引导 + 工具前置条件(observation 反馈)自愈;
 * 收敛 = agent finish 且全部 plan case 裁决为 pass/accepted-diff;
 * 未收敛不抛错(报告 converged=false,由调用方裁决)。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { runClaude, type ClaudeClientOptions } from "./claude-client.js";
import type { TargetLanguage, VerifierLanguage } from "./description.js";
import type { DriverExecutor } from "./executor.js";
import { RealDriverExecutor } from "./executor.js";
import { createLogger, type Logger } from "./logger.js";
import { parseAction } from "./smoke-proto.js";
import {
  SMOKE_SYSTEM_PROMPT,
  buildBriefingPrompt,
  buildComparePrompt,
  buildCompilePrompt,
  buildFinishPrompt,
  buildFixPrompt,
  buildJudgePrompt,
  buildPlanPrompt,
  buildRunPrompt,
  buildTurnPrompt,
  buildWriteRunnerPrompt,
  type SmokeTaskBrief,
} from "./smoke-prompts.js";
import { SmokeTools } from "./smoke-tools.js";
import type {
  SmokeAction,
  SmokeContextState,
  SmokeReport,
  SmokeSide,
} from "./smoke-types.js";

export interface SmokeAgentOptions extends ClaudeClientOptions {
  /** 用户需求(需求第一,必填)。 */
  requirement: string;
  sourceLang: VerifierLanguage;
  targetLang: TargetLanguage;
  /** 源侧目录(推荐;与 sourceFile 二选一,可同时给:file 用于模块文件,dir 用于探索根)。 */
  sourceDir?: string;
  sourceFile?: string;
  /** 目标侧目录(推荐;与 targetFile 二选一)。 */
  targetDir?: string;
  targetFile?: string;
  /** 目标签名提示(可选;缺省由 agent read_file 自行核实)。 */
  targetClass?: string;
  targetMethod?: string;
  /** 循环步数上限,默认 40。 */
  maxSteps?: number;
  /** 修复轮数上限,默认 3。 */
  maxRounds?: number;
  /** 注入的 executor(测试=FakeDriverExecutor;缺省=RealDriverExecutor)。 */
  executor?: DriverExecutor;
  logger?: Logger;
}

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_MAX_ROUNDS = 3;
const MAX_PARSE_RETRIES = 2;

/** 冒烟冒烟语言对应的模块文件扩展名(list_files/read_file 与模块收集共用)。 */
const LANGUAGE_EXTENSIONS: Record<VerifierLanguage, string> = {
  Java: ".java",
  "C#": ".cs",
  Python: ".py",
  TypeScript: ".ts",
};

const IGNORED_DIR_NAMES = new Set(["target", "obj", "bin", "node_modules", ".git", ".vs", ".idea", "dist", "out"]);

export class SmokeAgent {
  readonly #options: Required<Pick<SmokeAgentOptions, "requirement" | "sourceLang" | "targetLang">> &
    Pick<SmokeAgentOptions, "sourceDir" | "sourceFile" | "targetDir" | "targetFile" | "targetClass" | "targetMethod">;
  readonly #maxSteps: number;
  readonly #maxRounds: number;
  readonly #claudeOptions: ClaudeClientOptions;
  readonly #logger: Logger;
  readonly #state: SmokeContextState;
  readonly #brief: SmokeTaskBrief;
  readonly #tools: SmokeTools;

  constructor(options: SmokeAgentOptions) {
    if (!options.requirement.trim()) throw new Error("SmokeAgentOptions.requirement 不能为空。");
    const sourceRoot = resolve(options.sourceDir ?? (options.sourceFile ? dirname(options.sourceFile) : ""));
    const targetRoot = resolve(options.targetDir ?? (options.targetFile ? dirname(options.targetFile) : ""));
    if (!sourceRoot || !existsSync(sourceRoot)) {
      throw new Error("必须提供存在的 sourceDir 或 sourceFile(源侧模块目录)。");
    }
    if (!targetRoot || !existsSync(targetRoot)) {
      throw new Error("必须提供存在的 targetDir 或 targetFile(目标侧模块目录)。");
    }
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.#options = {
      requirement: options.requirement,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      sourceDir: options.sourceDir,
      sourceFile: options.sourceFile,
      targetDir: options.targetDir,
      targetFile: options.targetFile,
      targetClass: options.targetClass,
      targetMethod: options.targetMethod,
    };
    this.#logger = options.logger ?? createLogger("smoke-agent");
    this.#claudeOptions = {
      apiKey: options.apiKey,
      model: options.model,
      timeoutMs: options.timeoutMs,
      spawnClaude: options.spawnClaude,
      logger: this.#logger,
    };

    const sourceModuleFiles = collectModuleFiles(sourceRoot, options.sourceLang, options.sourceFile);
    const targetModuleFiles = collectModuleFiles(targetRoot, options.targetLang, options.targetFile);
    this.#state = {
      requirement: options.requirement,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      sourceRoot,
      targetRoot,
      sourceModuleFiles,
      targetModuleFiles,
      sourceProjectRoot: mavenProjectRoot(sourceRoot, options.sourceLang),
      targetProjectRoot: mavenProjectRoot(targetRoot, options.targetLang),
      plan: [],
      runners: { source: null, target: null },
      compile: { source: null, target: null },
      run: { source: null, target: null },
      comparisons: null,
      decisions: [],
      sourceIssues: [],
      rounds: 0,
      steps: 0,
      finished: false,
      summary: "",
      compileFailures: { source: 0, target: 0 },
    };
    this.#brief = {
      requirement: options.requirement,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      sourceRoot,
      targetRoot,
      sourceFiles: sourceModuleFiles.map((f) => f.relativePath),
      targetFiles: targetModuleFiles.map((f) => f.relativePath),
      targetClass: options.targetClass,
      targetMethod: options.targetMethod,
      maxSteps: this.#maxSteps,
      maxRounds: this.#maxRounds,
    };
    const executor = options.executor ?? new RealDriverExecutor({ logger: this.#logger });
    this.#tools = new SmokeTools(this.#state, { executor, logger: this.#logger });
  }

  /** 运行完整冒烟验证闭环,返回 SmokeReport(不抛错;未收敛由报告标记)。 */
  async run(): Promise<SmokeReport> {
    const state = this.#state;
    const history: string[] = [buildBriefingPrompt(this.#brief)];
    let steps = 0;

    while (steps < this.#maxSteps) {
      if (state.finished) break;
      const instruction = this.#nextStageInstruction();
      const action = await this.#callWithRetry(buildTurnPrompt(SMOKE_SYSTEM_PROMPT, history, instruction), history, instruction);
      if (action === null) {
        state.summary = "循环中止:连续多次动作解析失败(格式错误)。";
        this.#logger.error(state.summary);
        break;
      }
      steps += 1;
      state.steps = steps;
      history.push(`<assistant action>\n${actionText(action)}`);
      this.#logger.info(`步骤 ${steps}:${action.action} ${JSON.stringify(action.params)}`);

      let observation: string;
      try {
        observation = await this.#tools.dispatch(action);
      } catch (error) {
        observation = `工具执行出错:${error instanceof Error ? error.message : String(error)}`;
        this.#logger.error(observation);
      }
      history.push(`<observation>\n${observation}`);

      if (action.action === "finish") break;
    }

    if (!state.finished && steps >= this.#maxSteps) {
      state.summary = state.summary || `达到最大步数上限(${this.#maxSteps}),循环中止,未收敛。`;
      this.#logger.warn(state.summary);
    }
    const report = assembleSmokeReport(state);
    this.#logger.info(
      `冒烟验证结束:converged=${report.converged}, steps=${report.steps}, rounds=${report.rounds}, cases=${report.cases.length}`,
    );
    return report;
  }

  /** 单次 LLM 调用 + 动作解析;格式错误时把错误作为 observation 喂回重试(≤2)。 */
  async #callWithRetry(prompt: string, history: string[], instruction: string): Promise<SmokeAction | null> {
    let currentPrompt = prompt;
    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt += 1) {
      let raw: string;
      try {
        raw = await runClaude(currentPrompt, this.#claudeOptions);
      } catch (error) {
        // LLM 调用失败(超时/子进程退出):记录为 observation,给 agent 一次机会重述动作。
        this.#logger.error(`LLM 调用失败:${error instanceof Error ? error.message : String(error)}`);
        const feedback = `<system feedback>LLM 调用失败:${error instanceof Error ? error.message : String(error)}。请重试输出工具动作。</system feedback>`;
        if (attempt < MAX_PARSE_RETRIES) {
          currentPrompt = buildTurnPrompt(SMOKE_SYSTEM_PROMPT, [...history, feedback], instruction);
          continue;
        }
        return null;
      }
      this.#logger.debug(`LLM 输出(截断):\n${truncate(raw, 2000)}`);
      const parsed = parseAction(raw);
      if (parsed.action !== null) return parsed.action;
      this.#logger.warn(`动作解析失败(第 ${attempt + 1} 次):${parsed.error ?? ""}`);
      if (attempt < MAX_PARSE_RETRIES) {
        const feedback = `<system feedback>你的上一条输出无法解析为工具动作。请严格只输出一行 JSON:{"action":"...","params":{...}}。解析错误:${parsed.error ?? ""}</system feedback>`;
        currentPrompt = buildTurnPrompt(SMOKE_SYSTEM_PROMPT, [...history, feedback], instruction);
      }
    }
    return null;
  }

  /** 按当前状态派生「当前阶段指令」(引导而非强制,前置条件兜底)。 */
  #nextStageInstruction(): string {
    const state = this.#state;
    const brief = this.#brief;
    if (state.plan.length === 0) return buildPlanPrompt({ brief });
    const missingSides = (["source", "target"] as SmokeSide[]).filter((side) => state.runners[side] === null);
    if (missingSides.length > 0) return buildWriteRunnerPrompt({ brief, plan: state.plan, missingSides });
    const notCompiled = (["source", "target"] as SmokeSide[]).find((side) => state.compile[side]?.success !== true);
    if (notCompiled !== undefined) return buildCompilePrompt({ side: notCompiled });
    const notRun = (["source", "target"] as SmokeSide[]).find((side) => state.run[side] === null || state.run[side]!.results.length === 0);
    if (notRun !== undefined) return buildRunPrompt({ side: notRun });
    if (state.comparisons === null) return buildComparePrompt();
    const planIds = new Set(state.plan.map((c) => c.id));
    const judgedIds = new Set(state.decisions.map((d) => d.caseId));
    const notJudged = [...planIds].filter((id) => !judgedIds.has(id));
    if (notJudged.length > 0) return buildJudgePrompt({ brief, plan: state.plan, comparisons: state.comparisons, round: state.rounds, maxRounds: this.#maxRounds });
    const bugs = state.decisions.filter((d) => d.decision === "translation-bug").map((d) => d.caseId);
    if (bugs.length > 0) {
      if (state.rounds >= this.#maxRounds) {
        return `已达到修复轮数上限(${this.#maxRounds})。剩余 translation-bug case:${bugs.join(", ")}。请 finish 并如实总结(报告将标记未收敛);或继续用 judge 说明为 accepted-diff(如确属可接受差异)。`;
      }
      return buildFixPrompt({
        brief,
        plan: state.plan,
        comparisons: state.comparisons,
        bugCaseIds: bugs,
        sourceModuleText: joinFileTexts(state.sourceModuleFiles, state.sourceLang),
        targetFilesText: joinFileTexts(state.targetModuleFiles, state.targetLang),
        round: state.rounds + 1,
        maxRounds: this.#maxRounds,
      });
    }
    return buildFinishPrompt();
  }
}

// ---------------------------------------------------------------------------
// 报告组装(纯函数,可单测)
// ---------------------------------------------------------------------------

/** 从状态组装 SmokeReport;converged = finish 且全部 plan case 裁决为 pass/accepted-diff。 */
export function assembleSmokeReport(state: SmokeContextState): SmokeReport {
  const comparisons = state.comparisons ?? [];
  const comparisonByCase = new Map(comparisons.map((c) => [c.caseId, c]));
  const decisionByCase = new Map(state.decisions.map((d) => [d.caseId, d]));
  const ids = new Set<string>([
    ...state.plan.map((p) => p.id),
    ...comparisonByCase.keys(),
    ...decisionByCase.keys(),
  ]);
  const cases = [...ids].sort().map((id) => {
    const comparison = comparisonByCase.get(id);
    const decision = decisionByCase.get(id);
    return {
      caseId: id,
      intent: state.plan.find((p) => p.id === id)?.intent ?? "",
      source: comparison?.source ?? null,
      target: comparison?.target ?? null,
      mechanical: comparison?.verdict ?? "divergent",
      decision: decision?.decision ?? "unclear",
      reasoning: decision?.reasoning ?? "",
    };
  });
  const converged =
    state.finished &&
    state.plan.length > 0 &&
    cases.every((c) => c.decision === "pass" || c.decision === "accepted-diff");
  return {
    converged,
    steps: state.steps,
    rounds: state.rounds,
    cases,
    // 修复后的目标文件(未采纳不落盘;无修复时为原始目标模块文件,供调用方核验)。
    targetFiles: state.targetModuleFiles.map((f) => ({ path: f.relativePath, content: f.content })),
    sourceIssues: state.sourceIssues,
    summary: state.summary,
  };
}

// ---------------------------------------------------------------------------
// 输入收集
// ---------------------------------------------------------------------------

/**
 * 收集某侧模块文件:递归扫描 root 下该语言的源码文件(过滤构建目录),
 * 单文件模式(--source-file/--target-file)只收集该文件。
 * Java 文件按 public 类名重命名(与 javac「public 类须与文件名一致」契约对齐)。
 */
export function collectModuleFiles(
  root: string,
  language: VerifierLanguage,
  singleFile?: string,
): { relativePath: string; content: string }[] {
  const extension = LANGUAGE_EXTENSIONS[language];
  if (singleFile) {
    const absolute = resolve(singleFile);
    if (!existsSync(absolute)) throw new Error(`模块文件不存在:${singleFile}`);
    return [normalizeModuleFile(absolute, root, language)];
  }
  const out: { relativePath: string; content: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || IGNORED_DIR_NAMES.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(extension)) continue;
      out.push(normalizeModuleFile(full, root, language));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** 读取单文件并确定其在临时编译目录内的相对路径(Java 按 public 类名重命名)。 */
function normalizeModuleFile(absolute: string, root: string, language: VerifierLanguage): { relativePath: string; content: string } {
  const content = readFileSync(absolute, "utf-8");
  let relativePath = absolute.startsWith(`${resolve(root)}${sep}`) ? absolute.slice(resolve(root).length + 1) : basename(absolute);
  if (language === "Java") {
    const match = /public\s+class\s+(\w+)/.exec(content);
    if (match?.[1] && relativePath !== `${match[1]}.java`) {
      relativePath = `${match[1]}.java`;
    }
  }
  return { relativePath, content };
}

/** Java 目录含 pom.xml 时探测为 maven 项目根(executor 走 projectRoot 编译路径)。 */
function mavenProjectRoot(root: string, language: VerifierLanguage): string | undefined {
  if (language !== "Java") return undefined;
  if (existsSync(join(root, "pom.xml"))) return root;
  return undefined;
}

function joinFileTexts(files: { relativePath: string; content: string }[], language: VerifierLanguage): string {
  return files
    .map((f) => `--- ${f.relativePath} (${language}) ---\n${f.content}`)
    .join("\n\n");
}

function actionText(action: SmokeAction): string {
  return JSON.stringify(action);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}
