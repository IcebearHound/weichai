/**
 * @forexplore/adaptation-service
 *
 * Java → C# 代码适配服务：
 *   LLM 翻译 → 编译校验 → 自动修复 → 回填
 */

export { AdaptationAdapter } from "./adaptation-adapter";
export type {
  AdaptationAdapterOptions,
  AdaptationAnalyzer,
  AdaptationContextCollector,
  AdaptationValidator,
} from "./adaptation-adapter";

export { BackfillAdapter } from "./backfill-adapter";
export type { BackfillAdapterOptions } from "./backfill-adapter";

export {
  fixCompileErrors,
  projectTargetContext,
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

export {
  AnalyzerAgent,
  buildAnalyzerMessages,
  parseAnalysisReport,
  validateAnalysisReport,
} from "./analyzer";
export type {
  AnalyzerAgentOptions,
  AnalyzerMessage,
  AnalyzerModelClient,
} from "./analyzer";

export { collectTargetContext, serializeTargetContext } from "./context-collector";
export type { ContextCollectorOptions } from "./context-collector";

export { compileStandalone, compileIntegrated } from "./compiler";
export type { CompileResult } from "./compiler";

export { adaptationModelConfig, loadAdaptationModelConfig } from "./model-config";
export type { AdaptationModelConfig } from "./model-config";

export { loadConfig } from "./config";
export type { AdaptationServiceConfig } from "./config";

export { createHttpServer } from "./http-server";
export type { HttpServerOptions } from "./http-server";
