/**
 * C# 编译校验器
 * 调用 dotnet build 或 csc 检查代码是否能通过编译。
 */

import { execFileSync, execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export interface CompileResult {
  success: boolean;
  errors: string[];
  output: string;
}

export interface ResolvedProjectTarget {
  sourcePath: string;
  relativePath: string;
}

/**
 * 独立编译一个 C# 方法体，不依赖项目类型定义。
 * 把翻译后的方法放进一个最小 wrapper class，用 dotnet build 验证。
 */
export function compileStandalone(
  csharpCode: string,
  className: string,
): CompileResult {
  const dotnet = findDotnet();
  const temporaryRoot = dotnet?.endsWith(".exe") ? process.cwd() : tmpdir();
  const dir = mkdtempSync(join(temporaryRoot, ".forexplore-standalone-"));

  const fullSource = buildWrapperSource(csharpCode, className);
  const csFile = join(dir, `${className}.cs`);
  writeFileSync(csFile, fullSource, "utf-8");

  try {
    if (dotnet) {
      return compileWithDotnet(dotnet, dir, true);
    }
    if (hasCsc()) {
      return compileWithCsc(dir, csFile);
    }
    return {
      success: false,
      errors: [
        ".NET SDK not installed. Run: winget install Microsoft.DotNet.SDK.8",
      ],
      output: "",
    };
  } catch (e: unknown) {
    const msg =
      e instanceof Error ? e.message : String(e);
    return { success: false, errors: [msg], output: msg };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 集成编译 — 在临时副本中替换目标方法并编译完整 C# skeleton。
 */
export function compileIntegrated(
  csharpCode: string,
  skeletonProjectPath: string,
  targetFilePath: string,
): CompileResult {
  const projectRoot = resolve(skeletonProjectPath);
  const directSourcePath = resolve(projectRoot, targetFilePath);
  const resolvedTarget = resolveProjectTargetFile(projectRoot, targetFilePath);
  if (!resolvedTarget && isOutsideProject(projectRoot, directSourcePath)) {
    return {
      success: false,
      errors: [`Target file must stay inside the skeleton project: ${targetFilePath}`],
      output: "",
    };
  }
  if (!resolvedTarget) {
    return {
      success: false,
      errors: [`Target file does not exist in the skeleton project: ${targetFilePath}`],
      output: "",
    };
  }
  const { sourcePath, relativePath: relativeTarget } = resolvedTarget;
  const dotnet = findDotnet();
  if (!dotnet) {
    return {
      success: false,
      errors: [".NET SDK not installed; integrated compilation was not executed."],
      output: "",
    };
  }

  // Keep Windows-hosted SDK builds on the same mounted drive as the skeleton.
  const temporaryProject = mkdtempSync(
    join(dirname(projectRoot), ".forexplore-integrated-"),
  );
  try {
    cpSync(projectRoot, temporaryProject, {
      recursive: true,
      filter: (source) => !["bin", "obj"].includes(source.split(/[\\/]/).at(-1) ?? ""),
    });
    const temporaryTarget = join(temporaryProject, relativeTarget);
    const original = readFileSync(temporaryTarget, "utf8");
    writeFileSync(temporaryTarget, replaceTargetMethod(original, csharpCode), "utf8");
    return compileWithDotnet(dotnet, temporaryProject, false);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, errors: [message], output: message };
  } finally {
    rmSync(temporaryProject, { recursive: true, force: true });
  }
}

// ---- helpers ----

function findDotnet(): string | null {
  const candidates = [
    process.env.DOTNET_COMMAND?.trim(),
    "dotnet",
    "/mnt/c/Program Files/dotnet/dotnet.exe",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Continue to the next known installation location.
    }
  }
  return null;
}

export function isCompilerUnavailable(result: CompileResult): boolean {
  return result.errors.some((error) =>
    /(?:\.NET SDK|C# compiler).*(?:not installed|not available)/i.test(error),
  );
}

function hasCsc(): boolean {
  const paths = [
    join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return paths.some((p) => existsSync(p));
}

function compileWithDotnet(
  dotnet: string,
  dir: string,
  createProject: boolean,
): CompileResult {
  if (createProject) {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
  </PropertyGroup>
</Project>`;
    writeFileSync(join(dir, "tmp.csproj"), csproj, "utf-8");
  }

  try {
    const stdout = execFileSync(dotnet, ["build", "--nologo", "-v", "q"], {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      stdio: "pipe",
    });
    return { success: true, errors: [], output: stdout };
  } catch (e: unknown) {
    const errOutput = collectErrorOutput(e);
    const errors = parseCsErrors(errOutput);
    return { success: false, errors, output: errOutput };
  }
}

function compileWithCsc(dir: string, csFile: string): CompileResult {
  const dllPath = join(dir, "test.dll");
  try {
    const stdout = execSync(
      `csc /target:library /out:"${dllPath}" /nologo "${csFile}"`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30_000, stdio: "pipe" },
    );
    return { success: true, errors: [], output: stdout };
  } catch (e: unknown) {
    const errOutput = collectErrorOutput(e);
    const errors = parseCsErrors(errOutput);
    return { success: false, errors, output: errOutput };
  }
}

function collectErrorOutput(e: unknown): string {
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    return String(obj.stdout ?? obj.stderr ?? obj.message ?? String(e));
  }
  return String(e);
}

function parseCsErrors(output: string): string[] {
  const regex = /error\s+CS\d+:\s*(.+)/gi;
  const matches = output.matchAll(regex);
  const errors = Array.from(matches, (m) => m[1]?.trim() ?? "").filter(Boolean);
  if (errors.length === 0) {
    // fallback: last 5 non-empty lines
    errors.push(
      ...output
        .split("\n")
        .filter((l) => l.trim())
        .slice(-5),
    );
  }
  return errors;
}

function buildWrapperSource(code: string, className: string): string {
  return `using System;
using System.Collections.Generic;
using System.Linq;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class ${className} {
${code}
}`;
}

/**
 * Resolve a target path supplied by a client whose workspace root may be an
 * ancestor of the configured skeleton project. The returned path remains
 * internal to the skeleton; callers can keep the original client path in the
 * generated patch for host-side validation.
 */
export function resolveProjectTargetFile(
  projectRoot: string,
  targetFilePath: string,
): ResolvedProjectTarget | null {
  const root = resolve(projectRoot);
  const normalizedTarget = targetFilePath.replace(/\\/g, "/");
  const segments = normalizedTarget.split("/");
  if (isAbsolute(targetFilePath) || segments.includes("..")) return null;

  const candidates = [resolve(root, targetFilePath)];
  const rootName = basename(root);
  const rootMarker = `${rootName}/`;
  const rootIndex = normalizedTarget.indexOf(rootMarker);
  if (rootIndex >= 0) {
    candidates.push(resolve(root, normalizedTarget.slice(rootIndex + rootMarker.length)));
  }

  for (const sourcePath of candidates) {
    const relativePath = relative(root, sourcePath);
    if (isOutsideProject(root, sourcePath) || !relativePath || !existsSync(sourcePath)) continue;
    return { sourcePath, relativePath };
  }
  return null;
}

function isOutsideProject(projectRoot: string, sourcePath: string): boolean {
  const relativePath = relative(projectRoot, sourcePath);
  return (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function replaceTargetMethod(source: string, generatedCode: string): string {
  const code = generatedCode
    .trim()
    .replace(/^```(?:csharp|cs)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const openingBrace = code.indexOf("{");
  if (openingBrace < 0) throw new Error("Generated C# code must contain a method body.");

  const declarations = [...code.slice(0, openingBrace).matchAll(/([A-Za-z_]\w*)\s*\(/g)];
  const methodName = declarations.at(-1)?.[1];
  if (!methodName) throw new Error("Unable to determine the generated C# method name.");

  const declaration = new RegExp(
    `^[\\t ]*(?:(?:public|private|protected|internal|static|abstract|virtual|override|sealed|async|extern|unsafe|new|partial)\\s+)+[^\\n;=]*\\b${escapeRegExp(methodName)}\\s*\\(`,
    "m",
  ).exec(source);
  if (declaration?.index === undefined) {
    throw new Error(`Target method ${methodName} was not found in the skeleton source.`);
  }
  const sourceOpeningBrace = source.indexOf("{", declaration.index);
  if (sourceOpeningBrace < 0) {
    throw new Error(`Target method ${methodName} does not have a block body.`);
  }
  const sourceClosingBrace = matchingBrace(source, sourceOpeningBrace);
  const declarationStart = source.lastIndexOf("\n", declaration.index) + 1;
  const indentation = source.slice(declarationStart).match(/^\s*/)?.[0] ?? "";
  const replacement = indentCode(code, indentation);

  return `${source.slice(0, declarationStart)}${replacement}${source.slice(sourceClosingBrace + 1)}`;
}

function matchingBrace(source: string, openingBrace: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (character === "/" && next === "*") {
      index = source.indexOf("*/", index + 2);
      if (index < 0) break;
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  throw new Error("Target method contains an unmatched brace.");
}

function indentCode(code: string, indentation: string): string {
  const lines = code.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim());
  const commonIndent = Math.min(
    ...nonEmpty.map((line) => line.match(/^\s*/)?.[0].length ?? 0),
  );
  return lines
    .map((line) => `${indentation}${line.slice(commonIndent)}`.trimEnd())
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const compilerInternals = { buildWrapperSource, replaceTargetMethod, resolveProjectTargetFile };
