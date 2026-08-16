import { beforeEach, describe, expect, it, vi } from "vitest";
import { runClaude, type SpawnClaude } from "./claude-client.js";

// ---- 测试辅助 ----

type FakeSpawn = SpawnClaude & ReturnType<typeof vi.fn>;

/** 预设 stdout/exitCode/stderr 的 fake spawnClaude(fake 可额外携带 stderr 字段供错误断言)。 */
function fakeSpawn(stdout: string, exitCode = 0, stderr = ""): FakeSpawn {
  const mock = vi.fn(async () => ({ stdout, exitCode, stderr }));
  return mock as unknown as FakeSpawn;
}

/** 断言 runClaude 调用 spawnClaude 时的 args/env/timeout 三要素。 */
function lastCall(spawnClaude: FakeSpawn): { args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number } {
  const call = spawnClaude.mock.calls.at(-1);
  if (!call) throw new Error("spawnClaude was never called");
  return { args: call[0] as string[], env: call[1] as NodeJS.ProcessEnv, timeoutMs: call[2] as number };
}

beforeEach(() => {
  // 保证默认值测试确定性:不依赖宿主环境是否设置了 DEEPSEEK_* 变量。
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_API_KEY;
});

// ---- 测试 ----

describe("runClaude", () => {
  it("① 返回 claude 子进程的 stdout 原样", async () => {
    const spawnClaude = fakeSpawn('{"schemaVersion":"1.0"}');

    const out = await runClaude("hello", { apiKey: "test-key", spawnClaude });

    expect(out).toBe('{"schemaVersion":"1.0"}');
  });

  it("② spawn claude 的 args 含 -p / --output-format / text 与完整 prompt", async () => {
    const spawnClaude = fakeSpawn("ok");
    const prompt = `system prompt\n\nREQUIREMENT
decode MIME text`;

    await runClaude(prompt, { apiKey: "test-key", spawnClaude });

    expect(spawnClaude).toHaveBeenCalledTimes(1);
    expect(spawnClaude).toHaveBeenCalledWith(
      ["-p", prompt, "--output-format", "text"],
      expect.any(Object),
      expect.any(Number),
    );
    const { args } = lastCall(spawnClaude);
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe(prompt);
    expect(args[2]).toBe("--output-format");
    expect(args[3]).toBe("text");
  });

  it("③ env 含 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL(及各默认模型别名)正确值", async () => {
    const spawnClaude = fakeSpawn("ok");

    await runClaude("p", { apiKey: "sk-test", model: "deepseek-v4-flash", spawnClaude });

    const { env } = lastCall(spawnClaude);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-flash");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek-v4-flash");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-flash");
  });

  it("③b 未传 model 时默认 deepseek-v4-flash;未传 timeoutMs 时默认 120_000", async () => {
    const spawnClaude = fakeSpawn("ok");

    await runClaude("p", { apiKey: "test-key", spawnClaude });

    const { env, timeoutMs } = lastCall(spawnClaude);
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
    expect(timeoutMs).toBe(120_000);
  });

  it("③c 显式 timeoutMs 透传给 spawnClaude", async () => {
    const spawnClaude = fakeSpawn("ok");

    await runClaude("p", { apiKey: "test-key", spawnClaude, timeoutMs: 5_000 });

    const { timeoutMs } = lastCall(spawnClaude);
    expect(timeoutMs).toBe(5_000);
  });

  it("④ exitCode ≠ 0 → 抛错且错误含 stderr", async () => {
    const spawnClaude = fakeSpawn("", 1, "claude: error: invalid model config");

    await expect(runClaude("p", { apiKey: "test-key", spawnClaude })).rejects.toThrow(
      /claude: error: invalid model config/,
    );
  });

  it("⑤ 无 apiKey(缺省且环境未设)→ 抛错且 spawnClaude 未被调用", async () => {
    const spawnClaude = fakeSpawn("ok");

    await expect(runClaude("p", { spawnClaude })).rejects.toThrow(
      /DEEPSEEK_API_KEY is required for claude subprocess requests/,
    );
    expect(spawnClaude).not.toHaveBeenCalled();
  });

  it("⑤b 空/空白 apiKey → 抛错且 spawnClaude 未被调用", async () => {
    const spawnClaude = fakeSpawn("ok");

    await expect(runClaude("p", { apiKey: "   ", spawnClaude })).rejects.toThrow(
      /DEEPSEEK_API_KEY is required for claude subprocess requests/,
    );
    expect(spawnClaude).not.toHaveBeenCalled();
  });

  it("⑥ spawnClaude 抛错(超时)→ runClaude 传播该错误", async () => {
    const spawnClaude = vi.fn(async () => {
      throw new Error("claude subprocess timed out after 120000ms");
    }) as unknown as FakeSpawn;

    await expect(runClaude("p", { apiKey: "test-key", spawnClaude })).rejects.toThrow(/timed out after 120000ms/);
  });
});
