/**
 * CodeAdaptationPort 实现 — 核心编排
 *
 * 流程: LLM翻译 → 独立编译 → 自动修复(最多3轮) → 集成编译 → 生成结果
 */

import type {
  AdaptationRequest,
  AdaptationResult,
  FilePatch,
  InterfaceMapping,
  Language,
} from "@forexplore/contracts";
import type { CodeAdaptationPort } from "@forexplore/workflow-core";
import { translateJavaToCSharp, fixCompileErrors } from "./translator";
import { compileStandalone, compileIntegrated } from "./compiler";

const MAX_RETRIES = 3;

export interface AdaptationAdapterOptions {
  /** DeepSeek API key */
  apiKey: string;
  /** C# skeleton 项目根目录（可选，有则启用集成编译） */
  skeletonProjectPath?: string;
}

export class AdaptationAdapter implements CodeAdaptationPort {
  #apiKey: string;
  #skeletonProjectPath?: string;

  constructor(options: AdaptationAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#skeletonProjectPath = options.skeletonProjectPath;
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

    // ===== Step 2: 独立编译 + 自动修复 =====
    let standaloneResult = compileStandalone(csharpCode, request.target.name);
    let retries = 0;

    while (!standaloneResult.success && retries < MAX_RETRIES) {
      csharpCode = await fixCompileErrors(
        csharpCode,
        standaloneResult.errors,
        request.target.signature,
        request.requirement,
        this.#apiKey,
        signal,
      );
      standaloneResult = compileStandalone(csharpCode, request.target.name);
      retries++;
    }

    // ===== Step 3: 集成编译（如果有 skeleton 项目） =====
    let integratedResult = null;
    if (this.#skeletonProjectPath) {
      integratedResult = compileIntegrated(
        csharpCode,
        this.#skeletonProjectPath,
        request.target.path,
      );
    }

    // ===== Step 4: 生成映射 =====
    const mappings = buildMappings(request.candidate.preview, csharpCode);

    // ===== Step 5: 生成 FilePatch =====
    const patch = buildFilePatch(request.target.path, csharpCode);

    return {
      strategy: request.strategy,
      targetLanguage: "C#" as Language,
      generatedCode: csharpCode,
      interfaceMappings: mappings,
      validation: [
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
              : "待修复"
            : "未执行（需 skeleton 项目路径）",
        },
      ],
      files: [patch],
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

function buildFilePatch(filePath: string, newCode: string): FilePatch {
  const lines = newCode.split("\n");
  return {
    path: filePath,
    status: "modified",
    additions: lines.length,
    deletions: 1,
    hunks: [
      {
        header: `@@ -0,0 +1,${lines.length} @@`,
        lines: lines.map((content) => ({
          type: "add" as const,
          content,
        })),
      },
    ],
  };
}
