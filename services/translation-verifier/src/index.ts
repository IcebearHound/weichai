export const translationVerifierSchemaVersion = "1.0" as const;

export { verify } from "./verifier.js";
export type { VerificationJob, VerificationReport, SideRunInfo } from "./verifier.js";
export { TestMigratorAgent } from "./test-migrator.js";
export type { MigrationInput, TestMigratorOptions } from "./test-migrator.js";
export { RealDriverExecutor } from "./executor.js";
export type {
  CompileOutcome,
  DriverExecutor,
  RealExecutorOptions,
  RunOutcome,
  SideFile,
  SideSpec,
} from "./executor.js";
export { generateDriverSource, generateSourceDriverSource } from "./driver/driver-codegen.js";
export type { SourceInvocation } from "./driver/source-invocation.js";
export type { TestDescription, TypedValue, VerifierLanguage } from "./description.js";

// AID / TrickCatcher 变体轨道(参考组 vs 目标的行为差异差分,oracle 来自共识/行为差异)。
export * from "./variant/index.js";
