import type {
  AdaptationRequest,
  SearchCandidate,
  TargetModuleContext,
} from "@forexplore/contracts";
import { describe, expect, it } from "vitest";
import {
  TranslationVerifierAdapter,
  type DifferentialVerificationInput,
  type IsolatedDriverExecutor,
} from "./verification-adapter";

const candidate: SearchCandidate = {
  id: "candidate",
  title: "calculate",
  repository: "fixture/source",
  license: "Apache-2.0",
  language: "Java",
  kind: "function",
  path: "src/Calculator.java",
  signature: "public static int calculate()",
  summary: "fixture",
  preview: "public static int calculate() { return 1; }",
  score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
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
    signature: "public static int Calculate()",
    line: 1,
  },
  candidate,
  requirement: "Keep the arithmetic result.",
  strategy: "translate",
  decisionNotes: "",
};

const targetContext: TargetModuleContext = {
  schemaVersion: "1.0",
  target: request.target,
  source: {
    namespace: "Fixture",
    usings: [],
    method: "public static int Calculate() => 0;",
    containingType: "public static class Calculator { }",
    fields: [],
    constructor: undefined,
    relatedMembers: [],
  },
  dependencies: [],
  relatedTypes: [],
  callers: [],
  constraints: [],
  collection: {
    projectRoot: ".",
    targetFile: request.target.path,
    maxChars: 1,
    actualChars: 1,
    truncated: false,
    truncatedSections: [],
  },
};

const input: DifferentialVerificationInput = {
  request,
  targetContext,
  generatedCode: "public static int Calculate() => 1;",
  projectRoot: ".",
};

const isolatedExecutor: IsolatedDriverExecutor = {
  isolation: {
    processBoundary: "external",
    network: "disabled",
    hostCredentials: "unavailable",
    hostWorkspace: "unmounted",
  },
  async compile() {
    return { success: true, errors: [], output: "" };
  },
  async run() {
    return { exitCode: 0, stdout: '{"results":[]}', stderr: "" };
  },
};

describe("TranslationVerifierAdapter execution boundary", () => {
  it("fails closed by default without inspecting or executing candidate preview", async () => {
    const adapter = new TranslationVerifierAdapter({ apiKey: "test-key" });

    const result = await adapter.verify(input);

    expect(result).toMatchObject({
      status: "unverified",
      reason: "verifier-unavailable",
    });
    expect(result.summary).toContain("未运行候选或生成代码");
  });

  it("requires an explicit, attestable isolated executor for execution", () => {
    expect(() => new TranslationVerifierAdapter({
      apiKey: "test-key",
      execution: "trusted-isolated",
    })).toThrow(/external, credential-free, network-disabled workspace boundary/);

    expect(() => new TranslationVerifierAdapter({
      apiKey: "test-key",
      execution: "trusted-isolated",
      executor: isolatedExecutor,
    })).not.toThrow();

    expect(() => new TranslationVerifierAdapter({
      apiKey: "test-key",
      executor: isolatedExecutor,
    })).toThrow(/execution is disabled/);
  });

  it("rejects a runtime executor that only claims the TypeScript shape", () => {
    const malformedExecutor = {
      async compile() { return { success: true, errors: [], output: "" }; },
      async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
    } as unknown as IsolatedDriverExecutor;

    expect(() => new TranslationVerifierAdapter({
      apiKey: "test-key",
      execution: "trusted-isolated",
      executor: malformedExecutor,
    })).toThrow(/external, credential-free, network-disabled workspace boundary/);
  });
});
