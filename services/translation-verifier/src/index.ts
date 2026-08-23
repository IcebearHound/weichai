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
export { MitGenMigratorAgent } from "./mitgen/mitgen-migrator.js";
export type { MitGenOptions } from "./mitgen/mitgen-migrator.js";
export type {
  CodeFragment,
  FragmentKind,
  FragmentScore,
  Correspondence,
  Reachability,
  FragmentReport,
  MitGenResult,
  RankWeights,
} from "./mitgen/types.js";
export { extractFragments } from "./mitgen/fragment-extractor.js";
export { heuristicScore, rankFragments } from "./mitgen/fragment-prioritizer.js";
export { instrumentFragment, extractMarkers } from "./mitgen/splicer.js";
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

// AID / TrickCatcher 变体轨道(参考组 vs 目标的行为差异差分,oracle 来自共识/行为差异)。
export * from "./variant/index.js";
