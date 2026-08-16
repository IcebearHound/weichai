import { fileURLToPath } from "node:url";
import type { AnalysisReport, SearchCandidate } from "@forexplore/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdaptationMcpServer } from "./translation-mcp-server";

const projectRoot = fileURLToPath(
  new URL("../../../fixtures/target-system/forexplore-csharp-workspace", import.meta.url),
);

const target = {
  id: "get-quote-async-function",
  name: "GetQuoteAsync",
  kind: "function" as const,
  path: "src/Application/QuoteOrchestrationService.cs",
  language: "C#" as const,
  signature: "Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)",
  documentation: "Gets a quote through cache and provider fallback.",
  line: 24,
};

const candidate: SearchCandidate = {
  id: "java-candidate",
  title: "route",
  repository: "fixture/java",
  license: "Apache-2.0",
  language: "Java",
  kind: "function",
  path: "src/QuoteRouter.java",
  signature: "public Quote route(QuoteRequest request)",
  summary: "Routes a quote request.",
  score: { overall: 0.9, semantic: 0.9, symbol: 0.8, contract: 0.7 },
  preview: "public Quote route(QuoteRequest request) { return provider.fetch(request); }",
  dependencies: ["ProviderClient"],
  compatibility: [],
  risks: [],
};

const requirement = "Preserve the asynchronous quote fallback contract.";
const analysisReport: AnalysisReport = {
  schemaVersion: "1.0",
  applicability: {
    level: "adapt",
    confidence: 0.86,
    reasons: ["The candidate behavior maps to the target contract with async adaptation."],
  },
  behaviorMapping: [{
    requirement,
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

const generatedCode = `public async ${target.signature}\n{\n    throw new NotImplementedException();\n}`;

const transports: Array<InMemoryTransport> = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

async function connectedClient() {
  const analyzer = { analyze: vi.fn(async () => analysisReport) };
  const translatorRequest = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      schemaVersion: "1.0",
      generatedCode,
      interfaceMappings: analysisReport.contractMapping,
      completedSteps: analysisReport.implementationPlan,
      unresolved: [],
    }) } }],
  }), { status: 200 })) as unknown as typeof globalThis.fetch;
  const validator = {
    compileStandalone: () => ({ success: false, errors: [".NET SDK not installed."], output: "" }),
    compileIntegrated: () => ({ success: false, errors: [".NET SDK not installed."], output: "" }),
    isUnavailable: () => true,
  };
  const server = createAdaptationMcpServer({
    apiKey: "test-key",
    projectRoot,
    analyzer,
    translatorRequest,
    validator,
  });
  const client = new Client({ name: "forexplore-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  transports.push(clientTransport, serverTransport);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { analyzer, client };
}

function contentText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("Expected an MCP tool result.");
  }
  const text = result.content.find(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item.type === "text" && typeof item.text === "string",
  );
  if (!text || typeof text.text !== "string") throw new Error("Expected a text tool result.");
  return text.text;
}

function isToolError(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("ForeXplore adaptation MCP server", () => {
  it("lists the guarded translation tool set", async () => {
    const { client } = await connectedClient();

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "forexplore_collect_target_context",
      "forexplore_analyze_translation",
      "forexplore_validate_rerank",
      "forexplore_generate_translation",
      "forexplore_repair_translation",
      "forexplore_validate_translation",
      "forexplore_adapt_translation",
    ]);
    expect(tools.tools.map((tool) => tool.name)).not.toContain("forexplore_apply_patch");
  });

  it("collects bounded target context and runs the full adaptation workflow", async () => {
    const { analyzer, client } = await connectedClient();

    const contextResult = await client.callTool({
      name: "forexplore_collect_target_context",
      arguments: { target },
    });
    const context = JSON.parse(contentText(contextResult)) as { target: { name: string } };
    expect(context.target.name).toBe("GetQuoteAsync");

    const adaptationResult = await client.callTool({
      name: "forexplore_adapt_translation",
      arguments: { target, candidate, requirement, decisionNotes: "" },
    });
    const adaptation = JSON.parse(contentText(adaptationResult)) as {
      generatedCode: string;
      files: unknown[];
    };
    expect(isToolError(adaptationResult)).toBe(false);
    expect(adaptation.generatedCode).toBe(generatedCode);
    expect(adaptation.files).toHaveLength(1);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
  });

  it("returns an MCP tool error for a target path outside the configured project root", async () => {
    const { client } = await connectedClient();

    const result = await client.callTool({
      name: "forexplore_collect_target_context",
      arguments: { target: { ...target, path: "../package.json" } },
    });

    expect(isToolError(result)).toBe(true);
    expect(contentText(result)).toContain("Target path must stay inside the project root");
  });

  it("validates reranking candidate IDs through the MCP tool", async () => {
    const { client } = await connectedClient();
    const result = await client.callTool({
      name: "forexplore_validate_rerank",
      arguments: {
        candidateIds: ["first", "second"],
        results: [
          { id: "first", score: 0.9 },
          { id: "invented", score: 0.8 },
        ],
      },
    });

    expect(isToolError(result)).toBe(false);
    expect(JSON.parse(contentText(result))).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.stringContaining("unknown candidate ID: invented"),
        expect.stringContaining("Missing candidate IDs"),
      ]),
    });
  });
});
