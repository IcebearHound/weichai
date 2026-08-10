/**
 * CodeAdaptationPort orchestration:
 * collect context -> analyze -> translate -> validate/repair -> patch preview.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AnalysisReport,
  AnalysisRequest,
  AdaptationRequest,
  AdaptationResult,
  FilePatch,
  Language,
  TargetModuleContext,
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
  translateWithAnalysis,
  type AnalyzeTranslationRequest,
  type TranslatorModelOptions,
} from "./translator";
import {
  compileIntegrated,
  compileStandalone,
  isCompilerUnavailable,
  type CompileResult,
} from "./compiler";

const MAX_RETRIES = 3;

export interface AdaptationAdapterOptions {
  /** DeepSeek API key */
  apiKey: string;
  /** C# skeleton 项目根目录（可选，有则启用集成编译） */
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
  isUnavailable(result: CompileResult): boolean;
}

const defaultValidator: AdaptationValidator = {
  compileStandalone,
  compileIntegrated,
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
    let standaloneResult = this.#validator.compileStandalone(csharpCode, request.target.name);
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
      standaloneResult = this.#validator.compileStandalone(csharpCode, request.target.name);
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
    const originalContent = readOriginalIfAvailable(
      projectRoot,
      request.target.path,
    );
    const patch = buildFilePatch(
      request.target.path,
      csharpCode,
      originalContent,
      request.target.line,
    );

    return {
      strategy: request.strategy,
      targetLanguage: "C#" as Language,
      generatedCode: csharpCode,
      interfaceMappings: translationResult.interfaceMappings,
      validation: [
        {
          label: "Analyzer",
          status: "pass",
          detail: `${analysisReport.applicability.level} (${Math.round(
            analysisReport.applicability.confidence * 100,
          )}%)`,
        },
        {
          label: "独立编译",
          status: standaloneResult.success ? "pass" : "warn",
          detail: standaloneResult.success
            ? "编译通过"
            : standaloneResult.errors.slice(0, 3).join("; "),
        },
        {
          label: "集成编译",
          status: integratedResult?.success ? "pass" : "warn",
          detail: integratedResult
            ? integratedResult.success
              ? "编译通过"
              : integratedResult.errors.slice(0, 3).join("; ")
            : "未执行（需 skeleton 项目路径）",
        },
      ],
      files: [patch],
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
  if (
    request.candidate.language !== "Java" ||
    request.target.language !== "C#"
  ) {
    throw new Error(
      `Unsupported adaptation language pair: ${request.candidate.language} -> ${request.target.language}. Expected Java -> C#.`,
    );
  }
}

function readOriginalIfAvailable(
  projectRoot: string | undefined,
  filePath: string,
): string | null {
  if (!projectRoot) return null;
  const fullPath = join(projectRoot, filePath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : null;
}

function buildFilePatch(
  filePath: string,
  newCode: string,
  originalContent: string | null,
  targetLine?: number,
): FilePatch {
  const newLines = newCode.split("\n");

  // 无法做定点 patch 时回退到全量替换
  if (!originalContent || targetLine == null) {
    return {
      path: filePath,
      status: "modified",
      additions: newLines.length,
      deletions: 0,
      hunks: [
        {
          header: `@@ -0,0 +1,${newLines.length} @@`,
          lines: newLines.map((content) => ({
            type: "add" as const,
            content,
          })),
        },
      ],
    };
  }

  // 定点 patch：用括号匹配找到原方法体范围
  const originalLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  const startIdx = Math.max(0, targetLine - 1);

  // 找到方法体的闭合大括号
  const endIdx = findMethodEnd(originalLines, startIdx);
  const removedLines = originalLines.slice(startIdx, endIdx + 1);

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
    additions: newLines.length,
    deletions: removedLines.length,
    hunks: [{ header: `@@ -${startIdx + 1},${removedLines.length} +${startIdx + 1},${newLines.length} @@`, lines: hunkLines }],
  };
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
