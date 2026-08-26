import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnClaude } from "../claude-client.js";
import { validateDescription } from "../description.js";
import { FakeDriverExecutor } from "../executor.js";
import type { MigrationInput } from "../test-migrator.js";
import { MitGenMigratorAgent, MITGEN_SYSTEM_PROMPT } from "./mitgen-migrator.js";

// ---- 测试辅助 ----

type FakeSpawn = SpawnClaude & ReturnType<typeof vi.fn>;

/** 队列式 fake spawnClaude:按序弹出预设 stdout;耗尽时抛错(防止静默吞调用)。 */
function fakeSpawnQueue(responses: string[]): FakeSpawn {
  const mock = vi.fn(async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected claude subprocess call (queue exhausted)");
    return { stdout: next, exitCode: 0 };
  });
  return mock as unknown as FakeSpawn;
}

const SCORING_RESPONSE = `{
  "scores": [
    { "fragmentId": "frag-01", "llmRiskScore": 0.95, "llmFixabilityScore": 0.8, "rationale": "guard 边界" },
    { "fragmentId": "frag-02", "llmRiskScore": 0.95, "llmFixabilityScore": 0.8, "rationale": "guard 边界" },
    { "fragmentId": "frag-03", "llmRiskScore": 0.2, "llmFixabilityScore": 0.5, "rationale": "普通赋值" },
    { "fragmentId": "frag-04", "llmRiskScore": 0.2, "llmFixabilityScore": 0.5, "rationale": "循环头" },
    { "fragmentId": "frag-05", "llmRiskScore": 0.2, "llmFixabilityScore": 0.5, "rationale": "循环体" },
    { "fragmentId": "frag-06", "llmRiskScore": 0.2, "llmFixabilityScore": 0.5, "rationale": "return" }
  ]
}`;

const INPUT_GEN_RESPONSE = `{
  "cases": [
    { "description": "负值触发守卫", "inputs": [ { "type": "number", "value": -5 } ] }
  ]
}`;

const CORRESPONDENCE_RESPONSE = `{
  "correspondences": [
    { "fragmentId": "frag-01", "correspondence": "equivalent", "note": "目标侧存在等价守卫" },
    { "fragmentId": "frag-02", "correspondence": "equivalent", "note": "目标侧存在等价守卫" }
  ]
}`;

/** C# 源方法:2 guard + 赋值 + 循环 + return,片段顺序固定。 */
const SOURCE_CODE = `public static int ClampScore(int value, int max) {
  if (value < 0) return 0;
  if (value > max) return max;
  int total = value;
  for (int i = 0; i < value; i++) total += i;
  return total;
}`;

const TARGET_CODE = `public class ClampScore {
  public static int ClampScore(int value, int max) {
    if (value < 0) return 0;
    if (value > max) return max;
    int total = value;
    for (int i = 0; i < value; i++) total += i;
    return total;
  }
}`;

function sampleInput(): MigrationInput {
  return {
    sourceLanguage: "C#",
    sourceCode: SOURCE_CODE,
    requirement: "按边界裁剪分数:负数归零、超过上限封顶",
    repository: "demo-repo",
    sourcePath: "src/demo/Clamp.cs",
    targetCode: TARGET_CODE,
    target: { language: "Java", className: "ClampScore", method: "clampScore", isStatic: true },
  };
}

