/**
 * 转发 shim:bug 注入器已移至 src/bug-injection.ts(评估框架 quality 模块需在 src 内复用,
 * 而 tsconfig rootDir=./src 禁止 src 导入 e2e)。run-e2e-aid.ts 仍从本路径导入,保持既有导入不变。
 */
export * from "../src/bug-injection.js";
