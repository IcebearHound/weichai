/**
 * CodeAdaptationPort 实现 — 核心编排
 *
 * 流程: LLM翻译 → 独立编译 → 自动修复(最多3轮) → 集成编译 → 生成结果
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AdaptationRequest,
  AdaptationResult,
  FilePatch,
  InterfaceMapping,
  Language,
  ValidationRecord,
} from "@forexplore/contracts";
import type { CodeAdaptationPort } from "@forexplore/workflow-core";
import { translateJavaToCSharp, fixCompileErrors } from "./translator";
import {
  compileIntegrated,
  compileStandalone,
  isCompilerUnavailable,
} from "./compiler";

const MAX_RETRIES = 3;

export interface AdaptationAdapterOptions {
  /** DeepSeek API key */
  apiKey: string;
  /** C# skeleton 项目根目录（可选，有则启用集成编译） */
  skeletonProjectPath?: string;
  /** 目标项目根目录（可选，有则生成定点 context patch 而非全量替换） */
  projectRoot?: string;
}

export class AdaptationAdapter implements CodeAdaptationPort {
  #apiKey: string;
  #skeletonProjectPath?: string;
  #projectRoot?: string;

  constructor(options: AdaptationAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#skeletonProjectPath = options.skeletonProjectPath;
    this.#projectRoot = options.projectRoot;
  }

