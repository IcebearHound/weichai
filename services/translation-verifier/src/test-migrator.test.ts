import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMigrationPrompt,
  MIGRATOR_SYSTEM_PROMPT,
  TestMigratorAgent,
  type MigrationInput,
} from "./test-migrator.js";
import type { SpawnClaude } from "./claude-client.js";

// ---- 测试辅助 ----

type FakeSpawn = SpawnClaude & ReturnType<typeof vi.fn>;

/** 预设 stdout/exitCode 的 fake spawnClaude(claude 子进程注入,不触网)。 */
function fakeSpawn(stdout: string, exitCode = 0, stderr = ""): FakeSpawn {
  const mock = vi.fn(async () => ({ stdout, exitCode, stderr }));
  return mock as unknown as FakeSpawn;
}

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

beforeEach(() => {
  // 默认值确定性:不依赖宿主环境 DEEPSEEK_* 变量。
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_MODEL;
});

// ---- 测试 ----

describe("TestMigratorAgent.extractDescription", () => {
  it("returns the parsed description when the fake claude subprocess returns valid TestDescription JSON", async () => {
    const spawnClaude = fakeSpawn(validDescriptionJson());
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

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
    expect(spawnClaude).toHaveBeenCalledTimes(1);
  });

  it("spawns claude -p with (system prompt + buildMigrationPrompt 输出) 且 env 指向 DeepSeek Anthropic 端点", async () => {
    const spawnClaude = fakeSpawn(validDescriptionJson());
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    await agent.extractDescription(sampleInput());

    expect(spawnClaude).toHaveBeenCalledTimes(1);
    const call = spawnClaude.mock.calls[0];
    const args = call?.[0] as string[];
    const env = call?.[1] as NodeJS.ProcessEnv;
    // args 形态:claude -p <prompt> --output-format text
    expect(args[0]).toBe("-p");
    expect(args[2]).toBe("--output-format");
    expect(args[3]).toBe("text");
    // prompt = MIGRATOR_SYSTEM_PROMPT + 空行 + buildMigrationPrompt 输出
    const prompt = args[1] as string;
    expect(prompt).toBe(`${MIGRATOR_SYSTEM_PROMPT}\n\n${buildMigrationPrompt(sampleInput())}`);
    // system 段提示输出 schema
    expect(prompt).toContain('"schemaVersion": "1.0"');
    expect(prompt).toContain('"cases"');
    // env:DeepSeek Anthropic 兼容端点 + auth token + 模型
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
  });

  it("throws when the model returns invalid JSON", async () => {
    const spawnClaude = fakeSpawn("this is definitely not json {");
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(
      /TestMigratorAgent failed to produce a valid test description/,
    );
  });

  it("throws when the JSON parses but fails schema validation (wrong schemaVersion)", async () => {
    const spawnClaude = fakeSpawn(
      JSON.stringify({
        schemaVersion: "2.0",
        target: { language: "Java", className: "MimeUtil", method: "decodeText", isStatic: true, constructorArgs: [] },
        cases: [],
      }),
    );
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(/schemaVersion must be "1.0"/);
  });

  it("retries when the first response is invalid and the second is valid", async () => {
    const spawnClaude = fakeSpawn("bad json");
    spawnClaude.mockResolvedValueOnce({ stdout: "bad json", exitCode: 0 });
    spawnClaude.mockResolvedValueOnce({ stdout: validDescriptionJson(), exitCode: 0 });
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    const result = await agent.extractDescription(sampleInput());

    expect(result.cases).toHaveLength(3);
    expect(spawnClaude).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 consecutive failures (retries <= 2)", async () => {
    const spawnClaude = fakeSpawn("bad json");
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(
      /TestMigratorAgent failed to produce a valid test description/,
    );
    expect(spawnClaude).toHaveBeenCalledTimes(3);
  });

  it("throws without spawning claude when no apiKey is provided", async () => {
    const spawnClaude = fakeSpawn(validDescriptionJson());
    const agent = new TestMigratorAgent({ apiKey: "   ", spawnClaude });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(/DEEPSEEK_API_KEY is required/);
    expect(spawnClaude).not.toHaveBeenCalled();
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