/** 可注入的 run 行为:每片段前 callLimit 次调用不带 marker(模拟不可达),之后带 marker。 */
function fakeExecutor(options: { missesBeforeReach?: number; alwaysMiss?: string[] } = {}): FakeDriverExecutor {
  const counts = new Map<string, number>();
  const missesBeforeReach = options.missesBeforeReach ?? 0;
  return new FakeDriverExecutor({
    compileResults: { success: true, errors: [], output: "" },
    runResults: (side) => {
      const instrumented = side.sourceFiles[0]?.content ?? "";
      const match = /\[MARK\](frag-\d+)/.exec(instrumented);
      const fragmentId = match?.[1] ?? "unknown";
      const attempt = counts.get(fragmentId) ?? 0;
      counts.set(fragmentId, attempt + 1);
      const reached = !(options.alwaysMiss?.includes(fragmentId) ?? false) && attempt >= missesBeforeReach;
      const results = JSON.stringify({
        results: [
          { caseId: "probe", outcome: "return", returnValue: { type: "number", value: fragmentId === "frag-01" ? 0 : 42 } },
        ],
      });
      return {
        exitCode: 0,
        stdout: `${reached ? `[MARK]${fragmentId}\n` : ""}${results}\n`,
        stderr: "",
      };
    },
  });
}

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_MODEL;
});

// ---- 测试 ----

