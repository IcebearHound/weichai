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

export { translateJavaToCSharp, fixCompileErrors } from "./translator";
export type { TranslateRequest } from "./translator";

export { compileStandalone, compileIntegrated } from "./compiler";
export type { CompileResult } from "./compiler";
