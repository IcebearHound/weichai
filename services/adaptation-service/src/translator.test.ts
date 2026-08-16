import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  repairTranslation,
  TranslatorAgent,
  translateWithAnalysis,
  translatorInternals,
  type AnalyzeTranslationRequest,
  type TranslationResult,
} from "./translator";

function fixture(name: string): AnalyzeTranslationRequest {
  const path = fileURLToPath(new URL(`../testdata/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as AnalyzeTranslationRequest;
}

function resultFor(
  request: AnalyzeTranslationRequest,
  generatedCode = `${request.targetContext.targetSignature}\n{\n    return await _cache.GetAsync(key, cancellationToken);\n}`,
): TranslationResult {
  return {
    schemaVersion: "1.0",
    generatedCode,
    interfaceMappings: request.analysisReport.contractMapping.map((mapping) => ({ ...mapping })),
    completedSteps: [...request.analysisReport.implementationPlan],
    unresolved: [],
  };
}

function modelRequest(
  result: TranslationResult,
  calls: Array<Record<string, unknown>> = [],
): typeof globalThis.fetch {
  return (async (_input: URL | RequestInfo, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("Translator Agent", () => {
  it("sends target context and AnalysisReport through DeepSeek Chat Completions", async () => {
    const request = fixture("translator-direct");
    const calls: Array<Record<string, unknown>> = [];

    const result = await translateWithAnalysis(
      request,
      { apiKey: "test-key", request: modelRequest(resultFor(request), calls) },
    );

    expect(result.generatedCode).toContain(request.targetContext.targetSignature);
    expect(result.interfaceMappings).toEqual(request.analysisReport.contractMapping);
    expect(calls[0]?.model).toBe("deepseek-v4-flash");
    expect(calls[0]?.response_format).toEqual({ type: "json_object" });
    const messages = calls[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).toContain("Translator Agent");
    expect(messages[1]?.content).toContain("ICalculationCache.GetAsync");
    expect(messages[1]?.content).toContain("ANALYSIS_REPORT_JSON");
  });

  it("runs as an independent agent and receives only the AnalysisReport handoff", async () => {
    const request = fixture("translator-direct");
    const calls: Array<Record<string, unknown>> = [];
    const agent = new TranslatorAgent({
      apiKey: "test-key",
      request: modelRequest(resultFor(request), calls),
    });

    await expect(agent.translate(request)).resolves.toEqual(resultFor(request));

    const messages = calls[0]?.messages as Array<{ content: string }>;
    const transcript = messages.map((message) => message.content).join("\n");
    expect(transcript).toContain("ANALYSIS_REPORT_JSON");
    expect(transcript).not.toContain("You are the Analyzer Agent");
    expect(transcript).not.toContain("[RETRIEVED CANDIDATE]");
  });

  it("stops before generation when Analyzer rejects the candidate", async () => {
    const request = fixture("translator-reject");
    const fetchMock = vi.fn();

    await expect(
      translateWithAnalysis(request, {
        apiKey: "test-key",
        request: fetchMock as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow("Analyzer rejected candidate");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops for unresolved dependencies instead of inventing a target dependency", async () => {
    const request = fixture("translator-adapt");
    request.analysisReport.dependencyPlan.push({
      sourceDependency: "unknown-library",
      action: "unresolved",
    });

    await expect(
      translateWithAnalysis(request, { apiKey: "test-key", request: vi.fn() as never }),
    ).rejects.toThrow("unknown-library");

    const unmapped = fixture("translator-adapt");
    unmapped.analysisReport.dependencyPlan[0] = {
      sourceDependency: "gateway",
      action: "adapt",
    };
    await expect(
      translateWithAnalysis(unmapped, { apiKey: "test-key", request: vi.fn() as never }),
    ).rejects.toThrow("gateway has no target dependency");
  });

  it("continues when the Analyzer reports a non-blocking open question", async () => {
    const request = fixture("translator-direct");
    request.analysisReport.unresolved = [
      "The target port's internal persistence strategy is not visible.",
    ];
    const calls: Array<Record<string, unknown>> = [];
    const expected = resultFor(request);

    await expect(
      translateWithAnalysis(request, {
        apiKey: "test-key",
        request: modelRequest(expected, calls),
      }),
    ).resolves.toEqual(expected);

    const messages = calls[0]?.messages as Array<{ content: string }>;
    expect(messages[1]?.content).toContain("OPEN_QUESTION_POLICY");
    expect(messages[1]?.content).toContain("non-blocking questions");
  });

  it("rejects a changed target signature", async () => {
    const request = fixture("translator-direct");
    const changed = resultFor(
      request,
      "public async Task<double> CalculateAsync(string key, CancellationToken cancellationToken) { return 1; }",
    );

    await expect(
      translateWithAnalysis(request, {
        apiKey: "test-key",
        request: modelRequest(changed),
      }),
    ).rejects.toThrow("changed the immutable target signature");
  });

  it("rejects extra visibility or async modifiers not present in the target signature", async () => {
    const request = fixture("translator-direct");
    request.targetContext.targetSignature =
      "Task<decimal> CalculateAsync(string key, CancellationToken cancellationToken)";
    const changed = resultFor(
      request,
      "public async Task<decimal> CalculateAsync(string key, CancellationToken cancellationToken) { return 1m; }",
    );

    await expect(
      translateWithAnalysis(request, {
        apiKey: "test-key",
        request: modelRequest(changed),
      }),
    ).rejects.toThrow("changed the immutable target signature");
  });

  it("rejects output that expands beyond the target module region", async () => {
    const request = fixture("translator-direct");
    const expanded = resultFor(
      request,
      `public class Calculator { ${request.targetContext.targetSignature} { return 1m; } }`,
    );

    await expect(
      translateWithAnalysis(request, {
        apiKey: "test-key",
        request: modelRequest(expanded),
      }),
    ).rejects.toThrow("must not generate an enclosing type");
  });

  it("feeds validation violations back to the model before failing", async () => {
    const request = fixture("translator-direct");
    const invalid = resultFor(
      request,
      `public class Calculator { ${request.targetContext.targetSignature} { return 1m; } }`,
    );
    const corrected = resultFor(request);
    const calls: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const result = calls.length === 1 ? invalid : corrected;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(result) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    await expect(
      translateWithAnalysis(request, { apiKey: "test-key", request: fetch }),
    ).resolves.toEqual(corrected);
    expect(calls).toHaveLength(2);
    expect((calls[1]?.messages as Array<{ content: string }>)[1]?.content).toContain(
      "VALIDATION_FEEDBACK_JSON",
    );
    expect((calls[1]?.messages as Array<{ content: string }>)[1]?.content).toContain(
      "enclosing type",
    );
  });

  it("stops when the Translator reports unresolved blockers", async () => {
    const request = fixture("translator-direct");
    const blocked = resultFor(request);
    blocked.unresolved = ["missing target dependency"];

    await expect(
      translateWithAnalysis(request, {
        apiKey: "test-key",
        request: modelRequest(blocked),
      }),
    ).rejects.toThrow("returned unresolved items");
  });

  it("rejects a member appended after the requested target method", async () => {
    const request = fixture("translator-direct");
    const expanded = resultFor(
      request,
      `${request.targetContext.targetSignature} { return await _cache.GetAsync(key, cancellationToken); }\nprivate void DeleteAll() { }`,
    );

    await expect(
      translateWithAnalysis(request, {
        apiKey: "test-key",
        request: modelRequest(expanded),
      }),
    ).rejects.toThrow("exactly one target method");
  });

  it("accepts one normal method with nested blocks, literals, and trailing comments", () => {
    const request = fixture("translator-direct");
    const complete = resultFor(
      request,
      `${request.targetContext.targetSignature}\n{\n  if (string.IsNullOrWhiteSpace(key))\n  {\n    throw new ArgumentException("{key}", nameof(key));\n  }\n\n  return await _cache.GetAsync(key, cancellationToken);\n}\n// End of generated method.`,
    );

    expect(() => translatorInternals.validateTranslationResult(complete, request)).not.toThrow();
  });

  it("accepts a valid expression-bodied target method", () => {
    const request = fixture("translator-direct");
    request.targetContext.targetSignature = "public decimal Calculate()";
    const complete = resultFor(request, "public decimal Calculate() => 1.0m;");

    expect(() => translatorInternals.validateTranslationResult(complete, request)).not.toThrow();
  });

  it("requires every planned step and contract mapping to be acknowledged", () => {
    const request = fixture("translator-direct");
    const incomplete = resultFor(request);
    incomplete.completedSteps.pop();

    expect(() =>
      translatorInternals.validateTranslationResult(incomplete, request),
    ).toThrow("did not complete implementationPlan items");

    const missingMapping = resultFor(request);
    missingMapping.interfaceMappings = [];
    expect(() =>
      translatorInternals.validateTranslationResult(missingMapping, request),
    ).toThrow("omitted required contract mappings");
  });

  it("rejects malformed structured model output", () => {
    expect(() => translatorInternals.parseTranslationResult("not-json")).toThrow(
      "invalid TranslationResult JSON",
    );
    expect(() =>
      translatorInternals.parseTranslationResult(
        JSON.stringify({
          schemaVersion: "1.0",
          generatedCode: "public void Run() {}",
          interfaceMappings: [{ source: "", target: "value", action: "convert", note: "map" }],
          completedSteps: ["step"],
          unresolved: [],
        }),
      ),
    ).toThrow("invalid interface mapping");
  });

  it("repairs from structured Validator feedback and preserves AnalysisReport constraints", async () => {
    const request = fixture("translator-direct");
    const previousResult = resultFor(request);
    const repairedResult = resultFor(
      request,
      `${request.targetContext.targetSignature}\n{\n    cancellationToken.ThrowIfCancellationRequested();\n    return await _cache.GetAsync(key, cancellationToken);\n}`,
    );
    const calls: Array<Record<string, unknown>> = [];

    const repaired = await repairTranslation(
      {
        ...request,
        previousResult,
        validationFeedback: {
          status: "fail",
          issues: [
            {
              category: "behavior",
              message: "Cancellation must be observed before the cache call.",
              evidence: "validator/cancellation-case",
            },
          ],
        },
      },
      { apiKey: "test-key", request: modelRequest(repairedResult, calls) },
    );

    expect(repaired.generatedCode).toContain("ThrowIfCancellationRequested");
    const messages = calls[0]?.messages as Array<{ content: string }>;
    expect(messages[1]?.content).toContain("VALIDATION_FEEDBACK_JSON");
    expect(messages[1]?.content).toContain("validator/cancellation-case");
  });

  it("allows repair to correct a previous contract violation", async () => {
    const request = fixture("translator-direct");
    const previousResult = resultFor(
      request,
      "public double Calculate(string key) { return 1.0; }",
    );
    const corrected = resultFor(request);

    await expect(
      repairTranslation(
        {
          ...request,
          previousResult,
          validationFeedback: {
            status: "fail",
            issues: [{ category: "contract", message: "Restore the target signature." }],
          },
        },
        { apiKey: "test-key", request: modelRequest(corrected) },
      ),
    ).resolves.toEqual(corrected);
  });

  it("returns an already-passing result without another repair call", async () => {
    const request = fixture("translator-direct");
    const previousResult = resultFor(request);
    const fetchMock = vi.fn();

    await expect(
      repairTranslation(
        {
          ...request,
          previousResult,
          validationFeedback: { status: "pass", issues: [] },
        },
        { apiKey: "test-key", request: fetchMock as unknown as typeof globalThis.fetch },
      ),
    ).resolves.toEqual(previousResult);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a complete class target and rejects a second top-level type", async () => {
    const request = fixture("translator-direct");
    request.targetContext.targetKind = "class";
    request.targetContext.targetLanguage = "Java";
    request.targetContext.targetSignature = "public class Calculator";
    request.targetContext.targetCode = [
      "public class Calculator {",
      "    private final Map<String, Double> cache = new HashMap<>();",
      "    public double calculate(String key) { return cache.getOrDefault(key, 0.0); }",
      "}",
    ].join("\n");
    request.analysisReport.implementationPlan = ["Preserve the complete target class contract."];
    request.analysisReport.contractMapping = [];

    const generatedCode = [
      "@Deprecated",
      "public class Calculator {",
      "    private final Map<String, Double> cache = new HashMap<>();",
      "    public double calculate(String key) {",
      "        return cache.getOrDefault(key, 0.0);",
      "    }",
      "}",
    ].join("\n");
    const expected = {
      schemaVersion: "1.0" as const,
      generatedCode,
      interfaceMappings: [],
      completedSteps: [...request.analysisReport.implementationPlan],
      unresolved: [],
    };

    await expect(
      translateWithAnalysis(request, {
        apiKey: "test-key",
        request: modelRequest(expected),
      }),
    ).resolves.toEqual(expected);

    const extraType = {
      ...expected,
      generatedCode: `${generatedCode}\nclass Unexpected {}`,
    };
    await expect(
      translateWithAnalysis(request, {
        apiKey: "test-key",
        request: modelRequest(extraType),
      }),
    ).rejects.toThrow("exactly one target class");
  });

  it("validates a Python class target without requiring braces", () => {
    const request = fixture("translator-direct");
    request.targetContext.targetKind = "class";
    request.targetContext.targetLanguage = "Python";
    request.targetContext.targetSignature = "class Calculator";
    request.analysisReport.contractMapping = [];
    const result = resultFor(
      request,
      "class Calculator:\n    def calculate(self, value):\n        return value",
    );

    expect(() => translatorInternals.validateTranslationResult(result, request)).not.toThrow();
  });

});