describe("MitGenMigratorAgent.generate(正常路径)", () => {
  it("runs the full pipeline and produces a schema-valid description with recorded expected", async () => {
    const spawnClaude = fakeSpawnQueue([
      SCORING_RESPONSE,
      INPUT_GEN_RESPONSE,
      INPUT_GEN_RESPONSE,
      CORRESPONDENCE_RESPONSE,
    ]);
    const agent = new MitGenMigratorAgent({
      apiKey: "test-key",
      spawnClaude,
      casesPerFragment: 1,
      maxFragments: 2,
    });

    const result = await agent.generate(sampleInput(), fakeExecutor());

    // 描述通过 schema 校验。
    expect(() => validateDescription(result.description)).not.toThrow();
    expect(result.description.requirement).toBe(sampleInput().requirement);
    expect(result.description.target).toMatchObject({
      language: "Java",
      className: "ClampScore",
      method: "clampScore",
      isStatic: true,
    });
    // 选中 2 个片段(frag-01/frag-02 风险最高),每个 1 个可达 case。
    expect(result.fragments).toHaveLength(2);
    expect(result.fragments.map((f) => f.fragmentId)).toEqual(["frag-01", "frag-02"]);
    expect(result.description.cases).toHaveLength(2);
    expect(result.description.cases[0]?.id).toBe("frag-01-1");
    expect(result.description.cases[1]?.id).toBe("frag-02-1");
    // expected 来自源侧实跑录制(不是 LLM 生成)。
    expect(result.description.cases[0]?.expected).toEqual({
      kind: "return",
      value: { type: "number", value: 0 },
    });
    // 片段报告:correspondence 来自目标侧检查。
    expect(result.fragments[0]?.correspondence).toBe("equivalent");
    expect(result.fragments[0]?.correspondenceNote).toContain("等价守卫");
    expect(result.fragments[0]?.reachability).toBe("verified");
    expect(result.fragments[0]?.sourceCode).toContain("return 0");
  });

  it("spawns claude with (system prompt + builder prompt) per phase and DeepSeek env", async () => {
    const spawnClaude = fakeSpawnQueue([
      SCORING_RESPONSE,
      INPUT_GEN_RESPONSE,
      INPUT_GEN_RESPONSE,
      CORRESPONDENCE_RESPONSE,
    ]);
    const agent = new MitGenMigratorAgent({
      apiKey: "test-key",
      spawnClaude,
      casesPerFragment: 1,
      maxFragments: 2,
    });

    await agent.generate(sampleInput(), fakeExecutor());

    // LLM 调用次数 = 1 打分 + 2 输入生成 + 1 correspondence。
    expect(spawnClaude).toHaveBeenCalledTimes(4);
    const first = spawnClaude.mock.calls[0];
    const args = first?.[0] as string[];
    const env = first?.[1] as NodeJS.ProcessEnv;
    expect(args[0]).toBe("-p");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
    const prompt = args[1] as string;
    expect(prompt.startsWith(MITGEN_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain("CANDIDATE_FRAGMENTS");
    // 输入生成 prompt 包含 pathCondition。
    const inputGenPrompt = spawnClaude.mock.calls[1]?.[0]?.[1] as string;
    expect(inputGenPrompt).toContain("pathCondition: value < 0");
    expect(inputGenPrompt).toContain("MUST satisfy the pathCondition");
  });

  it("executes one instrumented source run per (fragment, candidate)", async () => {
    const spawnClaude = fakeSpawnQueue([
      SCORING_RESPONSE,
      INPUT_GEN_RESPONSE,
      INPUT_GEN_RESPONSE,
      CORRESPONDENCE_RESPONSE,
    ]);
    const executor = fakeExecutor();
    const agent = new MitGenMigratorAgent({
      apiKey: "test-key",
      spawnClaude,
      casesPerFragment: 1,
      maxFragments: 2,
    });

    await agent.generate(sampleInput(), executor);

    // 每个选中片段 1 次 run,共 2 次;每次的 driver 是 C# 源侧驱动。
    expect(executor.runCalls).toHaveLength(2);
    for (const side of executor.runCalls) {
      expect(side.language).toBe("C#");
      expect(side.driverSource).toContain("public class Driver_");
      expect(side.sourceFiles[0]?.content).toContain("[MARK]");
    }
  });
});

describe("MitGenMigratorAgent.generate(可达性重试)", () => {
  it("retries once with feedback when inputs do not reach the fragment, then succeeds", async () => {
    const spawnClaude = fakeSpawnQueue([
      SCORING_RESPONSE,
      INPUT_GEN_RESPONSE, // frag-01 第一次输入
      INPUT_GEN_RESPONSE, // frag-01 重试输入
      INPUT_GEN_RESPONSE, // frag-02 输入
      INPUT_GEN_RESPONSE, // frag-02 重试输入
      CORRESPONDENCE_RESPONSE,
    ]);
    const executor = fakeExecutor({ missesBeforeReach: 1 }); // 每片段首次不可达
    const agent = new MitGenMigratorAgent({
      apiKey: "test-key",
      spawnClaude,
      casesPerFragment: 1,
      maxFragments: 2,
    });

    const result = await agent.generate(sampleInput(), executor);

    // 重试后全部可达:每个片段 1 个 case。
    expect(result.description.cases).toHaveLength(2);
    expect(result.fragments.every((f) => f.reachability === "verified")).toBe(true);
    // 每片段 2 次 run(首次失败 + 重试成功)。
    expect(executor.runCalls).toHaveLength(4);
    // 重试 prompt 带 FEEDBACK。
    const retryPrompt = spawnClaude.mock.calls[2]?.[0]?.[1] as string;
    expect(retryPrompt).toContain("FEEDBACK");
    expect(retryPrompt).toContain("did NOT reach the fragment");
  });

  it("drops cases that remain unreachable after retry (reachability failed)", async () => {
    const spawnClaude = fakeSpawnQueue([
      SCORING_RESPONSE,
      INPUT_GEN_RESPONSE, // frag-01 第一次输入
      INPUT_GEN_RESPONSE, // frag-01 重试输入(仍不可达)
      INPUT_GEN_RESPONSE, // frag-02 输入
      CORRESPONDENCE_RESPONSE,
    ]);
    const executor = fakeExecutor({ alwaysMiss: ["frag-01"] }); // frag-01 永远不可达
    const agent = new MitGenMigratorAgent({
      apiKey: "test-key",
      spawnClaude,
      casesPerFragment: 1,
      maxFragments: 2,
    });

    const result = await agent.generate(sampleInput(), executor);

    // frag-01 的 case 被丢弃;frag-02 保留。
    expect(result.description.cases).toHaveLength(1);
    expect(result.description.cases[0]?.id).toBe("frag-02-1");
    const frag01 = result.fragments.find((f) => f.fragmentId === "frag-01");
    expect(frag01?.reachability).toBe("failed");
    expect(frag01?.cases).toEqual([]);
  });
});

describe("MitGenMigratorAgent.generate(退化与错误路径)", () => {
  it("falls back to heuristic ordering when the scoring JSON cannot be parsed", async () => {
    const spawnClaude = fakeSpawnQueue([
      "not a json object at all",
      INPUT_GEN_RESPONSE,
      INPUT_GEN_RESPONSE,
      CORRESPONDENCE_RESPONSE,
    ]);
    const agent = new MitGenMigratorAgent({
      apiKey: "test-key",
      spawnClaude,
      casesPerFragment: 1,
      maxFragments: 2,
    });

    const result = await agent.generate(sampleInput(), fakeExecutor());

    expect(result.description.cases.length).toBeGreaterThan(0);
    expect(() => validateDescription(result.description)).not.toThrow();
  });

  it("throws without spawning claude when no apiKey is provided", async () => {
    const spawnClaude = fakeSpawnQueue([SCORING_RESPONSE]);
    const agent = new MitGenMigratorAgent({ apiKey: "   ", spawnClaude });

    await expect(agent.generate(sampleInput(), fakeExecutor())).rejects.toThrow(/DEEPSEEK_API_KEY is required/);
    expect(spawnClaude).not.toHaveBeenCalled();
  });

  it("throws when every fragment yields no verifiable cases", async () => {
    const spawnClaude = fakeSpawnQueue([
      SCORING_RESPONSE,
      INPUT_GEN_RESPONSE,
      INPUT_GEN_RESPONSE,
      CORRESPONDENCE_RESPONSE,
    ]);
    const executor = fakeExecutor({ alwaysMiss: ["frag-01", "frag-02"] });
    const agent = new MitGenMigratorAgent({
      apiKey: "test-key",
      spawnClaude,
      casesPerFragment: 1,
      maxFragments: 2,
    });

    await expect(agent.generate(sampleInput(), executor)).rejects.toThrow(/未产出可达用例/);
  });

  it("marks reachability skipped when verifyReachability is false but still records expected", async () => {
    const spawnClaude = fakeSpawnQueue([
      SCORING_RESPONSE,
      INPUT_GEN_RESPONSE,
      INPUT_GEN_RESPONSE,
      CORRESPONDENCE_RESPONSE,
    ]);
    const agent = new MitGenMigratorAgent({
      apiKey: "test-key",
      spawnClaude,
      casesPerFragment: 1,
      maxFragments: 2,
      verifyReachability: false,
    });

    const result = await agent.generate(sampleInput(), fakeExecutor());

    expect(result.fragments.every((f) => f.reachability === "skipped")).toBe(true);
    // expected 仍然来自源侧实跑。
    expect(result.description.cases).toHaveLength(2);
    expect(result.description.cases[0]?.expected).toEqual({
      kind: "return",
      value: { type: "number", value: 0 },
    });
  });

  it("records exception outcomes from the source run", async () => {
    const spawnClaude = fakeSpawnQueue([
      SCORING_RESPONSE,
      INPUT_GEN_RESPONSE,
      INPUT_GEN_RESPONSE,
      CORRESPONDENCE_RESPONSE,
    ]);
    const executor = new FakeDriverExecutor({
      compileResults: { success: true, errors: [], output: "" },
      runResults: {
        exitCode: 0,
        stdout: `[MARK]frag-01\n{"results":[{"caseId":"probe","outcome":"exception","exceptionType":"ArgumentException","exceptionMessage":"value is invalid"}]}\n`,
        stderr: "",
      },
    });
    const agent = new MitGenMigratorAgent({
      apiKey: "test-key",
      spawnClaude,
      casesPerFragment: 1,
      maxFragments: 2,
    });

    const result = await agent.generate(sampleInput(), executor);

    expect(result.description.cases[0]?.expected).toEqual({
      kind: "exception",
      type: "ArgumentException",
      messageContains: "value is invalid",
    });
  });
});
