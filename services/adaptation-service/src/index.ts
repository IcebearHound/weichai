/**
 * @forexplore/adaptation-service
 *
 * Language-neutral code adaptation service:
 *   Analyzer report → Translator → target validation → protected patch
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
  projectTargetContext,
  repairTranslation,
  TranslatorAgent,
  translateWithAnalysis,
} from "./translator";
export type {
  AnalyzeTranslationRequest,
  ApplicabilityLevel,
  RepairTranslationRequest,
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

export {
  compileStandalone,
  compileIntegrated,
  compileJavaStandalone,
  compileJavaIntegrated,
  compileTargetStandalone,
  compileTargetIntegrated,
  compilerCommand,
} from "./compiler";
export type { CompileResult } from "./compiler";

export { deepSeekModelConfig, loadDeepSeekModelConfig } from "./model-config";
export type { DeepSeekModelConfig } from "./model-config";

export { chatCompletionContent, completeWithDeepSeek } from "./deepseek-client";
export type { DeepSeekClientOptions, DeepSeekMessage } from "./deepseek-client";

export { loadConfig } from "./config";
export type { AdaptationServiceConfig } from "./config";

export { createHttpServer } from "./http-server";
export type { HttpServerOptions } from "./http-server";
