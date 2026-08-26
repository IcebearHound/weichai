/**
 * MitGen(微观测试生成)模块出口。
 *
 * 与 TestMigratorAgent 平级:消费相同 MigrationInput,产出 schema 兼容 TestDescription,
 * verifier/comparator/driver/executor/repair-loop 全部不动。
 */
export { MitGenMigratorAgent, MITGEN_SYSTEM_PROMPT } from "./mitgen-migrator.js";
export type { MitGenOptions } from "./mitgen-migrator.js";
export { extractFragments, locateMethod } from "./fragment-extractor.js";
export type { ExtractOptions, LocatedMethod } from "./fragment-extractor.js";
export { heuristicScore, rankFragments, parseFragmentScores, DEFAULT_RANK_WEIGHTS } from "./fragment-prioritizer.js";
export { instrumentFragment, extractMarkers, stripMarkers, MARKER_PREFIX } from "./splicer.js";
export {
  buildScoringPrompt,
  buildInputGenerationPrompt,
  buildRetryInputPrompt,
  buildCorrespondencePrompt,
} from "./mitgen-prompts.js";
export type {
  CodeFragment,
  FragmentKind,
  FragmentScore,
  Correspondence,
  Reachability,
  FragmentReport,
  MitGenResult,
  RankWeights,
} from "./types.js";
