/**
 * @forexplore/adaptation-service
 *
 * Java → C# 代码适配服务：
 *   LLM 翻译 → 编译校验 → 自动修复 → 回填
 */

export { AdaptationAdapter } from "./adaptation-adapter";
export type { AdaptationAdapterOptions } from "./adaptation-adapter";

export { BackfillAdapter } from "./backfill-adapter";
export type { BackfillAdapterOptions } from "./backfill-adapter";

export {
  fixCompileErrors,
  repairTranslation,
  translateJavaToCSharp,
  translateWithAnalysis,
} from "./translator";
export type {
  AnalyzeTranslationRequest,
  ApplicabilityLevel,
  RepairTranslationRequest,
  TranslateRequest,
  TranslationMapping,
  TranslationResult,
  TranslatorAnalysisReport,
  TranslatorModelOptions,
  TranslatorTargetContext,
  ValidationFeedback,
} from "./translator";

export { compileStandalone, compileIntegrated } from "./compiler";
export type { CompileResult } from "./compiler";

export { adaptationModelConfig, loadAdaptationModelConfig } from "./model-config";
export type { AdaptationModelConfig } from "./model-config";

export { loadConfig } from "./config";
export type { AdaptationServiceConfig } from "./config";

export { createHttpServer } from "./http-server";
export type { HttpServerOptions } from "./http-server";
