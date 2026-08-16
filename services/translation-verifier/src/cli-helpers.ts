import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDescription, type TestDescription, type VerifierLanguage } from "./description.js";
import { generateDriverSource } from "./driver/driver-codegen.js";
import { RealDriverExecutor, type SideFile, type SideSpec } from "./executor.js";
import { verify, type VerificationJob, type VerificationReport } from "./verifier.js";
import { RepairAgent, RepairLoop } from "./repair-loop.js";

export interface CliOptions {
  descriptionPath: string;
  sourceDir: string;
  targetDir: string;
  /** 目标侧目录内相对路径:修复闭环用它替换翻译后的方法文件。 */
  methodFile?: string;
  apiKey?: string;
  maxRounds?: number;
  json?: boolean;
  requirement?: string;
}

const VALUE_FLAGS = new Set([
  "--description",
  "--source",
  "--target",
  "--method-file",
  "--max-rounds",
  "--api-key",
  "--requirement",
]);

const BOOLEAN_FLAGS = new Set(["--json"]);

const JAVA_EXT = ".java";
const CSHARP_EXT = ".cs";
/** 递归读取时跳过的构建/依赖目录(避免 obj/bin 生成物进入源文件集合)。 */
const IGNORED_DIRS = new Set(["obj", "bin", "node_modules", ".git", ".vscode"]);

/**
 * 解析 CLI 参数。必填:--description/--source/--target;
 * 可选:--method-file/--max-rounds/--json/--api-key/--requirement。
 * 非法 --max-rounds、未知 flag、缺值 flag → { error }。
 */
export function parseCliArgs(argv: string[]): CliOptions | { error: string } {
  const options: CliOptions = { descriptionPath: "", sourceDir: "", targetDir: "", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--json") options.json = true;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined) return { error: `Missing value for ${flag}.` };
      i += 1;
      switch (flag) {
        case "--description":
          options.descriptionPath = value;
          break;
        case "--source":
          options.sourceDir = value;
          break;
        case "--target":
          options.targetDir = value;
          break;
        case "--method-file":
          options.methodFile = value;
          break;
        case "--max-rounds": {
          if (!/^\d+$/.test(value)) {
            return { error: `Invalid --max-rounds: "${value}" (must be a non-negative integer).` };
          }
          options.maxRounds = Number.parseInt(value, 10);
          break;
        }
        case "--api-key":
          options.apiKey = value;
          break;
        case "--requirement":
          options.requirement = value;
          break;
      }
      continue;
    }
    return { error: `Unknown option: ${flag}` };
  }
  if (!options.descriptionPath) return { error: "Missing required option: --description <path>." };
  if (!options.sourceDir) return { error: "Missing required option: --source <dir>." };
  if (!options.targetDir) return { error: "Missing required option: --target <dir>." };
  return options;
}

const VERDICT_LABEL: Record<VerificationReport["comparisons"][number]["verdict"], string> = {
  pass: "PASS",
  fail: "FAIL",
  divergent: "DIVERGENT",
};

/**
 * 人类可读报告:每 case 一行 caseId + verdict 标记 + requirementVerdict(如有)+ 差异摘要;
 * 末尾 Pass rate 汇总。description 参数保留(报告头部/需求展示预留)。
 */
export function formatReport(report: VerificationReport, description: TestDescription): string {
  const lines: string[] = [];
  for (const comparison of report.comparisons) {
    const verdict = VERDICT_LABEL[comparison.verdict];
    const requirement = comparison.requirementVerdict ? ` [${comparison.requirementVerdict}]` : "";
    const details = comparison.details.length > 0 ? ` | ${comparison.details.join("; ")}` : "";
    lines.push(`${comparison.caseId}\t${verdict}${requirement}${details}`);
  }
  lines.push(`Pass rate: ${report.passedCases}/${report.totalCases} (${(report.passRate * 100).toFixed(1)}%)`);
  void description;
  return lines.join("\n");
}

/**
 * CLI 编排入口,退出码:0=全 PASS,1=有 FAIL/DIVERGENT,2=参数/运行错误。
 * 流水线(需求第一;翻译由 agent 完成,CLI 不做 LLM 调用):
 * 1. parseCliArgs → 读描述 JSON → validateDescription;--requirement 提供且描述无 requirement 时挂载;
 *    requirement 缺失即报错(需求第一)。
 * 2. 源侧 sourceFiles 从 --source 目录递归读取(语言由目录内容推断,见设计文档 4.9「源侧驱动 ← 描述(源语言)」);
 *    目标侧从 --target 目录递归读取(含翻译后的方法文件),语言 = description.target.language。
 * 3. 双侧 generateDriverSource → verify(RealDriverExecutor)→ 打印 formatReport(或 --json)。
 * 4. --max-rounds > 0 且 --method-file 提供:RepairLoop + RepairAgent(claude 子进程,
 *    apiKey = --api-key ?? process.env.DEEPSEEK_API_KEY),rebuildTargetSide 用修复产物替换方法文件。
 */
