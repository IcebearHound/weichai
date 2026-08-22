import { describe, expect, it } from "vitest";
import {
  buildCorrespondencePrompt,
  buildInputGenerationPrompt,
  buildRetryInputPrompt,
  buildScoringPrompt,
} from "./mitgen-prompts.js";
import { extractFragments } from "./fragment-extractor.js";
import type { CodeFragment } from "./types.js";

const INPUT = {
  requirement: "按边界裁剪分数:负数归零、超过上限封顶",
  sourceLanguage: "Java",
  sourceCode: `public static int clamp(int value, int max) {
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}`,
  repository: "demo-repo",
  sourcePath: "src/demo/Clamp.java",
};

function sampleFragments(): CodeFragment[] {
  return extractFragments(INPUT.sourceCode);
}

describe("buildScoringPrompt", () => {
  it("places REQUIREMENT first and includes fragment metadata", () => {
    const prompt = buildScoringPrompt(INPUT, sampleFragments());
    expect(prompt.startsWith("REQUIREMENT\n")).toBe(true);
    expect(prompt.indexOf("REQUIREMENT")).toBeLessThan(prompt.indexOf("SOURCE_METHOD"));
    expect(prompt).toContain("CANDIDATE_FRAGMENTS");
    expect(prompt).toContain("llmRiskScore");
    expect(prompt).toContain("llmFixabilityScore");
    expect(prompt).toContain("frag-01");
    expect(prompt).toContain("pathCondition");
    expect(prompt).toContain("SOURCE_METHOD");
    expect(prompt).toContain("demo-repo");
  });
});

describe("buildInputGenerationPrompt(pathCondition 引导)", () => {
  it("includes the fragment pathCondition and requires satisfying it", () => {
    const guard = sampleFragments().find((f) => f.kind === "guard") as CodeFragment;
    const prompt = buildInputGenerationPrompt(INPUT, guard, 3, "public static int clamp(int value, int max)");
    expect(prompt.startsWith("REQUIREMENT\n")).toBe(true);
    expect(prompt).toContain("TARGET_FRAGMENT");
    expect(prompt).toContain(`id: ${guard.id}`);
    expect(prompt).toContain("pathCondition: value < 0");
    expect(prompt).toContain("MUST satisfy the pathCondition");
    expect(prompt).toContain("Method signature: public static int clamp(int value, int max)");
    expect(prompt).toContain('"cases"');
  });

  it("caps candidate count at casesPerFragment", () => {
    const guard = sampleFragments().find((f) => f.kind === "guard") as CodeFragment;
    const prompt = buildInputGenerationPrompt(INPUT, guard, 3, undefined);
    expect(prompt).toContain("Generate up to 3 candidate inputs");
  });
});

describe("buildRetryInputPrompt(可达性反馈)", () => {
  it("feeds back the rejected inputs and the pathCondition", () => {
    const guard = sampleFragments().find((f) => f.kind === "guard") as CodeFragment;
    const prompt = buildRetryInputPrompt(INPUT, guard, [
      { description: "负值", inputs: [{ type: "number", value: -5 }] },
    ]);
    expect(prompt).toContain("FEEDBACK");
    expect(prompt).toContain("did NOT reach the fragment");
    expect(prompt).toContain("pathCondition: value < 0");
    expect(prompt).toContain('"type":"number"');
  });
});

describe("buildCorrespondencePrompt(允许结构重组)", () => {
  it("explicitly allows structural reorganization and requires behavioral equivalence", () => {
    const targetCode = `public static int clamp(int value, int max) {
  if (value >= 0 && value <= max) return value;
  return value < 0 ? 0 : max;
}`;
    const prompt = buildCorrespondencePrompt({ requirement: INPUT.requirement, targetCode }, sampleFragments());
    expect(prompt).toContain("TARGET_METHOD");
    expect(prompt).toContain("structural reorganization is ALLOWED");
    expect(prompt).toContain("behavioral equivalence");
    expect(prompt).toContain("correspondences");
    expect(prompt).toContain("equivalent|missing|divergent|unknown");
    expect(prompt).toContain("do not decide the verification verdict");
    expect(prompt).toContain("frag-01");
  });

  it("handles missing target code with a placeholder", () => {
    const prompt = buildCorrespondencePrompt({ requirement: INPUT.requirement }, sampleFragments());
    expect(prompt).toContain("目标源码未提供");
  });
});
