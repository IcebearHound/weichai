/**
 * CodeAdaptationPort orchestration:
 * collect context -> analyze -> translate -> validate/repair -> patch preview.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AnalysisReport,
  AnalysisRequest,
  AdaptationRequest,
  AdaptationResult,
  FilePatch,
  Language,
  TargetModuleContext,
  ValidationRecord,
} from "@forexplore/contracts";
import { analysisSchemaVersion } from "@forexplore/contracts";
import type { CodeAdaptationPort } from "@forexplore/workflow-core";
import { AnalyzerAgent } from "./analyzer";
import {
  collectTargetContext,
  type ContextCollectorOptions,
} from "./context-collector";
import {
  projectTargetContext,
  repairTranslation,
  translateToJava,
  translateWithAnalysis,
  type AnalyzeTranslationRequest,
  type TranslatorModelOptions,
} from "./translator";
import {
  compileJavaIntegrated,
  compileJavaStandalone,
  compileIntegrated,
  compileStandalone,
  isCompilerUnavailable,
  resolveProjectTargetFile,
  type CompileResult,
} from "./compiler";

const MAX_RETRIES = 3;
const STANDALONE_CLASS_NAME = "ForeXploreStandalone";

export interface AdaptationAdapterOptions {
  /** DeepSeek API key used by the specialized translation agents */
  apiKey: string;
  /** Target skeleton project root (optional; enables integrated compilation). */
  skeletonProjectPath?: string;
  /** 目标项目根目录（可选，有则生成定点 context patch 而非全量替换） */
  projectRoot?: string;
  analyzer?: AdaptationAnalyzer;
  contextCollector?: AdaptationContextCollector;
  translatorRequest?: typeof globalThis.fetch;
  validator?: AdaptationValidator;
}

export interface AdaptationAnalyzer {
  analyze(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisReport>;
}

export type AdaptationContextCollector = (
  options: ContextCollectorOptions,
) => TargetModuleContext;

export interface AdaptationValidator {
  compileStandalone(code: string, targetName: string): CompileResult;
  compileIntegrated(
    code: string,
    skeletonProjectPath: string,
    targetFilePath: string,
  ): CompileResult;
  compileJavaStandalone?(code: string, targetName: string): CompileResult;
  compileJavaIntegrated?(
    code: string,
    skeletonProjectPath: string,
    targetFilePath: string,
  ): CompileResult;
  isUnavailable(result: CompileResult): boolean;
}

const defaultValidator: AdaptationValidator = {
  compileStandalone,
  compileIntegrated,
  compileJavaStandalone,
  compileJavaIntegrated,
  isUnavailable: isCompilerUnavailable,
};

export class AdaptationAdapter implements CodeAdaptationPort {
  #skeletonProjectPath?: string;
  #projectRoot?: string;
  #analyzer: AdaptationAnalyzer;
  #contextCollector: AdaptationContextCollector;
  #translatorOptions: TranslatorModelOptions;
  #validator: AdaptationValidator;

  constructor(options: AdaptationAdapterOptions) {
    this.#skeletonProjectPath = options.skeletonProjectPath;
    this.#projectRoot = options.projectRoot;
    this.#analyzer = options.analyzer ?? new AnalyzerAgent({ apiKey: options.apiKey });
    this.#contextCollector = options.contextCollector ?? collectTargetContext;
    this.#translatorOptions = options.translatorRequest
      ? { apiKey: options.apiKey, request: options.translatorRequest }
      : { apiKey: options.apiKey };
    this.#validator = options.validator ?? defaultValidator;
  }