export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if ("error" in parsed) {
    console.error(`error: ${parsed.error}`);
    return 2;
  }

  // 1. 读描述 JSON + 校验。
  let description: TestDescription;
  try {
    const raw: unknown = JSON.parse(readFileSync(parsed.descriptionPath, "utf-8"));
    description = validateDescription(raw);
  } catch (error) {
    console.error(`error: failed to read/validate description ${parsed.descriptionPath}: ${errorMessage(error)}`);
    return 2;
  }
  if (description.requirement === undefined && parsed.requirement !== undefined) {
    description = { ...description, requirement: parsed.requirement };
  }
  if (description.requirement === undefined || description.requirement.trim() === "") {
    console.error(
      "error: a requirement is required (需求第一): pass --requirement <text> or include a requirement in the description.",
    );
    return 2;
  }

  // 2. 读取双侧源文件(递归)。
  let sourceLang: VerifierLanguage;
  let sourceFiles: SideFile[];
  try {
    const allSourceFiles = readDirSourceFiles(parsed.sourceDir);
    sourceLang = inferSourceLanguage(allSourceFiles);
    sourceFiles = allSourceFiles.filter((f) => f.relativePath.endsWith(extensionFor(sourceLang)));
  } catch (error) {
    console.error(`error: failed to read source directory ${parsed.sourceDir}: ${errorMessage(error)}`);
    return 2;
  }
  let targetFiles: SideFile[];
  try {
    targetFiles = readDirSourceFiles(parsed.targetDir, description.target.language);
    if (targetFiles.length === 0) {
      throw new Error(`target directory contains no ${extensionFor(description.target.language)} files.`);
    }
  } catch (error) {
    console.error(`error: failed to read target directory ${parsed.targetDir}: ${errorMessage(error)}`);
    return 2;
  }
  if (parsed.methodFile !== undefined && !targetFiles.some((f) => f.relativePath === parsed.methodFile)) {
    console.error(`error: --method-file ${parsed.methodFile} not found under target directory ${parsed.targetDir}.`);
    return 2;
  }

  // 3. 双侧驱动 + verify。
  const executor = new RealDriverExecutor();
  const targetDriver = generateDriverSource(description);
  // 源侧驱动 ← 描述(源语言):源侧语言由 --source 目录文件推断,驱动调用目标签名保持一致。
  const sourceDriver = generateDriverSource({
    ...description,
    target: { ...description.target, language: sourceLang },
  });
  const job: VerificationJob = {
    description,
    source: { language: sourceLang, driverSource: sourceDriver, sourceFiles, projectRoot: parsed.sourceDir },
    target: {
      language: description.target.language,
      driverSource: targetDriver,
      sourceFiles: targetFiles,
      projectRoot: parsed.targetDir,
    },
  };

  let report: VerificationReport;
  try {
    if ((parsed.maxRounds ?? 0) > 0 && parsed.methodFile !== undefined) {
      // 4. 修复闭环:repairAgent 走 claude 子进程,apiKey = --api-key ?? DEEPSEEK_API_KEY。
      const repairAgent = new RepairAgent({ apiKey: parsed.apiKey ?? process.env.DEEPSEEK_API_KEY });
      const loop = new RepairLoop({
        maxRounds: parsed.maxRounds,
        repairAgent,
        rebuildTargetSide: (methodCode) => ({
          language: description.target.language,
          driverSource: targetDriver,
          sourceFiles: replaceFileContent(targetFiles, parsed.methodFile as string, methodCode),
          projectRoot: parsed.targetDir,
        }),
      });
      report = (await loop.run(job, executor)).finalReport;
    } else {
      report = await verify(job, executor);
    }
  } catch (error) {
    console.error(`error: verification failed: ${errorMessage(error)}`);
    return 2;
  }

  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report, description));
  }
  return report.failedCases === 0 && report.divergentCases === 0 ? 0 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionFor(language: VerifierLanguage): string {
  return language === "C#" ? CSHARP_EXT : JAVA_EXT;
}

/**
 * 递归读取目录内源文件(跳过 IGNORED_DIRS 构建/依赖目录)。
 * 相对路径使用 POSIX 风格(与 --method-file 的相对路径约定一致)。
 * 未指定 language 时读取全部 Java/C# 文件(供语言推断)。
 */
function readDirSourceFiles(dir: string, language?: VerifierLanguage): SideFile[] {
  const extension = language === undefined ? null : extensionFor(language);
  const files: SideFile[] = [];
  const walk = (current: string, relative: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`cannot read directory ${current}: ${errorMessage(error)}`);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(join(current, entry.name), relative === "" ? entry.name : `${relative}/${entry.name}`);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extension !== null && !entry.name.endsWith(extension)) continue;
      files.push({
        relativePath: relative === "" ? entry.name : `${relative}/${entry.name}`,
        content: readFileSync(join(current, entry.name), "utf-8"),
      });
    }
  };
  walk(dir, "");
  return files;
}

/** 从源目录文件集合推断源语言:仅 .java → Java,仅 .cs → C#;混合或为空 → 抛错。 */
function inferSourceLanguage(files: SideFile[]): VerifierLanguage {
  const javaCount = files.filter((f) => f.relativePath.endsWith(JAVA_EXT)).length;
  const csharpCount = files.filter((f) => f.relativePath.endsWith(CSHARP_EXT)).length;
  if (javaCount > 0 && csharpCount > 0) {
    throw new Error("source directory contains both .java and .cs files; cannot infer the source language.");
  }
  if (javaCount > 0) return "Java";
  if (csharpCount > 0) return "C#";
  throw new Error("source directory contains no Java or C# source files.");
}

/** 用修复产物内容替换 methodFile 对应文件(未命中时原样返回)。 */
function replaceFileContent(files: SideFile[], methodFile: string, content: string): SideFile[] {
  return files.map((f) => (f.relativePath === methodFile ? { ...f, content } : f));
}
