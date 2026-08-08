import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  repairTranslation,
  translateJavaToCSharp,
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
  it("consumes target context and AnalysisReport in a separate system/user model call", async () => {
    const request = fixture("translator-direct");
    const calls: Array<Record<string, unknown>> = [];

    const result = await translateWithAnalysis(
      request,
      { apiKey: "test-key", request: modelRequest(resultFor(request), calls) },
    );

    expect(result.generatedCode).toContain(request.targetContext.targetSignature);
    expect(result.interfaceMappings).toEqual(request.analysisReport.contractMapping);
    const messages = calls[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).toContain("immutable target contract");
    expect(messages[1]?.content).toContain("ICalculationCache.GetAsync");
    expect(messages[1]?.content).toContain("ANALYSIS_REPORT_JSON");
    expect(calls[0]?.response_format).toEqual({ type: "json_object" });
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

  it("keeps the legacy Java-to-C# entry point compatible", async () => {
    const targetSignature = "public decimal Calculate()";
    const legacyPlan = [
      "Preserve the exact target signature and asynchronous convention.",
      "Implement the stated requirement using only target-available dependencies.",
    ];
    const response: TranslationResult = {
      schemaVersion: "1.0",
      generatedCode: `${targetSignature} { return 1.0m; }`,
      interfaceMappings: [],
      completedSteps: legacyPlan,
      unresolved: [],
    };
    vi.stubGlobal("fetch", modelRequest(response));

    await expect(
      translateJavaToCSharp(
        {
          javaSource: "public double calculate() { return 1.0; }",
          csharpSignature: targetSignature,
          requirement: "Translate calculation.",
          matchType: "exact",
        },
        "test-key",
      ),
    ).resolves.toBe(`${targetSignature} { return 1.0m; }`);
  });
});
