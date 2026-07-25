import type { AddressInfo } from "node:net";
import type {
  AdaptationRequest,
  AdaptationResult,
  ApplyResult,
  FilePatch,
  SearchCandidate,
} from "@forexplore/contracts";
import type { CodeAdaptationPort, CodeBackfillPort } from "@forexplore/workflow-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "./http-server";

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function listen(
  adapter: CodeAdaptationPort,
  backfill: CodeBackfillPort,
): Promise<string> {
  const server = createHttpServer({
    adapter,
    backfill,
    corsOrigin: "http://localhost:4173",
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

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

const adaptationRequest: AdaptationRequest = {
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

const adaptationResult: AdaptationResult = {
  strategy: "translate",
  targetLanguage: "C#",
  generatedCode: "public decimal Calculate() { return 1.0m; }",
  interfaceMappings: [],
  validation: [{ label: "compile", status: "pass", detail: "OK" }],
  files: [
    {
      path: "src/Calculator.cs",
      status: "modified",
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [
            { type: "remove", content: "throw new NotImplementedException();" },
            { type: "add", content: "return 1.0m;" },
          ],
        },
      ],
    },
  ],
};

describe("adaptation HTTP API", () => {
  it("serves health check", async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const backfill: CodeBackfillPort = { apply: vi.fn() };
    const url = await listen(adapter, backfill);

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", provider: "deepseek" });
  });

  it("routes adaptation requests to the adapter", async () => {
    const adapter: CodeAdaptationPort = {
      adapt: vi.fn(async () => adaptationResult),
    };
    const backfill: CodeBackfillPort = { apply: vi.fn() };
    const url = await listen(adapter, backfill);

    const response = await fetch(`${url}/v1/adapt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adaptationRequest),
    });

    expect(response.status).toBe(200);
    expect(adapter.adapt).toHaveBeenCalledWith(
      adaptationRequest,
      expect.any(AbortSignal),
    );
    expect(await response.json()).toEqual(adaptationResult);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:4173",
    );
  });

  it("routes backfill requests to the backfill adapter", async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const applyResult: ApplyResult = {
      appliedFiles: ["src/Calculator.cs"],
      checkpointId: "checkpoint-abc",
    };
    const backfill: CodeBackfillPort = {
      apply: vi.fn(async () => applyResult),
    };
    const url = await listen(adapter, backfill);

    const files: FilePatch[] = [
      {
        path: "src/Calculator.cs",
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [],
      },
    ];

    const response = await fetch(`${url}/v1/backfill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(files),
    });

    expect(response.status).toBe(200);
    expect(backfill.apply).toHaveBeenCalledWith(files, expect.any(AbortSignal));
    expect(await response.json()).toEqual(applyResult);
  });

  it("rejects malformed adaptation requests", async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const backfill: CodeBackfillPort = { apply: vi.fn() };
    const url = await listen(adapter, backfill);

    const response = await fetch(`${url}/v1/adapt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: "translate" }),
    });

    expect(response.status).toBe(400);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it("rejects invalid backfill payloads", async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const backfill: CodeBackfillPort = { apply: vi.fn() };
    const url = await listen(adapter, backfill);

    const response = await fetch(`${url}/v1/backfill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "an array" }),
    });

    expect(response.status).toBe(400);
    expect(backfill.apply).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON bodies", async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const backfill: CodeBackfillPort = { apply: vi.fn() };
    const url = await listen(adapter, backfill);

    const response = await fetch(`${url}/v1/adapt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body must be valid JSON.",
    });
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies", async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const backfill: CodeBackfillPort = { apply: vi.fn() };
    const url = await listen(adapter, backfill);

    const response = await fetch(`${url}/v1/adapt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.alloc(2 * 1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown routes", async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const backfill: CodeBackfillPort = { apply: vi.fn() };
    const url = await listen(adapter, backfill);

    const response = await fetch(`${url}/unknown`);
    expect(response.status).toBe(404);
  });

  it("handles OPTIONS preflight requests", async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const backfill: CodeBackfillPort = { apply: vi.fn() };
    const url = await listen(adapter, backfill);

    const response = await fetch(`${url}/v1/adapt`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
  });

  it("returns 502 when the upstream adapter throws an unexpected error", async () => {
    const adapter: CodeAdaptationPort = {
      adapt: vi.fn(async () => {
        throw new Error("DeepSeek API timeout");
      }),
    };
    const backfill: CodeBackfillPort = { apply: vi.fn() };
    const url = await listen(adapter, backfill);

    const response = await fetch(`${url}/v1/adapt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adaptationRequest),
    });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("DeepSeek API timeout");
  });
});
