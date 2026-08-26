import { describe, expect, it } from "vitest";
import { extractFragments } from "./fragment-extractor.js";
import { DEFAULT_RANK_WEIGHTS, heuristicScore, parseFragmentScores, rankFragments } from "./fragment-prioritizer.js";
import type { CodeFragment, FragmentScore, RankWeights } from "./types.js";

function fragment(overrides: Partial<CodeFragment>): CodeFragment {
  return {
    id: "frag-01",
    kind: "expression",
    start: 0,
    end: 1,
    code: "x",
    pathCondition: "无条件(方法入口即达)",
    features: [],
    heuristicScore: 0,
    ...overrides,
  };
}

describe("heuristicScore(启发式单调性)", () => {
  it("scores 0 for a plain expression fragment", () => {
    expect(heuristicScore(fragment({}))).toBe(0);
  });

  it("comparison operators add boundary score", () => {
    const base = heuristicScore(fragment({ features: [] }));
    const withComparison = heuristicScore(fragment({ features: ["boundary"] }));
    expect(withComparison).toBeGreaterThan(base);
    expect(withComparison).toBeCloseTo(0.25);
  });

  it("null/empty checks add empty score", () => {
    const score = heuristicScore(fragment({ features: ["empty"] }));
    expect(score).toBe(0.2);
  });

  it("multiple risk features accumulate up to 1.0", () => {
    const score = heuristicScore(fragment({ features: ["boundary", "empty", "string", "container", "arithmetic", "loop", "guard"] }));
    expect(score).toBe(1);
  });

  it("nested fragments score higher than flat ones", () => {
    const flat = heuristicScore(fragment({ features: ["boundary"] }));
    const nested = heuristicScore(fragment({ features: ["boundary", "nested"] }));
    expect(nested).toBeGreaterThan(flat);
  });

  it("is deterministic for identical fragments", () => {
    const a = fragment({ features: ["boundary", "empty"] });
    const b = fragment({ features: ["boundary", "empty"] });
    expect(heuristicScore(a)).toBe(heuristicScore(b));
  });
});

describe("rankFragments(确定性排序)", () => {
  function frags(): CodeFragment[] {
    return [
      fragment({ id: "frag-01", features: ["boundary"], heuristicScore: 0.25 }),
      fragment({ id: "frag-02", features: ["empty"], heuristicScore: 0.2 }),
      fragment({ id: "frag-03", features: [], heuristicScore: 0 }),
    ];
  }

  it("sorts by composite score with default weights (risk dominates)", () => {
    const scores: FragmentScore[] = [
      { fragmentId: "frag-01", llmRiskScore: 0.2, llmFixabilityScore: 0.5, rationale: "low risk" },
      { fragmentId: "frag-03", llmRiskScore: 0.9, llmFixabilityScore: 0.5, rationale: "high risk" },
    ];
    const ranked = rankFragments(frags(), scores);
    // frag-03: 0.9*0.5 + 0.5*0.3 + 0*0.2 = 0.60; frag-02(无 LLM 分数,中性 0.5): 0.5*0.5+0.5*0.3+0.2*0.2 = 0.44;
    // frag-01: 0.2*0.5 + 0.5*0.3 + 0.25*0.2 = 0.30
    expect(ranked.map((f) => f.id)).toEqual(["frag-03", "frag-02", "frag-01"]);
  });

  it("produces the same order for identical inputs (deterministic)", () => {
    const scores: FragmentScore[] = [
      { fragmentId: "frag-01", llmRiskScore: 0.8, llmFixabilityScore: 0.6, rationale: "" },
      { fragmentId: "frag-02", llmRiskScore: 0.8, llmFixabilityScore: 0.6, rationale: "" },
      { fragmentId: "frag-03", llmRiskScore: 0.8, llmFixabilityScore: 0.6, rationale: "" },
    ];
    const first = rankFragments(frags(), scores).map((f) => f.id);
    const second = rankFragments(frags(), scores).map((f) => f.id);
    expect(first).toEqual(second);
    // 综合分相同 → 启发式分 tie-break → frag-01(0.25) > frag-02(0.2) > frag-03(0)。
    expect(first).toEqual(["frag-01", "frag-02", "frag-03"]);
  });

  it("does not mutate the input array", () => {
    const input = frags();
    const before = input.map((f) => f.id);
    rankFragments(input, []);
    expect(input.map((f) => f.id)).toEqual(before);
  });
});

describe("rankFragments(权重注入)", () => {
  it("heuristic-only weights rank by heuristicScore", () => {
    const weights: RankWeights = { risk: 0, fixability: 0, heuristic: 1 };
    const scores: FragmentScore[] = [
      { fragmentId: "frag-03", llmRiskScore: 0.9, llmFixabilityScore: 0.9, rationale: "" },
      { fragmentId: "frag-01", llmRiskScore: 0.1, llmFixabilityScore: 0.1, rationale: "" },
    ];
    const ranked = rankFragments(
      [
        fragment({ id: "frag-01", features: ["boundary"], heuristicScore: 0.25 }),
        fragment({ id: "frag-03", features: [], heuristicScore: 0 }),
      ],
      scores,
      weights,
    );
    expect(ranked[0]?.id).toBe("frag-01");
    expect(ranked[1]?.id).toBe("frag-03");
  });

  it("respects default weights constant", () => {
    expect(DEFAULT_RANK_WEIGHTS).toEqual({ risk: 0.5, fixability: 0.3, heuristic: 0.2 });
  });
});

describe("parseFragmentScores", () => {
  it("parses the object form with a scores array", () => {
    const raw = {
      scores: [
        { fragmentId: "frag-01", llmRiskScore: 0.8, llmFixabilityScore: 0.6, rationale: "边界比较" },
      ],
    };
    expect(parseFragmentScores(raw)).toEqual([
      { fragmentId: "frag-01", llmRiskScore: 0.8, llmFixabilityScore: 0.6, rationale: "边界比较" },
    ]);
  });

  it("parses a bare array and clamps out-of-range numbers", () => {
    const raw = [{ fragmentId: "frag-02", llmRiskScore: 1.5, llmFixabilityScore: -1, rationale: "" }];
    expect(parseFragmentScores(raw)).toEqual([
      { fragmentId: "frag-02", llmRiskScore: 1, llmFixabilityScore: 0, rationale: "" },
    ]);
  });

  it("returns [] for invalid shapes and skips invalid entries", () => {
    expect(parseFragmentScores(null)).toEqual([]);
    expect(parseFragmentScores({ foo: 1 })).toEqual([]);
    expect(parseFragmentScores([{ llmRiskScore: 0.5 }, { fragmentId: "frag-03", llmRiskScore: "x" }])).toEqual([
      { fragmentId: "frag-03", llmRiskScore: 0.5, llmFixabilityScore: 0.5, rationale: "" },
    ]);
  });
});
