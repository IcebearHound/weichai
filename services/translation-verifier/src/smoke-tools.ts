/**
 * 冒烟验证工具注册表:项目内函数注册表 + JSON 文本协议(action/params/observation)。
 *
 * 工具(与设计文档 2.5 表一致):
 *   list_files / read_file / plan_smoke / write_runner / compile_runner /
 *   run_runner / compare / judge / propose_target_fix / propose_runner_fix / finish
 *
 * - 编译/运行复用 executor(RealDriverExecutor),结果解析复用 parseSideResults,
 *   机械差分复用 compareCases(不带 expected 即纯差分);
 * - 前置条件(如 run_runner 前必须 compile 成功)以 observation 文本反馈,agent 自愈;
 * - 观察一律文本化 + 截断,控制 stateless replay 的 token 增长;
 * - 修复产物只进入 executor 临时目录,绝不落盘用户源/目标目录。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { compareCases } from "./comparator.js";
import type { DriverExecutor, SideSpec } from "./executor.js";
import type { VerifierLanguage } from "./description.js";
import { createLogger, type Logger } from "./logger.js";
import { parseSideResults } from "./result-capture.js";
import type { CaseResult } from "./result-capture.js";
import type {
  RunnerFile,
  SmokeAction,
  SmokeContextState,
  SmokeDecision,
  SmokeSide,
} from "./smoke-types.js";

const MAX_FILE_READ_CHARS = 20_000;
const MAX_LIST_ENTRIES = 200;
const MAX_STDOUT_CHARS = 5_000;
const MAX_DETAIL_CHARS = 300;
/** 每侧编译失败重试上限(与设计文档 validator 阶段一致)。 */
const MAX_COMPILE_RETRIES = 3;
const targetSide: SmokeSide = "target";
/** list_files 时过滤的构建/依赖目录。 */
const IGNORED_DIR_NAMES = new Set(["target", "obj", "bin", "node_modules", ".git", ".vs", ".idea", "dist", "out"]);

export interface SmokeToolsDeps {
  executor: DriverExecutor;
  logger: Logger;
}

/** 工具注册表实现;每个 handler 返回文本 observation。 */
export class SmokeTools {
  readonly #state: SmokeContextState;
  readonly #executor: DriverExecutor;
  readonly #logger: Logger;

  constructor(state: SmokeContextState, deps: SmokeToolsDeps) {
    this.#state = state;
    this.#executor = deps.executor;
    this.#logger = deps.logger ?? createLogger("smoke-tools");
  }

  /** 按 action 分发到对应 handler,返回 observation 文本。 */
  async dispatch(action: SmokeAction): Promise<string> {
    this.#logger.debug(`dispatch: ${action.action} ${JSON.stringify(action.params)}`);
    switch (action.action) {
      case "list_files":
        return this.#listFiles(action.params.path);
      case "read_file":
        return this.#readFile(action.params.path);
      case "plan_smoke":
        return this.#planSmoke(action.params.cases);
      case "write_runner":
        return this.#writeRunner(action.params);
      case "compile_runner":
        return this.#compileRunner(action.params.side);
      case "run_runner":
        return this.#runRunner(action.params.side);
      case "compare":
        return this.#compare();
      case "judge":
        return this.#judge(action.params);
      case "propose_target_fix":
        return this.#proposeTargetFix(action.params.files);
      case "propose_runner_fix":
        return this.#proposeRunnerFix(action.params.side, action.params.files);
      case "finish":
        return this.#finish(action.params.summary, action.params.verdicts);
    }
  }

  // -------------------------------------------------------------------------
  // list_files / read_file(仅允许源/目标根目录内)
  // -------------------------------------------------------------------------

