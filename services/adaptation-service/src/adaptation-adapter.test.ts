import { fileURLToPath } from "node:url";
import type {
  AnalysisReport,
  AnalysisRequest,
  AdaptationRequest,
  SearchCandidate,
} from "@forexplore/contracts";
import { describe, expect, it } from "vitest";
import { AdaptationAdapter, _buildFilePatch } from "./adaptation-adapter";

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

describe("AdaptationAdapter analyzer-translator integration", () => {
  const projectRoot = fileURLToPath(
    new URL("../../../fixtures/target-system/forexplore-csharp-workspace", import.meta.url),
  );
  const integrationRequest: AdaptationRequest = {
    ...request,
    target: {
      id: "get-quote-async-function",
      name: "GetQuoteAsync",
      kind: "function",
      path: "src/Application/QuoteOrchestrationService.cs",
      language: "C#",
      signature: "Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)",
      documentation: "Gets a quote through cache and provider fallback.",
      line: 24,
    },
    candidate: {
      ...javaCandidate,
      title: "route",
      signature: "public Quote route(QuoteRequest request)",
      preview: "public Quote route(QuoteRequest request) { return provider.fetch(request); }",
      dependencies: ["ProviderClient"],
    },
    requirement: "Preserve the asynchronous quote fallback contract.",
  };
  const analysisReport: AnalysisReport = {
    schemaVersion: "1.0",
    applicability: {
      level: "adapt",
      confidence: 0.86,
      reasons: ["The candidate behavior maps to the target contract with async adaptation."],
    },
    behaviorMapping: [{
      requirement: integrationRequest.requirement,
      status: "partial",
      candidateEvidence: ["provider.fetch(request)"],
      targetAction: "Keep the target asynchronous boundary and existing provider dependency.",
    }],
    contractMapping: [{
      source: "route",
      target: "GetQuoteAsync",
      action: "rename",
      note: "Preserve the target method name and signature.",
    }],
    dependencyPlan: [{
      sourceDependency: "ProviderClient",
      targetDependency: "IQuoteProvider",
      action: "adapt",
    }],
    implementationPlan: [
      "Preserve the exact target signature.",
      "Use the existing target provider dependency asynchronously.",
    ],
    risks: [],
    assumptions: [],
    unresolved: [],
  };

  it("collects real target context and passes the Analyzer report into Translator", async () => {
    let analyzerRequest: AnalysisRequest | undefined;
    const analyzer = {
      async analyze(value: AnalysisRequest): Promise<AnalysisReport> {
        analyzerRequest = value;
        return analysisReport;
      },
    };
    const generatedCode = `${integrationRequest.target.signature}\n{\n    throw new NotImplementedException();\n}`;
    const modelBodies: Array<Record<string, unknown>> = [];
    const translatorRequest = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      modelBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              schemaVersion: "1.0",
              generatedCode,
              interfaceMappings: analysisReport.contractMapping,
              completedSteps: analysisReport.implementationPlan,
              unresolved: [],
            }),
          },
        }],
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    const unavailable = {
      success: false,
      errors: [".NET SDK not installed; test validator skipped compilation."],
      output: "",
    };
    const adapter = new AdaptationAdapter({
      apiKey: "test-key",
      projectRoot,
      analyzer,
      translatorRequest,
      validator: {
        compileStandalone: () => unavailable,
        compileIntegrated: () => unavailable,
        isUnavailable: () => true,
      },
    });

    const result = await adapter.adapt(integrationRequest);

    expect(analyzerRequest?.targetContext.source.method).toContain("GetQuoteAsync");
    expect(analyzerRequest?.targetContext.source.containingType).toContain(
      "QuoteOrchestrationService",
    );
    expect(analyzerRequest?.candidate).toEqual(integrationRequest.candidate);
    expect(modelBodies).toHaveLength(1);
    const messages = modelBodies[0]?.messages as Array<{ content: string }>;
    expect(messages[1]?.content).toContain("ANALYSIS_REPORT_JSON");
    expect(messages[1]?.content).toContain("IQuoteProvider");
    expect(result.generatedCode).toBe(generatedCode);
    expect(result.interfaceMappings).toEqual(analysisReport.contractMapping);
    expect(result.validation[0]).toEqual({
      label: "Analyzer",
      status: "pass",
      detail: "adapt (86%)",
    });
  });
});

describe("buildFilePatch", () => {
  const originalClass = [
    "using System;",
    "using System.Collections.Generic;",
    "",
    "namespace MyApp.Services",
    "{",
    "    public class RateQuoteService",
    "    {",
    "        public decimal GetRate(string currencyPair)",
    "        {",
    "            throw new NotImplementedException();",
    "        }",
    "",
    "        public void Initialize()",
    "        {",
    "            // setup",
    "        }",
    "    }",
    "}",
  ].join("\n");

  const newMethod = [
    "        public decimal GetRate(string currencyPair)",
    "        {",
    "            return 0.92m;",
    "        }",
  ].join("\n");

  it("produces a context-based hunk when originalContent and targetLine are provided", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, originalClass, 8);

    expect(patch.status).toBe("modified");
    expect(patch.hunks).toHaveLength(1);

    const lines = patch.hunks[0].lines;
    const types = lines.map((l) => l.type);

    // 必须包含 context 行（用于定位）
    expect(types).toContain("context");
    // 必须包含 remove 行（旧方法代码被删除）
    expect(types).toContain("remove");
    // 必须包含 add 行（新方法代码被加入）
    expect(types).toContain("add");

    // context 行应该是原方法签名前的那一行
    const contextLines = lines.filter((l) => l.type === "context");
    expect(contextLines.some((l) => l.content.trim() === "{")).toBe(true);

    // remove 行应包含原方法的 throw 语句
    const removeLines = lines.filter((l) => l.type === "remove");
    expect(removeLines.some((l) => l.content.includes("throw new NotImplementedException"))).toBe(true);

    // add 行应包含新方法代码
    const addLines = lines.filter((l) => l.type === "add");
    expect(addLines.some((l) => l.content.includes("return 0.92m"))).toBe(true);
  });

  it("falls back to add-only patch when originalContent is null", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, null, 8);

    const lines = patch.hunks[0].lines;
    const types = [...new Set(lines.map((l) => l.type))];
    expect(types).toEqual(["add"]);
  });

  it("falls back to add-only patch when targetLine is undefined", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, originalClass, undefined);

    const lines = patch.hunks[0].lines;
    const types = [...new Set(lines.map((l) => l.type))];
    expect(types).toEqual(["add"]);
  });
});