  async adapt(
    request: AdaptationRequest,
    signal?: AbortSignal,
  ): Promise<AdaptationResult> {
    assertSupportedTranslation(request);
    const projectRoot = this.#projectRoot ?? this.#skeletonProjectPath;
    if (!projectRoot) {
      throw new Error(
        "AdaptationAdapter requires projectRoot or skeletonProjectPath to collect target context.",
      );
    }
    const requirement = effectiveRequirement(request);
    if (request.target.language === "Java") {
      // Candidate source languages deliberately stay unrestricted. The
      // selected corpus implementation is translated into this Java contract.
      return this.#adaptToJava(request, projectRoot, requirement, signal);
    }

    // Legacy C# target support remains for the standalone service API. The
    // VS Code benchmark extension always selects a Java target.
    const collectedContext = this.#contextCollector({
      projectRoot,
      target: request.target,
      signal,
    });
    const analysisReport = await this.#analyzer.analyze(
      {
        schemaVersion: analysisSchemaVersion,
        targetContext: collectedContext,
        candidate: request.candidate,
        requirement,
        immutableConstraints: collectedContext.constraints,
        decisionNotes: request.decisionNotes,
      },
      signal,
    );

    const translationInput: AnalyzeTranslationRequest = {
      candidateSource: request.candidate.preview,
      targetContext: projectTargetContext(collectedContext),
      requirement,
      analysisReport,
    };
    let translationResult = await translateWithAnalysis(
      translationInput,
      this.#translatorOptions,
      signal,
    );
    let csharpCode = translationResult.generatedCode;

    // ===== Step 2: 编译 + 自动修复 =====
    let standaloneResult = this.#validator.compileStandalone(csharpCode, STANDALONE_CLASS_NAME);
    let integratedResult = this.#skeletonProjectPath
      ? this.#validator.compileIntegrated(
          csharpCode,
          this.#skeletonProjectPath,
          request.target.path,
        )
      : null;
    let retries = 0;
    let repairResult = integratedResult ?? standaloneResult;

    while (
      !repairResult.success &&
      !this.#validator.isUnavailable(repairResult) &&
      retries < MAX_RETRIES
    ) {
      translationResult = await repairTranslation(
        {
          ...translationInput,
          previousResult: translationResult,
          validationFeedback: compilerFeedback(repairResult.errors),
        },
        this.#translatorOptions,
        signal,
      );
      csharpCode = translationResult.generatedCode;
      standaloneResult = this.#validator.compileStandalone(csharpCode, STANDALONE_CLASS_NAME);
      integratedResult = this.#skeletonProjectPath
        ? this.#validator.compileIntegrated(
            csharpCode,
            this.#skeletonProjectPath,
            request.target.path,
          )
        : null;
      repairResult = integratedResult ?? standaloneResult;
      retries++;
    }

    // ===== Step 4: 生成 FilePatch =====
    const targetSnapshot = readOriginalIfAvailable(
      projectRoot,
      request.target.path,
    );
    const canBuildPatch = targetSnapshot.content !== null && request.target.line != null;
    const patch = canBuildPatch
      ? buildFilePatch(
          request.target.path,
          csharpCode,
          targetSnapshot.content,
          request.target.line,
        )
      : null;

    return {
      strategy: request.strategy,
      targetLanguage: "C#" as Language,
      generatedCode: csharpCode,
      interfaceMappings: translationResult.interfaceMappings,
      validation: [
        {
          id: "analyzer",
          label: "Analyzer",
          status: "pass",
          required: true,
          summary: `${analysisReport.applicability.level} (${Math.round(
            analysisReport.applicability.confidence * 100,
          )}%)`,
        },
        standaloneCompileValidation(
          standaloneResult,
          integratedResult,
          this.#validator.isUnavailable(standaloneResult),
        ),
        integratedResult
          ? compileValidation(
              "integrated-compile",
              "目标工程集成编译",
              integratedResult,
              true,
              this.#validator.isUnavailable(integratedResult),
            )
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
            : targetSnapshot.reason ?? "未能读取目标文件或确定目标行，未生成可写回补丁。",
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

  async #adaptToJava(
    request: AdaptationRequest,
    projectRoot: string,
    requirement: string,
    signal?: AbortSignal,
  ): Promise<AdaptationResult> {
    const generatedJava = await translateToJava(
      {
        sourceLanguage: request.candidate.language,
        sourceCode: request.candidate.preview,
        javaSignature: request.target.signature,
        requirement,
        matchType: "exact",
      },
      this.#translatorOptions.apiKey,
      signal,
      { request: this.#translatorOptions.request },
    );
    const unavailable: CompileResult = {
      success: false,
      errors: ["JDK not installed; Java validation was not executed."],
      output: "",
    };
    const standaloneResult = this.#validator.compileJavaStandalone?.(
      generatedJava,
      STANDALONE_CLASS_NAME,
    ) ?? unavailable;
    const integratedResult = this.#skeletonProjectPath
      ? this.#validator.compileJavaIntegrated?.(
          generatedJava,
          this.#skeletonProjectPath,
          request.target.path,
        ) ?? unavailable
      : null;
    const targetSnapshot = readOriginalIfAvailable(projectRoot, request.target.path);
    const canBuildPatch = targetSnapshot.content !== null && request.target.line != null;
    const patch = canBuildPatch
      ? buildFilePatch(
          request.target.path,
          generatedJava,
          targetSnapshot.content,
          request.target.line,
        )
      : null;

    return {
      strategy: request.strategy,
      targetLanguage: "Java" as Language,
      generatedCode: generatedJava,
      interfaceMappings: [
        {
          source: request.candidate.title,
          target: request.target.name,
          action: "convert",
          note: `Translate the selected ${request.candidate.language} implementation into the existing Java method contract.`,
        },
      ],
      validation: [
        {
          id: "translation-direction",
          label: `${request.candidate.language} to Java direction`,
          status: "pass",
          required: true,
          summary: `The selected ${request.candidate.language} candidate is being translated into the Java target contract.`,
        },
        javaStandaloneCompileValidation(
          standaloneResult,
          integratedResult,
          this.#validator.isUnavailable(standaloneResult),
        ),
        integratedResult
          ? javaCompileValidation(
              "integrated-compile",
              "Java target project compilation",
              integratedResult,
              true,
              this.#validator.isUnavailable(integratedResult),
            )
          : {
              id: "integrated-compile",
              label: "Java target project compilation",
              status: "unverified",
              required: false,
              summary: "No target skeleton project was configured, so integrated compilation was not run.",
              failureReason: "skeleton-project-not-configured",
            },
        {
          id: "target-context-snapshot",
          label: "Target file snapshot",
          status: canBuildPatch ? "pass" : "unverified",
          required: true,
          summary: canBuildPatch
            ? "Read the target file and generated a patch guarded by its original hash."
            : targetSnapshot.reason ?? "The target file could not be read, so no protected patch was generated.",
          failureReason: canBuildPatch ? undefined : "target-context-unavailable",
        },
        {
          id: "behavioral-semantics",
          label: "Behavioral validation",
          status: "unverified",
          required: false,
          summary: "Compilation validates syntax only; multipart streaming and storage behavior still require the upstream tests.",
        },
      ],
      files: patch ? [patch] : [],
    };
  }
}

