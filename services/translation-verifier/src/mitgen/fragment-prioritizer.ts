/**
 * 片段选择:启发式预筛评分(确定性、无 LLM)+ LLM 打分合并排序(CamPri 简化版)。
 *
 * 排序键 = w1·llmRiskScore + w2·llmFixabilityScore + w3·heuristicScore,
 * 默认 w1=0.5, w2=0.3, w3=0.2(可注入)。启发式分同时用作 tie-break,
 * 保证相同输入下排序完全确定(片段 id 兜底)。
 */
import type { CodeFragment, FragmentScore, RankWeights } from "./types.js";

export const DEFAULT_RANK_WEIGHTS: RankWeights = { risk: 0.5, fixability: 0.3, heuristic: 0.2 };

/** 各特征标签对启发式分的加权(分数 = 标签权重和,封顶 1.0)。 */
const FEATURE_WEIGHTS: Record<string, number> = {
  boundary: 0.25, // 比较运算/边界常量:边界错误高发
  empty: 0.2, // null/空集合检查
  string: 0.15, // 字符串操作
  container: 0.15, // 集合/容器操作
  arithmetic: 0.15, // 算术(溢出/off-by-one)
  loop: 0.1, // 循环边界
  guard: 0.1, // 早退守卫
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 启发式优先分(0..1):特征标签加权和 + 嵌套深度加成(深度由 features 里的 "nested" 标签带出)。
 * 纯函数、确定性:同一片段总是得到同一分数。
 */
export function heuristicScore(fragment: CodeFragment): number {
  let score = 0;
  for (const feature of fragment.features) {
    score += FEATURE_WEIGHTS[feature] ?? 0;
  }
  // 嵌套深度:每层嵌套 +0.05(封顶 +0.15),深嵌套片段通常更易出错。
  const nestedCount = fragment.features.filter((f) => f === "nested").length;
  score += Math.min(nestedCount, 3) * 0.05;
  return round3(clamp01(score));
}

/** 单个片段的综合排序分。 */
function compositeScore(fragment: CodeFragment, score: FragmentScore | undefined, weights: RankWeights): number {
  const risk = clamp01(score?.llmRiskScore ?? 0.5);
  const fixability = clamp01(score?.llmFixabilityScore ?? 0.5);
  const heuristic = clamp01(fragment.heuristicScore);
  return weights.risk * risk + weights.fixability * fixability + weights.heuristic * heuristic;
}

/**
 * 按综合分降序排列片段(原地排序,返回新数组)。
 * - 无对应 LLM 分数的片段按中性值(0.5/0.5)参与排序,启发式分主导;
 * - 同分时依次按启发式分、片段 id 兜底,保证确定性。
 */
export function rankFragments(
  fragments: CodeFragment[],
  scores: FragmentScore[],
  weights: RankWeights = DEFAULT_RANK_WEIGHTS,
): CodeFragment[] {
  const byId = new Map(scores.map((s) => [s.fragmentId, s]));
  return [...fragments].sort((a, b) => {
    const diff = compositeScore(b, byId.get(b.id), weights) - compositeScore(a, byId.get(a.id), weights);
    if (diff !== 0) return diff;
    if (b.heuristicScore !== a.heuristicScore) return b.heuristicScore - a.heuristicScore;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 解析 LLM 批量打分输出(宽松容错):
 * - 接受 `{ "scores": [...] }` 或裸数组;
 * - 分数收敛到 0..1(非法/缺失 → 0.5),rationale 缺失 → 空串;
 * - 非法片段 id 跳过。返回的数组顺序不影响排序(按 fragmentId 对齐)。
 */
export function parseFragmentScores(raw: unknown): FragmentScore[] {
  const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as Record<string, unknown>)?.scores) ? (raw as { scores: unknown[] }).scores : [];
  const scores: FragmentScore[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.fragmentId !== "string" || !record.fragmentId) continue;
    scores.push({
      fragmentId: record.fragmentId,
      llmRiskScore: clamp01(typeof record.llmRiskScore === "number" ? record.llmRiskScore : 0.5),
      llmFixabilityScore: clamp01(typeof record.llmFixabilityScore === "number" ? record.llmFixabilityScore : 0.5),
      rationale: typeof record.rationale === "string" ? record.rationale : "",
    });
  }
  return scores;
}