  #listFiles(path: string): string {
    const resolved = this.#resolveAllowedPath(path);
    if (resolved === null) return `错误:路径 "${path}" 不存在或超出允许范围(源/目标目录)。`;
    let entries: string[];
    try {
      entries = readdirSync(resolved);
    } catch {
      return `错误:无法读取目录 "${path}"。`;
    }
    const statted = entries
      .filter((name) => !name.startsWith("."))
      .map((name) => ({ name, isDir: statSync(join(resolved, name)).isDirectory() }))
      .filter((entry) => !entry.isDir || !IGNORED_DIR_NAMES.has(entry.name));
    const shown = statted.slice(0, MAX_LIST_ENTRIES);
    const lines = shown.map((entry) => (entry.isDir ? `${entry.name}/` : entry.name));
    if (statted.length > MAX_LIST_ENTRIES) {
      lines.push(`...(共 ${statted.length} 条,仅显示前 ${MAX_LIST_ENTRIES} 条)`);
    }
    return `目录 ${path} 条目(${statted.length}):\n${lines.join("\n")}`;
  }

  #readFile(path: string): string {
    const resolved = this.#resolveAllowedPath(path);
    if (resolved === null) return `错误:路径 "${path}" 不存在或超出允许范围(源/目标目录)。`;
    if (statSync(resolved).isDirectory()) {
      return `错误:"${path}" 是目录,请用 list_files 查看。`;
    }
    let content: string;
    try {
      content = readFileSync(resolved, "utf-8");
    } catch (error) {
      return `错误:无法读取文件 "${path}": ${error instanceof Error ? error.message : String(error)}`;
    }
    return `文件 ${path} (${content.length} 字符):\n\`\`\`\n${truncate(content, MAX_FILE_READ_CHARS)}\n\`\`\``;
  }

  /** 路径解析:相对路径先按源根、再按目标根;绝对路径必须落在某一根内。 */
  #resolveAllowedPath(path: string): string | null {
    const roots = [this.#state.sourceRoot, this.#state.targetRoot];
    if (isAbsolute(path)) {
      for (const root of roots) {
        const candidate = resolveWithin(root, path);
        if (candidate !== null) return candidate;
      }
      return null;
    }
    for (const root of roots) {
      const candidate = resolveWithin(root, path);
      if (candidate !== null && existsSync(candidate)) return candidate;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // plan_smoke / write_runner
  // -------------------------------------------------------------------------

  #planSmoke(cases: { id: string; intent: string }[]): string {
    const unique = new Set<string>();
    for (const c of cases) {
      if (!c.id.trim()) return "错误:用例 id 不能为空。";
      if (unique.has(c.id)) return `错误:用例 id 重复:"${c.id}"。`;
      unique.add(c.id);
    }
    this.#state.plan = cases;
    const summary = cases.map((c) => `[${c.id}] ${c.intent}`).join("\n");
    return `已记录冒烟用例计划(${cases.length} 个,仅意图描述,无 expected):\n${summary}`;
  }

  #writeRunner(params: { side: SmokeSide; language: VerifierLanguage; files: RunnerFile[] }): string {
    const violation = validateRunnerContract(params.language, params.files);
    if (violation !== null) return `错误:${violation}`;
    this.#state.runners[params.side] = params.files;
    // runner 变更后,旧的编译/运行结果失效,需重新走 compile→run。
    this.#resetSideResults(params.side);
    this.#state.compileFailures[params.side] = 0;
    const names = params.files.map((f) => f.path).join(", ");
    return `已记录${params.side === "source" ? "源侧" : "目标侧"} runner(${params.language},${params.files.length} 个文件):${names}。请继续用 compile_runner 编译。`;
  }

  /** 重置某侧 compile/run 结果与差分(独立方法调用以打断 TS 对属性访问的窄化)。 */
  #resetSideResults(side: SmokeSide): void {
    this.#state.compile[side] = null;
    this.#state.run[side] = null;
    this.#state.comparisons = null;
  }

  // -------------------------------------------------------------------------
  // compile_runner / run_runner
  // -------------------------------------------------------------------------

  #compileRunner(side: SmokeSide): Promise<string> {
    const files = this.#state.runners[side];
    if (files === null) {
      return Promise.resolve(`错误:前置条件未满足——${sideLabel(side)}尚未通过 write_runner 提供 runner 文件。`);
    }
    if (this.#state.compileFailures[side] >= MAX_COMPILE_RETRIES) {
      return Promise.resolve(
        `警告:${sideLabel(side)}编译失败已达 ${MAX_COMPILE_RETRIES} 次上限。请停止改写 runner,或评估是否测试设计有误;可 finish 结束(报告将标记未收敛)。`,
      );
    }
    return this.#runCompile(side);
  }

  async #runCompile(side: SmokeSide): Promise<string> {
    const spec = buildSideSpec(this.#state, side);
    let outcome;
    try {
      outcome = await this.#executor.compile(spec);
    } catch (error) {
      this.#state.compile[side] = null;
      this.#state.run[side] = null;
      return `编译执行出错(${sideLabel(side)}): ${error instanceof Error ? error.message : String(error)}`;
    }
    this.#state.compile[side] = outcome;
    if (!outcome.success) {
      this.#state.compileFailures[side] += 1;
      this.#state.run[side] = null;
      const errorLines = outcome.errors.length > 0 ? outcome.errors.join("\n") : "(无解析错误行)";
      return `编译失败(${sideLabel(side)},第 ${this.#state.compileFailures[side]} 次):\n${truncate(errorLines, MAX_STDOUT_CHARS)}\n输出(截断):\n${truncate(outcome.output, MAX_STDOUT_CHARS)}`;
    }
    this.#state.compileFailures[side] = 0;
    const fileNames = spec.sourceFiles.map((f) => f.relativePath).join(", ");
    return `编译成功(${sideLabel(side)},${spec.sourceFiles.length + 1} 个文件:${fileNames} + driver)。`;
  }

  async #runRunner(side: SmokeSide): Promise<string> {
    const compile = this.#state.compile[side];
    if (compile === null) {
      return `错误:前置条件未满足——${sideLabel(side)}尚未编译成功,请先执行 compile_runner。`;
    }
    if (!compile.success) {
      return `错误:前置条件未满足——${sideLabel(side)}编译失败,无法运行。`;
    }
    const spec = buildSideSpec(this.#state, side);
    let runOutcome;
    try {
      runOutcome = await this.#executor.run(spec);
    } catch (error) {
      this.#state.run[side] = null;
      return `运行执行出错(${sideLabel(side)}): ${error instanceof Error ? error.message : String(error)}`;
    }
    if (runOutcome.exitCode !== 0) {
      this.#state.run[side] = null;
      return `运行失败(${sideLabel(side)},退出码 ${runOutcome.exitCode}):\n${truncate(runOutcome.stderr || runOutcome.stdout, MAX_STDOUT_CHARS)}`;
    }
    const parsed = parseSideResults(side, runOutcome.stdout);
    this.#state.run[side] = parsed;
    return summarizeResults(side, parsed);
  }

  // -------------------------------------------------------------------------
  // compare / judge
  // -------------------------------------------------------------------------

  #compare(): string {
    const source = this.#state.run.source;
    const target = this.#state.run.target;
    if (source === null || target === null || source.results.length === 0 || target.results.length === 0) {
      return "错误:前置条件未满足——双侧必须都已成功运行并解析出 case 结果,请先执行 run_runner(source) 与 run_runner(target)。";
    }
    const comparisons = compareCases(source, target);
    this.#state.comparisons = comparisons;
    return summarizeComparison(comparisons);
  }

  #judge(params: { verdicts: { caseId: string; decision: SmokeDecision; reasoning: string }[]; sourceIssues?: string[] }): string {
    if (this.#state.comparisons === null) {
      return "错误:前置条件未满足——请先执行 compare 获得差分结果,再基于差异做语义裁决。";
    }
    for (const v of params.verdicts) {
      const idx = this.#state.decisions.findIndex((d) => d.caseId === v.caseId);
      if (idx >= 0) this.#state.decisions[idx] = v;
      else this.#state.decisions.push(v);
    }
    if (params.sourceIssues !== undefined) {
      for (const issue of params.sourceIssues) {
        if (!this.#state.sourceIssues.includes(issue)) this.#state.sourceIssues.push(issue);
      }
    }
    const summary = params.verdicts.map((v) => `[${v.caseId}] ${v.decision}`).join(", ");
    return `已记录 ${params.verdicts.length} 个 case 的语义裁决:${summary}${params.sourceIssues && params.sourceIssues.length > 0 ? `;源侧疑似缺陷 ${params.sourceIssues.length} 条` : ""}。`;
  }

  // -------------------------------------------------------------------------
  // 修复闭环
  // -------------------------------------------------------------------------

  async #proposeTargetFix(files: RunnerFile[]): Promise<string> {
    if (files.length === 0) return "错误:修复文件列表不能为空。";
    if (this.#state.runners.target === null) {
      return "错误:前置条件未满足——目标侧 runner 尚未就绪,无法编译修复产物。";
    }
    // 修复产物覆盖目标模块文件(整体替换;agent 必须给出完整文件)。
    this.#state.targetModuleFiles = files.map((f) => ({ relativePath: f.path, content: f.content }));
    this.#state.rounds += 1;
    this.#resetSideResults(targetSide);
    const compileObs = await this.#runCompile(targetSide);
    if (this.#state.compile[targetSide]?.success !== true) {
      return `已采纳目标侧修复(第 ${this.#state.rounds} 轮),但自动编译失败:\n${compileObs}\n请用 write_runner/propose_target_fix 继续修正。`;
    }
    const runObs = await this.#runRunner(targetSide);
    if (this.#state.run[targetSide] === null) {
      return `已采纳目标侧修复(第 ${this.#state.rounds} 轮),编译成功但运行失败:\n${runObs}`;
    }
    const source = this.#state.run.source;
    if (source === null || source.results.length === 0) {
      return `已采纳目标侧修复(第 ${this.#state.rounds} 轮),目标侧已重跑:${runObs}\n(源侧结果缺失,无法差分,请先重跑源侧。)`;
    }
    this.#state.comparisons = compareCases(source, this.#state.run[targetSide]!);
    return `已采纳目标侧修复(第 ${this.#state.rounds} 轮),自动重新编译→运行→差分完成:\n${summarizeResults(targetSide, this.#state.run[targetSide]!)}\n${summarizeComparison(this.#state.comparisons)}\n请基于最新差分结果 judge 裁决是否收敛。`;
  }

  #proposeRunnerFix(side: SmokeSide, files: RunnerFile[]): string {
    const violation = validateRunnerContract(side === "source" ? this.#state.sourceLang : this.#state.targetLang, files);
    if (violation !== null) return `错误:${violation}`;
    this.#state.runners[side] = files;
    // runner 变更:旧编译/运行结果失效。
    this.#resetSideResults(side);
    this.#state.compileFailures[side] = 0;
    return `已更新${sideLabel(side)} runner(${files.length} 个文件)。请重新执行 compile_runner → run_runner → compare。`;
  }

  #finish(summary: string, verdicts?: { caseId: string; decision: SmokeDecision; reasoning: string }[]): string {
    if (verdicts !== undefined) {
      for (const v of verdicts) {
        const idx = this.#state.decisions.findIndex((d) => d.caseId === v.caseId);
        if (idx >= 0) this.#state.decisions[idx] = v;
        else this.#state.decisions.push(v);
      }
    }
    this.#state.summary = summary;
    this.#state.finished = true;
    const judged = this.#state.decisions.length;
    const bugs = this.#state.decisions.filter((d) => d.decision === "translation-bug").length;
    return `冒烟验证结束。已裁决 ${judged} 个 case,其中 translation-bug ${bugs} 个。报告将由控制器组装。`;
  }

}

