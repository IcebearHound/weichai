import type { AdaptationRequest, SearchCandidate } from "@forexplore/contracts";
import { describe, expect, it } from "vitest";
import { AdaptationAdapter } from "./adaptation-adapter";

const javaCandidate: SearchCandidate = {
  id: "java-candidate",
  title: "calculate",
  repository: "fixture/java",
  license: "Apache-2.0",
  language: "Java",
  kind: "function",
  path: "src/Calculator.java",
  signature: "public double calculate()",
  summary: "Calculates a value.",
  score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
  preview: "public double calculate() { return 1.0; }",
  dependencies: [],
  compatibility: [],
  risks: [],
};

const request: AdaptationRequest = {
  target: {
    id: "target",
    name: "Calculate",
    kind: "function",
    path: "src/Calculator.cs",
    language: "C#",
    signature: "public decimal Calculate()",
  },
  candidate: javaCandidate,
  requirement: "Translate the calculation.",
  strategy: "translate",
  decisionNotes: "",
};

describe("AdaptationAdapter language gate", () => {
  const adapter = new AdaptationAdapter({ apiKey: "not-used-by-gate-tests" });

  it("rejects non-Java candidates before invoking the translator", async () => {
    await expect(
      adapter.adapt({
        ...request,
        candidate: { ...javaCandidate, language: "Python" },
      }),
    ).rejects.toThrow(
      "Unsupported adaptation language pair: Python -> C#. Expected Java -> C#.",
    );
  });

  it("rejects non-C# targets before invoking the translator", async () => {
    await expect(
      adapter.adapt({
        ...request,
        target: { ...request.target, language: "TypeScript" },
      }),
    ).rejects.toThrow(
      "Unsupported adaptation language pair: Java -> TypeScript. Expected Java -> C#.",
    );
  });

  it("rejects strategies unsupported by the Java-to-C# adapter", async () => {
    await expect(adapter.adapt({ ...request, strategy: "wrap" })).rejects.toThrow(
      'AdaptationAdapter only supports the "translate" strategy; received "wrap".',
    );
  });
});
