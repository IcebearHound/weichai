import { fileURLToPath } from "node:url";
import type { ModuleTarget } from "@forexplore/contracts";
import { describe, expect, it } from "vitest";
import { collectTargetContext } from "./context-collector";

const projectRoot = fileURLToPath(
  new URL("../../../fixtures/target-system/forexplore-csharp-workspace", import.meta.url),
);

const target: ModuleTarget = {
  id: "get-quote-async-function",
  name: "GetQuoteAsync",
  kind: "function",
  path: "src/Application/QuoteOrchestrationService.cs",
  language: "C#",
  signature: "Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)",
  line: 24,
};

describe("collectTargetContext", () => {
  it("collects the target method, class structure, constraints, and direct dependencies", () => {
    const context = collectTargetContext({ projectRoot, target });

    expect(context.schemaVersion).toBe("1.0");
    expect(context.source.method).toContain("GetQuoteAsync");
    expect(context.source.containingType).toContain("QuoteOrchestrationService");
    expect(context.source.fields).toEqual(
      expect.arrayContaining([
        "private readonly IReadOnlyList<IQuoteProvider> providers;",
        "private readonly IQuoteCache cache;",
        "private readonly IAuditJournal audit;",
      ]),
    );
    expect(context.source.constructor).toContain("QuoteOrchestrationService");
    expect(context.source.relatedMembers).toEqual(
      expect.arrayContaining([expect.stringContaining("FetchWithFallbackAsync")]),
    );
    expect(context.constraints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Normalize pair once"),
        expect.stringContaining("Providers are attempted"),
      ]),
    );

    const dependencyNames = context.dependencies.map((dependency) => dependency.name);
    expect(dependencyNames).toEqual(
      expect.arrayContaining(["Quote", "QuoteRequest", "IQuoteProvider", "IQuoteCache", "IAuditJournal"]),
    );
    expect(context.relatedTypes.map((type) => type.name)).toEqual(
      expect.arrayContaining(["Quote", "QuoteRequest", "IQuoteProvider", "IQuoteCache", "IAuditJournal"]),
    );
  });

  it("rejects targets outside the configured project root", () => {
    expect(() =>
      collectTargetContext({
        projectRoot,
        target: { ...target, path: "../outside.cs" },
      }),
    ).toThrow("Target path must stay inside the project root");
  });

  it("reports missing files and missing symbols clearly", () => {
    expect(() =>
      collectTargetContext({
        projectRoot,
        target: { ...target, path: "src/Application/Missing.cs" },
      }),
    ).toThrow("Target file does not exist");

    expect(() =>
      collectTargetContext({
        projectRoot,
        target: { ...target, name: "MissingMethod", signature: "Task MissingMethod()" },
      }),
    ).toThrow("Target MissingMethod was not found");
  });

  it("resolves a workspace-relative target path prefixed by the project folder", () => {
    const context = collectTargetContext({
      projectRoot,
      target: {
        id: "append-async-function",
        name: "AppendAsync",
        kind: "function",
        path: "weichai/fixtures/target-system/forexplore-csharp-workspace/src/Application/AuditPipeline.cs",
        language: "C#",
        signature: "ValueTask<long> AppendAsync(string action, string subject, string payload, CancellationToken cancellationToken)",
        line: 16,
      },
    });

    expect(context.source.method).toContain("AppendAsync");
    expect(context.collection.targetFile).toBe("src/Application/AuditPipeline.cs");
  });

  it("records truncation when the configured context budget is small", () => {
    const context = collectTargetContext({ projectRoot, target, maxChars: 3_000 });

    expect(context.collection.truncated).toBe(true);
    expect(context.collection.truncatedSections.length).toBeGreaterThan(0);
    expect(context.collection.actualChars).toBeLessThanOrEqual(3_000);
  });

  it("honors an already-aborted signal", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => collectTargetContext({ projectRoot, target, signal: controller.signal })).toThrow();
  });
});