// ---------------------------------------------------------------------------
// 纯函数辅助(可独立单测)
// ---------------------------------------------------------------------------

/** runner 契约校验(write_runner / propose_runner_fix 调用);违规返回描述性错误。 */
export function validateRunnerContract(language: VerifierLanguage, files: RunnerFile[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return "runner 文件列表不能为空。";
  if (language === "Python" && !files.some((f) => f.path === "driver.py")) {
    return "Python runner 必须包含固定入口文件 driver.py(顶层脚本,executor 以 python3 driver.py 运行)。";
  }
  if (language === "TypeScript" && !files.some((f) => f.path === "driver.ts")) {
    return "TypeScript runner 必须包含固定入口文件 driver.ts(顶层脚本,tsx 运行)。";
  }
  if (language === "C#") {
    const driver = files.find((f) => f.path === "Driver.cs");
    if (!driver) return "C# runner 必须包含固定入口文件 Driver.cs。";
    if (!/public\s+class\s+\w+/.test(driver.content)) {
      return "C# Driver.cs 必须声明且仅声明一个 public class(executor 用该正则推导 StartupObject 契约)。";
    }
  }
  if (language === "Java") {
    const main = files.find(
      (f) =>
        f.path.endsWith(".java") &&
        /public\s+class\s+\w+/.test(f.content) &&
        /public\s+static\s+void\s+main/.test(f.content),
    );
    if (!main) {
      return "Java runner 必须包含一个含 main 入口的 public class(如 public class SmokeRunner { public static void main(String[] args) })且文件名与类名一致。";
    }
    // 文件名与 public 类名一致性(与 executor 写盘规则对齐,避免 javac 报"类名与文件名不符")。
    const match = /public\s+class\s+(\w+)/.exec(main.content);
    if (match?.[1] && main.path !== `${match[1]}.java`) {
      return `Java runner 文件名与 public 类名不一致:文件 "${main.path}" 声明了 public class ${match[1]},应命名为 "${match[1]}.java"。`;
    }
  }
  return null;
}

/**
 * 从 runner 文件集合中拆分 driver 入口与其余文件:
 * - Python/TypeScript/C# 的入口文件为固定名(driver.py/driver.ts/Driver.cs);
 * - Java 的入口为含 main 的 public class 文件(文件名 = 类名.java,与 executor 写盘规则一致)。
 */
export function splitDriverEntry(language: VerifierLanguage, files: RunnerFile[]): { driverSource: string; extraFiles: RunnerFile[] } {
  let driver: RunnerFile | undefined;
  if (language === "Python") driver = files.find((f) => f.path === "driver.py");
  else if (language === "TypeScript") driver = files.find((f) => f.path === "driver.ts");
  else if (language === "C#") driver = files.find((f) => f.path === "Driver.cs");
  else {
    driver = files.find(
      (f) => f.path.endsWith(".java") && /public\s+class\s+\w+/.test(f.content) && /public\s+static\s+void\s+main/.test(f.content),
    );
  }
  if (!driver) {
    throw new Error(`runner 缺少入口文件(${language} 契约:${language === "Java" ? "含 main 的 public class 文件" : language === "C#" ? "Driver.cs" : language === "Python" ? "driver.py" : "driver.ts"})。`);
  }
  return { driverSource: driver.content, extraFiles: files.filter((f) => f !== driver) };
}

/** 组装某侧的 SideSpec(driver + 用户模块文件 + runner 附加文件 + maven projectRoot)。 */
export function buildSideSpec(state: SmokeContextState, side: SmokeSide): SideSpec {
  const language = side === "source" ? state.sourceLang : state.targetLang;
  const runnerFiles = state.runners[side] ?? [];
  const { driverSource, extraFiles } = splitDriverEntry(language, runnerFiles);
  const moduleFiles = side === "source" ? state.sourceModuleFiles : state.targetModuleFiles;
  return {
    language,
    driverSource,
    sourceFiles: [...moduleFiles, ...extraFiles.map((f) => ({ relativePath: f.path, content: f.content }))],
    projectRoot: side === "source" ? state.sourceProjectRoot : state.targetProjectRoot,
  };
}

// ---------------------------------------------------------------------------
// observation 格式化
// ---------------------------------------------------------------------------

function summarizeResults(side: SmokeSide, results: { results: CaseResult[]; parseErrors: string[] }): string {
  const lines = [
    `运行(${sideLabel(side)})${results.parseErrors.length > 0 ? "完成(存在解析错误)" : "成功"}:${results.results.length} 个 case 结果`,
  ];
  for (const r of results.results) {
    lines.push(`  [${r.caseId}] ${describeCaseResult(r)}`);
  }
  for (const error of results.parseErrors) {
    lines.push(`  parseError: ${truncate(error, MAX_DETAIL_CHARS)}`);
  }
  return lines.join("\n");
}

function summarizeComparison(comparisons: { caseId: string; verdict: string; details: string[] }[]): string {
  const lines = ["差分比较结果(机械差分,无预置黄金值):"];
  for (const c of comparisons) {
    if (c.verdict === "pass") lines.push(`  [${c.caseId}] pass`);
    else lines.push(`  [${c.caseId}] ${c.verdict}: ${truncate(c.details.join("; "), MAX_DETAIL_CHARS)}`);
  }
  return lines.join("\n");
}

function describeCaseResult(result: CaseResult): string {
  if (result.outcome === "return") {
    return `return ${truncate(JSON.stringify(result.returnValue), MAX_DETAIL_CHARS)}`;
  }
  return `exception ${result.exceptionType ?? ""} "${truncate(result.exceptionMessage ?? "", MAX_DETAIL_CHARS)}"`;
}

function sideLabel(side: SmokeSide): string {
  return side === "source" ? "源侧" : "目标侧";
}

/** 截断长文本(如文件/输出),附带截断标记。 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

/** 解析路径并校验其落在根目录内(防越界读任意系统文件)。 */
function resolveWithin(root: string, path: string): string | null {
  const rootResolved = resolve(root);
  const candidate = resolve(isAbsolute(path) ? path : join(root, path));
  if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${sep}`)) return null;
  return candidate;
}