  async adapt(
    request: AdaptationRequest,
    signal?: AbortSignal,
  ): Promise<AdaptationResult> {
    assertSupportedTranslation(request);
    const matchType = inferMatchType(request);

    // ===== Step 1: LLM 翻译 =====
    let csharpCode = await translateJavaToCSharp(
      {
        javaSource: request.candidate.preview,
        csharpSignature: request.target.signature,
        requirement: request.requirement,
        matchType,
      },
      this.#apiKey,
      signal,
    );

    // ===== Step 2: 编译 + 自动修复 =====
    let standaloneResult = compileStandalone(csharpCode, request.target.name);
    let integratedResult = this.#skeletonProjectPath
      ? compileIntegrated(csharpCode, this.#skeletonProjectPath, request.target.path)
      : null;
    let retries = 0;
    let repairResult = integratedResult ?? standaloneResult;

    while (
      !repairResult.success &&
      !isCompilerUnavailable(repairResult) &&
      retries < MAX_RETRIES
    ) {
      csharpCode = await fixCompileErrors(
        csharpCode,
        repairResult.errors,
        request.target.signature,
        request.requirement,
        this.#apiKey,
        signal,
      );
      standaloneResult = compileStandalone(csharpCode, request.target.name);
      integratedResult = this.#skeletonProjectPath
        ? compileIntegrated(csharpCode, this.#skeletonProjectPath, request.target.path)
        : null;
      repairResult = integratedResult ?? standaloneResult;
      retries++;
    }

    // ===== Step 3: 生成映射 =====
    const mappings = buildMappings(request.candidate.preview, csharpCode);

    // ===== Step 4: 生成 FilePatch =====
    const targetContext = readOriginalIfAvailable(
      this.#projectRoot,
      request.target.path,
    );
    const canBuildPatch = targetContext.content !== null && request.target.line != null;
    const patch = canBuildPatch
      ? buildFilePatch(
          request.target.path,
          csharpCode,
          targetContext.content,
          request.target.line,
        )
      : null;

    return {
      strategy: request.strategy,
      targetLanguage: "C#" as Language,
      generatedCode: csharpCode,
      interfaceMappings: mappings,
      validation: [
        compileValidation("standalone-compile", "独立编译", standaloneResult, true),
        integratedResult
          ? compileValidation("integrated-compile", "目标工程集成编译", integratedResult, true)
          : {
              id: "integrated-compile",
              label: "目标工程集成编译",
              status: "unverified",
              required: false,
              summary: "未配置目标 skeleton 工程，因此未执行集成编译。",
              failureReason: "skeleton-project-not-configured",
            },
        {
          id: "target-context-snapshot",
          label: "目标文件快照",
          status: canBuildPatch ? "pass" : "unverified",
          required: true,
          summary: canBuildPatch
            ? "已读取目标文件并生成带原始内容哈希的定点补丁。"
            : targetContext.reason ?? "未能读取目标文件或确定目标行，未生成可写回补丁。",
          failureReason: canBuildPatch ? undefined : "target-context-unavailable",
        },
        {
          id: "behavioral-semantics",
          label: "业务行为验证",
          status: "unverified",
          required: false,
          summary: "当前仅包含编译验证；尚未证明业务行为、并发、超时或取消语义正确。",
        },
      ],
      files: patch ? [patch] : [],
    };
  }
}

// ---- helpers ----

function assertSupportedTranslation(request: AdaptationRequest): void {
  if (request.strategy !== "translate") {
    throw new Error(
      `AdaptationAdapter only supports the "translate" strategy; received "${request.strategy}".`,
    );
  }
  if (
    request.candidate.language !== "Java" ||
    request.target.language !== "C#"
  ) {
    throw new Error(
      `Unsupported adaptation language pair: ${request.candidate.language} -> ${request.target.language}. Expected Java -> C#.`,
    );
  }
  if (!isSafeRelativePath(request.target.path)) {
    throw new Error(
      `Target path must be a non-escaping project-relative path; received "${request.target.path}".`,
    );
  }
}

function inferMatchType(request: AdaptationRequest): "exact" | "partial" | "different" {
  const notes = request.decisionNotes.toLowerCase();
  if (notes.includes("partial") || notes.includes("部分")) return "partial";
  if (notes.includes("different") || notes.includes("不同")) return "different";
  return "exact";
}

/** 从 Java 源码和 C# 代码中推断类型映射 */
function buildMappings(
  _javaSource: string,
  _csharpCode: string,
): InterfaceMapping[] {
  const rules: Array<[string, string, InterfaceMapping["action"]]> = [
    ["double", "decimal", "convert"],
    ["List<", "List<", "preserve"],
    ["boolean", "bool", "convert"],
    ["String", "string", "convert"],
    ["Map<", "Dictionary<", "convert"],
    ["public class", "public class", "preserve"],
  ];

  return rules
    .filter(([java]) => _javaSource.includes(java))
    .map(([source, target, action]) => ({
      source,
      target,
      action,
      note: typeMapNote(action, source, target),
    }));
}

function typeMapNote(
  action: InterfaceMapping["action"],
  source: string,
  target: string,
): string {
  switch (action) {
    case "convert":
      return `${source} -> ${target} 类型转换`;
    case "preserve":
      return `${source} 保持一致`;
    default:
      return `${source} -> ${target}`;
  }
}

function readOriginalIfAvailable(
  projectRoot: string | undefined,
  filePath: string,
): { content: string | null; reason?: string } {
  if (!projectRoot) {
    return { content: null, reason: "未配置目标工程根目录，无法建立回填前置快照。" };
  }
  if (!existsSync(projectRoot)) {
    return { content: null, reason: "配置的目标工程根目录不存在。" };
  }
  const root = realpathSync(resolve(projectRoot));
  const fullPath = resolve(root, filePath);
  if (!isInsideRoot(root, fullPath)) {
    return { content: null, reason: "目标文件路径超出配置的目标工程根目录。" };
  }
  if (!existsSync(fullPath)) {
    return { content: null, reason: "目标文件不存在，无法生成受保护的定点补丁。" };
  }
  const realFile = realpathSync(fullPath);
  if (!isInsideRoot(root, realFile)) {
    return { content: null, reason: "目标文件经符号链接解析后超出配置的目标工程根目录。" };
  }
  return { content: readFileSync(realFile, "utf-8") };
}

function buildFilePatch(
  filePath: string,
  newCode: string,
  originalContent: string | null,
  targetLine?: number,
): FilePatch {
  const newLines = newCode.split("\n");

  // A blind all-add patch is unsafe: callers must preserve an exact source
  // precondition and regenerate after the target changed.
  if (!originalContent || targetLine == null) {
    throw new Error("Cannot build a safe patch without target file content and line information.");
  }

  // 定点 patch：用括号匹配找到原方法体范围
  const originalLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  const startIdx = Math.max(0, targetLine - 1);
  if (startIdx >= originalLines.length || !isCSharpMethodStart(originalLines[startIdx] ?? "")) {
    throw new Error("The target line must point at a C# method declaration before a safe patch can be built.");
  }

  // 找到方法体的闭合大括号
  const endIdx = findMethodEnd(originalLines, startIdx);
  const removedLines = originalLines.slice(startIdx, endIdx + 1);
  if (removedLines.length === 0) {
    throw new Error("Cannot build a patch because the selected target method is empty.");
  }

  // 用原方法签名作为 context 行来定位
  const contextBefore = startIdx > 0 ? originalLines[startIdx - 1] : null;
  const contextAfter =
    endIdx < originalLines.length - 1 ? originalLines[endIdx + 1] : null;

  const hunkLines: FilePatch["hunks"][number]["lines"] = [];

  // 前置 context：方法体前一行（通常是类声明或空行）
  if (contextBefore) {
    hunkLines.push({ type: "context", content: contextBefore });
  }

  // 原方法所有行标记为 remove
  for (const line of removedLines) {
    hunkLines.push({ type: "remove", content: line });
  }

  // 新方法所有行标记为 add
  for (const line of newLines) {
    hunkLines.push({ type: "add", content: line });
  }

  // 后置 context：方法体后一行
  if (contextAfter) {
    hunkLines.push({ type: "context", content: contextAfter });
  }

  return {
    path: filePath,
    status: "modified",
    expectedOriginalSha256: sha256(originalContent),
    additions: newLines.length,
    deletions: removedLines.length,
    hunks: [{ header: `@@ -${startIdx + 1},${removedLines.length} +${startIdx + 1},${newLines.length} @@`, lines: hunkLines }],
  };
}

function compileValidation(
  id: string,
  label: string,
  result: ReturnType<typeof compileStandalone>,
  required: boolean,
): ValidationRecord {
  const unavailable = isCompilerUnavailable(result);
  return {
    id,
    label,
    status: unavailable ? "unverified" : result.success ? "pass" : "fail",
    required,
    command: "dotnet build --nologo -v q",
    summary: result.success
      ? "编译通过。编译通过不证明业务行为正确。"
      : result.errors.slice(0, 3).join("; "),
    failureReason: result.success ? undefined : unavailable ? "compiler-unavailable" : "compiler-failed",
  };
}

function isSafeRelativePath(filePath: string): boolean {
  if (!filePath || isAbsolute(filePath)) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return normalized !== ".." && !normalized.startsWith("../");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function isCSharpMethodStart(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^(if|for|foreach|while|switch|catch|using|return|new|throw)\b/.test(trimmed)) {
    return false;
  }
  return /\b[A-Za-z_][\w]*\s*(?:<[^>]+>)?\s*\(/.test(trimmed);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 从 startIdx 开始，用括号深度匹配找到方法/代码块的结束行（0-based 索引） */
function findMethodEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth === 0) {
      return i;
    }
  }
  // 未找到匹配括号时回退到文件末尾
  return lines.length - 1;
}

/** @internal 暴露给测试 */
export { buildFilePatch as _buildFilePatch };
