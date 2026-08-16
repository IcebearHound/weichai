import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VerifierLanguage } from "./description.js";
import { createLogger, type Logger } from "./logger.js";

export interface CompileOutcome {
  success: boolean;
  errors: string[];
  output: string;
}

export interface RunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SideFile {
  relativePath: string;
  content: string;
}

export interface SideSpec {
  language: VerifierLanguage;
  driverSource: string;
  sourceFiles: SideFile[];
  projectRoot?: string;
}

export interface DriverExecutor {
  compile(side: SideSpec): Promise<CompileOutcome>;
  run(side: SideSpec): Promise<RunOutcome>;
}

export interface RealExecutorOptions {
  javacPath?: string;
  javaPath?: string;
  dotnetPath?: string;
  timeoutMs?: number;
  /** 注入的 logger;默认 createLogger("executor")。 */
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 探测 javac / dotnet 是否在 PATH(供测试 skipIf 与调用方预检)。未知语言抛错。 */
export function isToolchainAvailable(language: VerifierLanguage): boolean {
  if (language === "Java") return findOnPath("javac");
  if (language === "C#") return findOnPath("dotnet");
  throw new Error(`Unsupported language: ${String(language)}`);
}

function findOnPath(name: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v '${name}'`], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 真实工具链执行器:mkdtemp 临时目录内写 driver 与 sourceFiles(保持相对路径、建父目录),
 * Java → `javac -d out` + `java -cp out`;C# → 生成 Verifier.csproj + `dotnet build` + `dotnet run --no-build`。
 * 超时默认 60s;javacPath/javaPath/dotnetPath 可注入。
 */
export class RealDriverExecutor implements DriverExecutor {
  readonly #options: Required<Omit<RealExecutorOptions, "logger">>;
  readonly #logger: Logger;

  constructor(options: RealExecutorOptions = {}) {
    this.#options = {
      javacPath: options.javacPath ?? "javac",
      javaPath: options.javaPath ?? "java",
      dotnetPath: options.dotnetPath ?? "dotnet",
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.#logger = options.logger ?? createLogger("executor");
  }

  async compile(side: SideSpec): Promise<CompileOutcome> {
    const dir = mkdtempSync(join(tmpdir(), "forexplore-verifier-"));
    try {
      writeSideFiles(dir, side);
      if (side.language === "Java") {
        const javaFiles = collectRelativeFiles(dir).filter((f) => f.endsWith(".java"));
        this.#logger.debug(`编译命令(Java): javac -d out (${javaFiles.length} 个 .java 文件)`);
        const outcome = this.#compileJava(dir);
        this.#logCompileOutcome(side, outcome);
        return outcome;
      }
      this.#logger.debug("编译命令(C#): dotnet build --nologo -v q (Verifier.csproj)");
      const outcome = await this.#compileCSharp(dir, side);
      this.#logCompileOutcome(side, outcome);
      return outcome;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** 编译结果摘要(成功→debug 输出长度;失败→error 含诊断输出)。 */
  #logCompileOutcome(side: SideSpec, outcome: CompileOutcome): void {
    if (outcome.success) {
      this.#logger.debug(`编译成功(${side.language}): ${outcome.output.length} chars`);
      return;
    }
    const errors = outcome.errors.length > 0 ? outcome.errors.join("; ") : "(无解析错误行)";
    this.#logger.error(`编译失败(${side.language}): ${errors}\n${truncate(outcome.output, 1000)}`);
  }

  #compileJava(dir: string): CompileOutcome {
    try {
      const javaFiles = collectRelativeFiles(dir).filter((f) => f.endsWith(".java"));
      const stdout = execFileSync(this.#options.javacPath, ["-d", join(dir, "out"), ...javaFiles], {
        cwd: dir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.#options.timeoutMs,
        stdio: "pipe",
      });
      return { success: true, errors: [], output: stdout };
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: parseJavaErrors(output), output };
    }
  }

  async #compileCSharp(dir: string, side: SideSpec): Promise<CompileOutcome> {
    writeFileSync(join(dir, "Verifier.csproj"), csprojContent(side), "utf-8");
    try {
      const stdout = await execFileAsync(this.#options.dotnetPath, ["build", "--nologo", "-v", "q"], {
        cwd: dir,
        timeoutMs: this.#options.timeoutMs,
      });
      return { success: true, errors: [], output: stdout };
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: parseDotnetErrors(output), output };
    }
  }

  async run(side: SideSpec): Promise<RunOutcome> {
    const dir = mkdtempSync(join(tmpdir(), "forexplore-verifier-"));
    try {
      writeSideFiles(dir, side);
      if (side.language === "Java") {
        const javaFiles = collectRelativeFiles(dir).filter((f) => f.endsWith(".java"));
        execFileSync(this.#options.javacPath, ["-d", join(dir, "out"), ...javaFiles], {
          cwd: dir,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: this.#options.timeoutMs,
          stdio: "pipe",
        });
        const className = driverClassNameFromSource(side.driverSource);
        this.#logger.debug(`运行命令(Java): java -cp out ${className}`);
        const stdout = await execFileAsync(this.#options.javaPath, ["-cp", join(dir, "out"), className], {
          cwd: dir,
          timeoutMs: this.#options.timeoutMs,
        });
        this.#logger.debug(`运行 stdout(Java,截断):\n${truncate(stdout, 500)}`);
        return { exitCode: 0, stdout, stderr: "" };
      }
      writeFileSync(join(dir, "Verifier.csproj"), csprojContent(side), "utf-8");
      await execFileAsync(this.#options.dotnetPath, ["build", "--nologo", "-v", "q"], {
        cwd: dir,
        timeoutMs: this.#options.timeoutMs,
      });
      this.#logger.debug("运行命令(C#): dotnet run --no-build --project Verifier.csproj");
      const stdout = await execFileAsync(
        this.#options.dotnetPath,
        ["run", "--no-build", "--project", "Verifier.csproj"],
        { cwd: dir, timeoutMs: this.#options.timeoutMs },
      );
      this.#logger.debug(`运行 stdout(C#,截断):\n${truncate(stdout, 500)}`);
      return { exitCode: 0, stdout, stderr: "" };
    } catch (error) {
      const output = errorOutput(error);
      this.#logger.error(`运行失败(${side.language}):\n${truncate(output, 1000)}`);
      return { exitCode: 1, stdout: "", stderr: output };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** 截断长文本(如编译/运行输出),附带截断标记。 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

/** 把 sourceFiles 与 driver 写入临时目录;sourceFiles 保持相对路径并建父目录。 */
function writeSideFiles(dir: string, side: SideSpec): void {
  for (const file of side.sourceFiles) {
    const fullPath = join(dir, file.relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, "utf-8");
  }
  // 驱动文件名:Java 要求 public 类名与文件名一致;C# 无此限制。
  const driverFile =
    side.language === "Java"
      ? join(dir, `${driverClassNameFromSource(side.driverSource)}.java`)
      : join(dir, "Driver.cs");
  writeFileSync(driverFile, side.driverSource, "utf-8");
}

/**
 * 从 driver 源码提取 public 类名(Java 与 C# 通用)。
 * 生成的 driver 只有一个 public 顶层类(其余为包内/嵌套类),首个匹配即驱动类。
 */
function driverClassNameFromSource(source: string): string {
  const match = /public\s+class\s+(\w+)/.exec(source);
  if (!match?.[1]) throw new Error("Driver source must declare a public class.");
  return match[1];
}

function collectRelativeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * 生成 Verifier.csproj:OutputType Exe、StartupObject=驱动类名、TargetFramework net8.0、LangVersion latest。
 * RollForward=LatestMajor:仅装了更新 .NET runtime 的机器上(如 .NET 10)仍可运行 net8.0 应用。
 */
function csprojContent(side: SideSpec): string {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <RollForward>LatestMajor</RollForward>
    <EnableDefaultCompileItems>true</EnableDefaultCompileItems>
    <StartupObject>${driverClassNameFromSource(side.driverSource)}</StartupObject>
    <AssemblyName>Verifier</AssemblyName>
  </PropertyGroup>
</Project>
`;
}

function execFileAsync(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: options.timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          // Node 24 的 execFile error 对象不再附带 stdout/stderr,这里手动补上,供 errorOutput 解析编译诊断。
          (error as Error & { stdout?: string; stderr?: string }).stdout = stdout ?? "";
          (error as Error & { stdout?: string; stderr?: string }).stderr = stderr ?? "";
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function errorOutput(error: unknown): string {
  if (error instanceof Error) {
    const stdErr = (error as Error & { stderr?: string }).stderr;
    const stdOut = (error as Error & { stdout?: string }).stdout;
    return [stdErr, stdOut, error.message].filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
  }
  return String(error);
}

/** Java 编译错误行:含 "error:" 或 "错误:"(中文 locale javac)。 */
function parseJavaErrors(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /error:|错误:/.test(line))
    .map((line) => line.trim());
}

/** C# 编译错误行:含 "error CS…" / "error MSB…"。 */
function parseDotnetErrors(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /error\s*[A-Z]{2,}/.test(line))
    .map((line) => line.trim());
}

/**
 * 可注入 fake:compileResults / runResults(值或函数)可注入,调用参数记录在 compileCalls / runCalls。
 * 未注入时构造即抛错,防止误把 fake 当真实执行器用。
 */
export class FakeDriverExecutor implements DriverExecutor {
  #compileResults: CompileOutcome | ((side: SideSpec) => CompileOutcome);
  #runResults: RunOutcome | ((side: SideSpec) => RunOutcome);
  readonly compileCalls: SideSpec[] = [];
  readonly runCalls: SideSpec[] = [];

  constructor(options: {
    compileResults?: CompileOutcome | ((side: SideSpec) => CompileOutcome);
    runResults?: RunOutcome | ((side: SideSpec) => RunOutcome);
  } = {}) {
    if (!options.compileResults || !options.runResults) {
      throw new Error("FakeDriverExecutor requires compileResults and runResults.");
    }
    this.#compileResults = options.compileResults;
    this.#runResults = options.runResults;
  }

  async compile(side: SideSpec): Promise<CompileOutcome> {
    this.compileCalls.push(side);
    return typeof this.#compileResults === "function" ? this.#compileResults(side) : this.#compileResults;
  }

  async run(side: SideSpec): Promise<RunOutcome> {
    this.runCalls.push(side);
    return typeof this.#runResults === "function" ? this.#runResults(side) : this.#runResults;
  }
}
