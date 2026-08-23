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
export { SmokeAgent } from "./smoke-agent.js";
export type { SmokeAgentOptions } from "./smoke-agent.js";
export type {
  SmokeAction,
  SmokeCaseVerdict,
  SmokeReport,
  SmokeDecision,
  SmokeSide,
} from "./smoke-types.js";
