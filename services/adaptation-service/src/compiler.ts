/**
 * C# 编译校验器
 * 调用 dotnet build 或 csc 检查代码是否能通过编译。
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface CompileResult {
  success: boolean;
  errors: string[];
  output: string;
}

const MAX_RETRIES = 3;

/**
 * 独立编译一个 C# 方法体，不依赖项目类型定义。
 * 把翻译后的方法放进一个最小 wrapper class，用 dotnet build 验证。
 */
export function compileStandalone(
  csharpCode: string,
  className: string,
): CompileResult {
  const dir = join(tmpdir(), `cs-compile-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  const fullSource = buildWrapperSource(csharpCode, className);
  const csFile = join(dir, `${className}.cs`);
  writeFileSync(csFile, fullSource, "utf-8");

  try {
    if (hasDotnet()) {
      return compileWithDotnet(dir);
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
 * 集成编译 — 把翻译后的方法放到 C# skeleton 项目完整编译。
 * TODO: 等数据集交付后实现。
 */
export function compileIntegrated(
  _csharpCode: string,
  _skeletonProjectPath: string,
  _targetFilePath: string,
): CompileResult {
  return {
    success: true,
    errors: [],
    output: "Integrated compile not yet implemented (waiting for dataset)",
  };
}

// ---- helpers ----

function hasDotnet(): boolean {
  try {
    execSync("dotnet --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasCsc(): boolean {
  const paths = [
    join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return paths.some((p) => existsSync(p));
}

function compileWithDotnet(dir: string): CompileResult {
  const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
  </PropertyGroup>
</Project>`;
  writeFileSync(join(dir, "tmp.csproj"), csproj, "utf-8");

  try {
    const stdout = execSync("dotnet build --nologo -v q", {
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

public class ${className} {
${code}
}`;
}
