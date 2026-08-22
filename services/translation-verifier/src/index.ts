export const translationVerifierSchemaVersion = "1.0" as const;

export { verify } from "./verifier.js";
export type { VerificationJob, VerificationReport, SideRunInfo } from "./verifier.js";
export { TestMigratorAgent } from "./test-migrator.js";
export type { MigrationInput, TestMigratorOptions } from "./test-migrator.js";
export { LlmAnalyzer, NoneCoverageProvider } from "./analyzer.js";
export type {
  AnalyzerLike,
  BranchCoverage,
  BranchInfo,
  BranchInventory,
  CaseConsistency,
  ConsistencyReport,
  CoverageProvider,
  LlmAnalyzerOptions,
} from "./analyzer.js";
export { DescriptionValidator, buildValidatorFeedbackPrompt, filterDriverErrors } from "./validator.js";
export type { DescriptionValidatorOptions } from "./validator.js";
export { runConsistencyVerification } from "./consistency-verifier.js";
export type { ConsistencyResult, ConsistencyVerifierOptions } from "./consistency-verifier.js";
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