// ---- helpers ----

function effectiveRequirement(request: AdaptationRequest): string {
  return (
    request.requirement.trim() ||
    request.target.documentation?.trim() ||
    `Implement the target contract: ${request.target.signature}`
  );
}

function compilerFeedback(errors: string[]): {
  status: "fail";
  issues: Array<{ category: "syntax"; message: string }>;
} {
  return {
    status: "fail",
    issues: (errors.length > 0 ? errors : ["Compiler failed without diagnostics."]).map(
      (message) => ({ category: "syntax" as const, message }),
    ),
  };
}

function assertSupportedTranslation(request: AdaptationRequest): void {
  if (request.strategy !== "translate") {
    throw new Error(
      `AdaptationAdapter only supports the "translate" strategy; received "${request.strategy}".`,
    );
  }
  if (request.target.language !== "Java" && request.target.language !== "C#") {
    throw new Error(
      `AdaptationAdapter supports Java benchmark targets and legacy C# targets; received target language ${request.target.language}.`,
    );
  }
  if (!isSafeRelativePath(request.target.path)) {
    throw new Error(
      `Target path must be a non-escaping project-relative path; received "${request.target.path}".`,
    );
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
  const resolvedTarget = resolveProjectTargetFile(root, filePath);
  if (!resolvedTarget) {
    const fullPath = resolve(root, filePath);
    if (!isInsideRoot(root, fullPath)) {
      return { content: null, reason: "目标文件路径超出配置的目标工程根目录。" };
    }
    return { content: null, reason: "目标文件不存在，无法生成受保护的定点补丁。" };
  }
  const realFile = realpathSync(resolvedTarget.sourcePath);
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
  if (startIdx >= originalLines.length || !isMethodStart(originalLines[startIdx] ?? "")) {
    throw new Error("The target line must point at a method declaration before a safe patch can be built.");
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
  unavailable: boolean,
  command = "dotnet build --nologo -v q",
): ValidationRecord {
  return {
    id,
    label,
    status: unavailable ? "unverified" : result.success ? "pass" : "fail",
    required,
    command,
    summary: result.success
      ? "编译通过。编译通过不证明业务行为正确。"
      : result.errors.slice(0, 3).join("; "),
    failureReason: result.success ? undefined : unavailable ? "compiler-unavailable" : "compiler-failed",
  };
}

function javaCompileValidation(
  id: string,
  label: string,
  result: CompileResult,
  required: boolean,
  unavailable: boolean,
): ValidationRecord {
  return compileValidation(id, label, result, required, unavailable, "javac");
}

function javaStandaloneCompileValidation(
  result: CompileResult,
  integratedResult: CompileResult | null,
  unavailable: boolean,
): ValidationRecord {
  const record = javaCompileValidation(
    "standalone-compile",
    "Java standalone compilation",
    result,
    integratedResult === null,
    unavailable,
  );

  if (integratedResult?.success && !result.success) {
    return {
      ...record,
      status: "warn",
      required: false,
      summary:
        `The standalone wrapper lacks project types or dependencies: ${result.errors.slice(0, 3).join("; ")}` +
        " The target project compilation is the authoritative compilation evidence.",
      failureReason: undefined,
    };
  }

  return record;
}

/**
 * A minimal wrapper cannot resolve members supplied by the real target type.
 * Once the complete skeleton project has compiled, that project result is the
 * authoritative compilation evidence and a wrapper-only error is diagnostic.
 */
function standaloneCompileValidation(
  result: CompileResult,
  integratedResult: CompileResult | null,
  unavailable: boolean,
): ValidationRecord {
  const required = integratedResult === null;
  const record = compileValidation(
    "standalone-compile",
    "独立编译",
    result,
    required,
    unavailable,
  );

  if (integratedResult?.success && !result.success) {
    return {
      ...record,
      status: "warn",
      summary:
        `最小 wrapper 未包含目标类字段或项目依赖：${result.errors.slice(0, 3).join("; ")}` +
        " 目标工程集成编译已通过，集成结果为权威编译证据。",
      failureReason: undefined,
    };
  }

  return record;
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

function isMethodStart(line: string): boolean {
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
