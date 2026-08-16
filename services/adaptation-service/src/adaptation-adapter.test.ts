import { fileURLToPath } from "node:url";
import type {
  AnalysisReport,
  AnalysisRequest,
  AdaptationRequest,
  SearchCandidate,
} from "@forexplore/contracts";
import { describe, expect, it } from "vitest";
import { AdaptationAdapter, _buildFilePatch } from "./adaptation-adapter";
import type { CompileResult } from "./compiler";

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

  it("rejects targets outside the Java and legacy C# service paths", async () => {
    await expect(
      adapter.adapt({
        ...request,
        target: { ...request.target, language: "TypeScript" },
      }),
    ).rejects.toThrow(
      "AdaptationAdapter supports Java benchmark targets and legacy C# targets; received target language TypeScript.",
    );
  });

  it("rejects strategies unsupported by the adapter", async () => {
    await expect(adapter.adapt({ ...request, strategy: "wrap" })).rejects.toThrow(
      'AdaptationAdapter only supports the "translate" strategy; received "wrap".',
    );
  });

  it("routes a Python candidate into the Java translation and validation path", async () => {
    const compilerSuccess: CompileResult = { success: true, errors: [], output: "" };
    const prompts: string[] = [];
    const adapter = new AdaptationAdapter({
      apiKey: "test-key",
      projectRoot: process.cwd(),
      translatorRequest: (async (_input: URL | RequestInfo, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        prompts.push(request.messages[0]?.content ?? "");
        return new Response(JSON.stringify({
          choices: [{ message: { content: "public void calculate() { }" } }],
        }), { status: 200 });
      }) as typeof globalThis.fetch,
      validator: {
        compileStandalone: () => compilerSuccess,
        compileIntegrated: () => compilerSuccess,
        compileJavaStandalone: () => compilerSuccess,
        compileJavaIntegrated: () => compilerSuccess,
        isUnavailable: () => false,
      },
    });
    const result = await adapter.adapt({
      ...request,
      target: {
        ...request.target,
        path: "src/Calculator.java",
        language: "Java",
        signature: "public void calculate()",
      },
      candidate: {
        ...javaCandidate,
        language: "Python",
        preview: "def calculate():\n    return None",
      },
    });

    expect(result.targetLanguage).toBe("Java");
    expect(result.generatedCode).toBe("public void calculate() { }");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("【源语言】\nPython");
    expect(result.validation.find((record) => record.id === "standalone-compile"))
      .toMatchObject({ status: "pass", command: "javac" });
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
    const generatedCode = `public async ${integrationRequest.target.signature}\n{\n    throw new NotImplementedException();\n}`;
    const modelBodies: Array<Record<string, unknown>> = [];
    const translatorRequest = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      modelBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          schemaVersion: "1.0",
          generatedCode,
          interfaceMappings: analysisReport.contractMapping,
          completedSteps: analysisReport.implementationPlan,
          unresolved: [],
        }) } }],
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
      id: "analyzer",
      label: "Analyzer",
      status: "pass",
      required: true,
      summary: "adapt (86%)",
    });
  });

  it("uses integrated compilation as the required gate when the standalone wrapper lacks target fields", async () => {
    const analyzer = {
      async analyze(): Promise<AnalysisReport> {
        return analysisReport;
      },
    };
    const generatedCode = `public async ${integrationRequest.target.signature}\n{\n    return await cache.GetOrLoadAsync(request, token => FetchWithFallbackAsync(request, token), cancellationToken);\n}`;
    const translatorRequest = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        schemaVersion: "1.0",
        generatedCode,
        interfaceMappings: analysisReport.contractMapping,
        completedSteps: analysisReport.implementationPlan,
        unresolved: [],
      }) } }],
    }), { status: 200 })) as typeof globalThis.fetch;
    const standaloneFailure: CompileResult = {
      success: false,
      errors: ['The name "cache" does not exist in the current context.'],
      output: "",
    };
    const integratedSuccess: CompileResult = { success: true, errors: [], output: "" };
    const adapter = new AdaptationAdapter({
      apiKey: "test-key",
      projectRoot,
      skeletonProjectPath: projectRoot,
      analyzer,
      translatorRequest,
      validator: {
        compileStandalone: () => standaloneFailure,
        compileIntegrated: () => integratedSuccess,
        isUnavailable: () => false,
      },
    });

    const result = await adapter.adapt(integrationRequest);
    const standalone = result.validation.find((item) => item.id === "standalone-compile");
    const integrated = result.validation.find((item) => item.id === "integrated-compile");

    expect(standalone).toMatchObject({ status: "warn", required: false });
    expect(standalone?.summary).toContain("集成结果为权威编译证据");
    expect(integrated).toMatchObject({ status: "pass", required: true });
    expect(result.files).toHaveLength(1);
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
    if (patch.status !== "modified") throw new Error("expected a modified patch");
    expect(patch.expectedOriginalSha256).toMatch(/^[a-f0-9]{64}$/);
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

  it("refuses to create a blind patch without an original file snapshot", () => {
    expect(() => _buildFilePatch("src/Service.cs", newMethod, null, 8)).toThrow(
      "Cannot build a safe patch",
    );
  });

  it("refuses to create a patch without a target declaration line", () => {
    expect(() => _buildFilePatch("src/Service.cs", newMethod, originalClass, undefined)).toThrow(
      "Cannot build a safe patch",
    );
  });

  it("refuses a target line that does not start a C# method", () => {
    expect(() => _buildFilePatch("src/Service.cs", newMethod, originalClass, 10)).toThrow(
      "method declaration",
    );
  });
});
