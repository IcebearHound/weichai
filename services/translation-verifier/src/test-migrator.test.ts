import { describe, expect, it, vi } from "vitest";
import { deepSeekModelConfig } from "@forexplore/adaptation-service";
import {
  buildMigrationPrompt,
  MIGRATOR_SYSTEM_PROMPT,
  TestMigratorAgent,
  type MigrationInput,
} from "./test-migrator.js";

// ---- 测试辅助 ----

function validDescriptionJson(): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    target: {
      language: "Java",
      className: "MimeUtil",
      method: "decodeText",
      isStatic: true,
      constructorArgs: [],
    },
    cases: [
      {
        id: "c1",
        description: "nominal: plain text passes through",
        inputs: [{ type: "string", value: "abc" }],
        expected: { kind: "return", value: { type: "string", value: "abc" } },
      },
      {
        id: "c2",
        description: "encoded text decodes",
        inputs: [{ type: "string", value: "=?UTF-8?B?aGVsbG8=?=" }],
        expected: { kind: "return", value: { type: "string", value: "hello" } },
      },
      {
        id: "c3",
        description: "invalid input throws",
        inputs: [],
        expected: { kind: "exception", type: "IllegalArgumentException", messageContains: "invalid" },
      },
    ],
  });
}

function sampleInput(): MigrationInput {
  return {
    sourceLanguage: "C#",
    sourceCode: "public static string DecodeText(string value) { return value; }",
    existingTests: '// C# tests\nAssert.AreEqual("abc", DecodeText("abc"));',
    requirement: "解码 MIME 编码文本(如 =?UTF-8?B?...?=),非编码文本原样返回",
    repository: "commons-fileupload-csharp",
    sourcePath: "src/Util/MimeUtil.cs",
    target: {
      language: "Java" as const,
      className: "MimeUtil",
      method: "decodeText",
      isStatic: true,
    },
  };
}

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function mockFetch(content: string): ReturnType<typeof vi.fn> {
  return vi.fn(async () => okResponse(content));
}

// ---- 测试 ----

describe("TestMigratorAgent.extractDescription", () => {
  it("returns the parsed description when the fake fetch returns valid TestDescription JSON", async () => {
    const request = mockFetch(validDescriptionJson());
    const agent = new TestMigratorAgent({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });

    const result = await agent.extractDescription(sampleInput());

    expect(result.schemaVersion).toBe("1.0");
    expect(result.target).toEqual({
      language: "Java",
      className: "MimeUtil",
      method: "decodeText",
      isStatic: true,
      constructorArgs: [],
    });
    expect(result.cases).toHaveLength(3);
    expect(result.cases[1]?.inputs[0]).toEqual({ type: "string", value: "=?UTF-8?B?aGVsbG8=?=" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("posts a json_object response_format request whose system message hints the schema", async () => {
    const request = mockFetch(validDescriptionJson());
    const agent = new TestMigratorAgent({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });

    await agent.extractDescription(sampleInput());

    expect(request).toHaveBeenCalledWith(
      `${deepSeekModelConfig.apiBase}/chat/completions`,
      expect.objectContaining({ method: "POST" }),
    );
    const init = request.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      response_format: { type: string };
      thinking: { type: string };
    };
    expect(body.model).toBe(deepSeekModelConfig.model);
    expect(body.temperature).toBe(0.1);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe("system");
    // system 消息提示输出 schema
    expect(body.messages[0]?.content).toContain('"schemaVersion": "1.0"');
    expect(body.messages[0]?.content).toContain('"cases"');
    // user 消息 = buildMigrationPrompt 的输出
    expect(body.messages[1]?.content).toBe(buildMigrationPrompt(sampleInput()));
  });

  it("throws when the model returns invalid JSON", async () => {
    const request = mockFetch("this is definitely not json {");
    const agent = new TestMigratorAgent({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(
      /TestMigratorAgent failed to produce a valid test description/,
    );
  });

  it("throws when the JSON parses but fails schema validation (wrong schemaVersion)", async () => {
    const request = mockFetch(
      JSON.stringify({
        schemaVersion: "2.0",
        target: { language: "Java", className: "MimeUtil", method: "decodeText", isStatic: true, constructorArgs: [] },
        cases: [],
      }),
    );
    const agent = new TestMigratorAgent({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(/schemaVersion must be "1.0"/);
  });

  it("retries when the first response is invalid and the second is valid", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(okResponse("bad json"))
      .mockResolvedValueOnce(okResponse(validDescriptionJson()));
    const agent = new TestMigratorAgent({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });

    const result = await agent.extractDescription(sampleInput());

    expect(result.cases).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 consecutive failures (retries <= 2)", async () => {
    const request = mockFetch("bad json");
    const agent = new TestMigratorAgent({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(
      /TestMigratorAgent failed to produce a valid test description/,
    );
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("throws without calling fetch when no apiKey is provided", async () => {
    const request = mockFetch(validDescriptionJson());
    const agent = new TestMigratorAgent({ apiKey: "   ", request: request as unknown as typeof globalThis.fetch });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(/DEEPSEEK_API_KEY is required/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("buildMigrationPrompt(需求第一)", () => {
  it("places the REQUIREMENT section first and marks the source as a reference implementation", () => {
    const input = sampleInput();
    const prompt = buildMigrationPrompt(input);

    // 段序最前:第一个 section 是 REQUIREMENT
    const sections = prompt.split("\n\n");
    expect(sections[0]).toBe(`REQUIREMENT\n${input.requirement}`);
    expect(prompt.startsWith("REQUIREMENT\n")).toBe(true);
    expect(prompt.indexOf("REQUIREMENT")).toBeLessThan(prompt.indexOf("REFERENCE_IMPLEMENTATION"));
    // 源码段标记为参考
    expect(prompt).toContain("REFERENCE_IMPLEMENTATION");
    // REFERENCE_IMPLEMENTATION 段携带元数据与目标契约
    expect(prompt).toContain(`Source language: ${input.sourceLanguage}`);
    expect(prompt).toContain(`Repository: ${input.repository}`);
    expect(prompt).toContain(`Path: ${input.sourcePath}`);
    expect(prompt).toContain("Target contract:");
    expect(prompt).toContain(`- language: ${input.target.language}`);
    expect(prompt).toContain(`- className: ${input.target.className}`);
    expect(prompt).toContain(`- method: ${input.target.method}`);
    expect(prompt).toContain(`- isStatic: ${input.target.isStatic}`);
    // 源码与既有测试段
    expect(prompt).toContain("SOURCE_METHOD");
    expect(prompt).toContain(input.sourceCode);
    expect(prompt).toContain("EXISTING_TESTS");
    expect(prompt).toContain(input.existingTests as string);
  });

  it("omits repository/path metadata lines when not provided", () => {
    const prompt = buildMigrationPrompt({ ...sampleInput(), repository: undefined, sourcePath: undefined });

    expect(prompt).not.toContain("Repository:");
    expect(prompt).not.toContain("Path:");
    expect(prompt).toContain("REFERENCE_IMPLEMENTATION");
  });

  it("omits the EXISTING_TESTS section when no tests are provided", () => {
    const prompt = buildMigrationPrompt({ ...sampleInput(), existingTests: undefined });

    expect(prompt).not.toContain("EXISTING_TESTS");
  });

  it("requires requirement at the type level (必填)", () => {
    const base = {
      sourceLanguage: "C#",
      sourceCode: "x",
      target: { language: "Java" as const, className: "A", method: "b", isStatic: true },
    };
    // @ts-expect-error MigrationInput.requirement 是必填字段
    const bad: MigrationInput = base;
    expect(bad).toBeDefined();
  });
});

describe("MIGRATOR_SYSTEM_PROMPT(需求第一规则)", () => {
  it("declares the requirement as highest priority and forbids inheriting defects", () => {
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/highest priority/i);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/do not inherit/i);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/conflict/i);
  });

  it("does not contain the old rule 'do not invent behavior not present in the source'", () => {
    expect(MIGRATOR_SYSTEM_PROMPT).not.toContain("do not invent behavior not present in the source");
  });
});
