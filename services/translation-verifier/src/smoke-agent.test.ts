import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClaude, type SpawnClaude } from "./claude-client.js";
import { FakeDriverExecutor } from "./executor.js";
import { createLogger } from "./logger.js";
import { assembleSmokeReport, SmokeAgent } from "./smoke-agent.js";
import type { SmokeAction, SmokeContextState } from "./smoke-types.js";

// ---- 测试辅助 ----

type FakeSpawn = SpawnClaude & ReturnType<typeof vi.fn>;

/** 预置按调用序号返回的 stdout 序列(fake LLM);args[1] 为完整 prompt,可断言。 */
function scriptedSpawn(responses: string[]): FakeSpawn {
  let index = 0;
  const mock = vi.fn(async () => ({ stdout: responses[index++] ?? "", exitCode: 0 }));
  return mock as unknown as FakeSpawn;
}

function actionJson(action: SmokeAction): string {
  return JSON.stringify(action);
}

function planAction(cases: { id: string; intent: string }[]): SmokeAction {
  return { action: "plan_smoke", params: { cases } };
}

const C_SOURCE_RUNNER = "public class SmokeDriver { public static void Main() { System.Console.WriteLine(\"{}\"); } }";
const JAVA_TARGET_RUNNER = "public class SmokeRunner { public static void main(String[] args) { System.out.println(\"{}\"); } }";

const sourceStdout = JSON.stringify({
  results: [
    { caseId: "c01", outcome: "return", returnValue: { type: "string", value: "hello" } },
    { caseId: "c02", outcome: "exception", exceptionType: "NullReferenceException", exceptionMessage: "null" },
  ],
});
const targetStdout = JSON.stringify({
  results: [
    { caseId: "c01", outcome: "return", returnValue: { type: "string", value: "hello" } },
    { caseId: "c02", outcome: "exception", exceptionType: "NullPointerException", exceptionMessage: "null" },
  ],
});

/** 标准 happy-path 应答脚本:plan → runners → compile×2 → run×2 → compare → judge → finish。 */
function happyPathScript(): string[] {
  return [
    actionJson(planAction([{ id: "c01", intent: "正常路径" }, { id: "c02", intent: "null 输入" }])),
    actionJson({ action: "write_runner", params: { side: "source", language: "C#", files: [{ path: "Driver.cs", content: C_SOURCE_RUNNER }] } }),
    actionJson({ action: "write_runner", params: { side: "target", language: "Java", files: [{ path: "SmokeRunner.java", content: JAVA_TARGET_RUNNER }] } }),
    actionJson({ action: "compile_runner", params: { side: "source" } }),
    actionJson({ action: "compile_runner", params: { side: "target" } }),
    actionJson({ action: "run_runner", params: { side: "source" } }),
    actionJson({ action: "run_runner", params: { side: "target" } }),
    actionJson({ action: "compare", params: {} }),
    actionJson({ action: "judge", params: { verdicts: [{ caseId: "c01", decision: "pass", reasoning: "两侧一致" }, { caseId: "c02", decision: "pass", reasoning: "NRE/NPE 等价" }] } }),
    actionJson({ action: "finish", params: { summary: "冒烟全部通过" } }),
  ];
}

function makeFakeExecutor(options?: {
  targetStdout?: string;
  fixedTargetStdout?: string;
}): FakeDriverExecutor {
  const targetOut = options?.targetStdout ?? targetStdout;
  const fixedOut = options?.fixedTargetStdout ?? targetStdout;
  return new FakeDriverExecutor({
    compileResults: { success: true, errors: [], output: "" },
    runResults: (side) => {
      if (side.language === "C#") return { exitCode: 0, stdout: sourceStdout, stderr: "" };
      const fixed = side.sourceFiles.some((f) => f.content.includes("FIXED_MARKER"));
      return { exitCode: 0, stdout: fixed ? fixedOut : targetOut, stderr: "" };
    },
  });
}

interface Harness {
  sourceDir: string;
  targetDir: string;
  executor: FakeDriverExecutor;
  spawn: FakeSpawn;
}

function makeHarness(options?: { buggy?: boolean }): Harness {
  const sourceDir = mkdtempSync(join(tmpdir(), "smoke-agent-src-"));
  const targetDir = mkdtempSync(join(tmpdir(), "smoke-agent-tgt-"));
  writeFileSync(join(sourceDir, "MimeUtility.cs"), "public static class MimeUtility { public static string DecodeText(string v) => v; }", "utf-8");
  const targetContent = options?.buggy
    ? "public class MimeUtility { public static String decodeText(String v) { return \"buggy\"; } }"
    : "public class MimeUtility { public static String decodeText(String v) { return v; } }";
  writeFileSync(join(targetDir, "MimeUtility.java"), targetContent, "utf-8");
  return { sourceDir, targetDir, executor: makeFakeExecutor(), spawn: scriptedSpawn([]) };
}

function makeAgent(h: Harness, overrides: { maxSteps?: number; maxRounds?: number } = {}): SmokeAgent {
  return new SmokeAgent({
    requirement: "解码 MIME 文本",
    sourceLang: "C#",
    targetLang: "Java",
    sourceDir: h.sourceDir,
    targetDir: h.targetDir,
    maxSteps: overrides.maxSteps ?? 40,
    maxRounds: overrides.maxRounds ?? 3,
    apiKey: "test-key",
    spawnClaude: h.spawn,
    executor: h.executor,
    logger: createLogger("smoke-agent-test", { disabled: true }),
  });
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  rmSync(harness.sourceDir, { recursive: true, force: true });
  rmSync(harness.targetDir, { recursive: true, force: true });
});

// ---- 测试 ----

describe("SmokeAgent:冒烟闭环(happy path)", () => {
  it("按 探索→plan→runner→编译→运行→差分→judge→finish 顺序驱动,报告收敛", async () => {
    harness.spawn = scriptedSpawn(happyPathScript());
    const agent = makeAgent(harness);

    const report = await agent.run();

    expect(report.converged).toBe(true);
    expect(report.steps).toBe(10);
    expect(report.rounds).toBe(0);
    expect(report.cases).toHaveLength(2);
    for (const c of report.cases) {
      expect(c.decision).toBe("pass");
      expect(c.mechanical).toBe("pass");
      expect(c.intent).not.toBe("");
    }
    expect(report.summary).toBe("冒烟全部通过");
    // 双侧各编译/运行一次
    expect(harness.executor.compileCalls).toHaveLength(2);
    expect(harness.executor.runCalls).toHaveLength(2);
  });

  it("首轮 prompt 含任务简报(需求/签名/文件清单);judge 轮 prompt 含差分结果", async () => {
    harness.spawn = scriptedSpawn(happyPathScript());
    const agent = makeAgent(harness);
    await agent.run();

    const prompts = harness.spawn.mock.calls.map((call) => String(call[0][1]));
    expect(prompts).toHaveLength(10);
    expect(prompts[0]).toContain("TASK BRIEFING");
    expect(prompts[0]).toContain("解码 MIME 文本");
    expect(prompts[0]).toContain("MimeUtility.cs");
    // judge 轮(第 9 次调用)的 prompt 应含差分结果与裁决引导
    expect(prompts[8]).toContain("SEMANTIC JUDGMENT");
    expect(prompts[8]).toContain("[c01] pass");
    // 每轮 prompt 都重放全量 history(stateless replay)
    expect(prompts[8]).toContain("CONVERSATION_HISTORY");
    expect(prompts[8]).toContain("run_runner");
  });

  it("动作解析失败时喂回格式错误并重试(≤2 次/步),循环继续", async () => {
    const script = happyPathScript();
    harness.spawn = scriptedSpawn(["这不是 JSON 输出", ...script]);
    const agent = makeAgent(harness);

    const report = await agent.run();

    expect(report.converged).toBe(true);
    expect(report.steps).toBe(10);
    expect(harness.spawn).toHaveBeenCalledTimes(11); // 10 步 + 1 次解析失败重试
    // 第二次调用的 prompt 含格式错误反馈
    const secondPrompt = String(harness.spawn.mock.calls[1][0][1]);
    expect(secondPrompt).toContain("无法解析为工具动作");
  });

  it("连续 3 次解析失败 → 中止循环,报告未收敛", async () => {
    harness.spawn = scriptedSpawn(["垃圾", "垃圾", "垃圾", "垃圾"]);
    const agent = makeAgent(harness);
    const report = await agent.run();
    expect(report.converged).toBe(false);
    expect(report.summary).toMatch(/解析失败/);
  });

  it("达到 maxSteps 上限 → 报告未收敛并说明步数上限", async () => {
    harness.spawn = scriptedSpawn([
      actionJson(planAction([{ id: "c01", intent: "正常" }])),
      actionJson({ action: "write_runner", params: { side: "source", language: "C#", files: [{ path: "Driver.cs", content: C_SOURCE_RUNNER }] } }),
    ]);
    const agent = makeAgent(harness, { maxSteps: 2 });
    const report = await agent.run();
    expect(report.converged).toBe(false);
    expect(report.steps).toBe(2);
    expect(report.summary).toMatch(/步数上限\(2\)/);
  });
});

describe("SmokeAgent:语义裁决与收敛判定", () => {
  it("finish 时存在 translation-bug 裁决 → 报告未收敛", async () => {
    const script = happyPathScript();
    script[8] = actionJson({
      action: "judge",
      params: { verdicts: [{ caseId: "c01", decision: "translation-bug", reasoning: "目标返回不一致" }, { caseId: "c02", decision: "pass", reasoning: "一致" }] },
    });
    harness.spawn = scriptedSpawn(script);
    const agent = makeAgent(harness);

    const report = await agent.run();

    expect(report.converged).toBe(false);
    const c01 = report.cases.find((c) => c.caseId === "c01");
    expect(c01?.decision).toBe("translation-bug");
  });

  it("全部 accepted-diff 也视为收敛;unclear 视为未收敛", async () => {
    const script = happyPathScript();
    script[8] = actionJson({
      action: "judge",
      params: { verdicts: [{ caseId: "c01", decision: "accepted-diff", reasoning: "异常消息措辞不同" }, { caseId: "c02", decision: "unclear", reasoning: "无法判断" }] },
    });
    harness.spawn = scriptedSpawn(script);
    const agent = makeAgent(harness);
    const report = await agent.run();
    expect(report.converged).toBe(false); // 含 unclear
  });
});

describe("SmokeAgent:修复闭环(propose_target_fix 自动重编译重差分)", () => {
  it("translation-bug → propose_target_fix → 重编译重运行重差分 → 再 judge → 收敛,rounds=1", async () => {
    const buggyHarness = makeHarness({ buggy: true });
    // 目标侧 bug 版返回 "buggy"(c01 差分 fail);修复版含 FIXED_MARKER → 返回正确值。
    const fixedTarget = "public class MimeUtility { /* FIXED_MARKER */ public static String decodeText(String v) { return v; } }";
    const script = happyPathScript();
    script[8] = actionJson({
      action: "judge",
      params: { verdicts: [{ caseId: "c01", decision: "translation-bug", reasoning: "目标侧返回固定错误值" }, { caseId: "c02", decision: "pass", reasoning: "一致" }] },
    });
    // 第 10 步:修复(插入 propose_target_fix + 修复后的 judge,再接原 finish)
    script.splice(9, 0,
      actionJson({ action: "propose_target_fix", params: { files: [{ path: "MimeUtility.java", content: fixedTarget }] } }),
      actionJson({ action: "judge", params: { verdicts: [{ caseId: "c01", decision: "pass", reasoning: "修复后一致" }, { caseId: "c02", decision: "pass", reasoning: "一致" }] } }),
    );
    buggyHarness.spawn = scriptedSpawn(script);
    buggyHarness.executor = makeFakeExecutor({
      targetStdout: JSON.stringify({
        results: [
          { caseId: "c01", outcome: "return", returnValue: { type: "string", value: "buggy" } },
          { caseId: "c02", outcome: "exception", exceptionType: "NullPointerException", exceptionMessage: "null" },
        ],
      }),
    });
    const agent = makeAgent(buggyHarness);

    const report = await agent.run();

    expect(report.converged).toBe(true);
    expect(report.rounds).toBe(1);
    expect(report.steps).toBe(12);
    // 修复产物进入报告 targetFiles(未采纳不落盘)
    expect(report.targetFiles[0]?.path).toBe("MimeUtility.java");
    expect(report.targetFiles[0]?.content).toContain("FIXED_MARKER");
    // 目标侧被编译+运行两次(修复前 + 修复后自动链);第二次 run 使用修复内容
    const targetRuns = buggyHarness.executor.runCalls.filter((s) => s.language === "Java");
    expect(targetRuns).toHaveLength(2);
    expect(targetRuns[1]?.sourceFiles.some((f) => f.content.includes("FIXED_MARKER"))).toBe(true);
  });

  it("修复轮数达到 maxRounds 后指令提示 finish,不再强推修复", async () => {
    // 反复 translation-bug + propose_target_fix,直到轮数达上限后 agent 才 finish。
    const script = [
      actionJson(planAction([{ id: "c01", intent: "正常" }, { id: "c02", intent: "null 输入" }])),
      actionJson({ action: "write_runner", params: { side: "source", language: "C#", files: [{ path: "Driver.cs", content: C_SOURCE_RUNNER }] } }),
      actionJson({ action: "write_runner", params: { side: "target", language: "Java", files: [{ path: "SmokeRunner.java", content: JAVA_TARGET_RUNNER }] } }),
      actionJson({ action: "compile_runner", params: { side: "source" } }),
      actionJson({ action: "compile_runner", params: { side: "target" } }),
      actionJson({ action: "run_runner", params: { side: "source" } }),
      actionJson({ action: "run_runner", params: { side: "target" } }),
      actionJson({ action: "compare", params: {} }),
      actionJson({ action: "judge", params: { verdicts: [{ caseId: "c01", decision: "translation-bug", reasoning: "仍不一致" }, { caseId: "c02", decision: "pass", reasoning: "一致" }] } }),
      actionJson({ action: "propose_target_fix", params: { files: [{ path: "MimeUtility.java", content: "public class MimeUtility { public static String decodeText(String v) { return v; } }" }] } }),
      actionJson({ action: "judge", params: { verdicts: [{ caseId: "c01", decision: "translation-bug", reasoning: "仍不一致" }, { caseId: "c02", decision: "pass", reasoning: "一致" }] } }),
      actionJson({ action: "propose_target_fix", params: { files: [{ path: "MimeUtility.java", content: "public class MimeUtility { public static String decodeText(String v) { return v; } }" }] } }),
      actionJson({ action: "finish", params: { summary: "未收敛" } }),
    ];
    harness.spawn = scriptedSpawn(script);
    const agent = makeAgent(harness, { maxRounds: 2 });
    const report = await agent.run();
    // rounds 达上限(2)后 finish,报告未收敛(仍含 translation-bug 裁决)
    expect(report.rounds).toBe(2);
    expect(report.converged).toBe(false);
    const c01 = report.cases.find((c) => c.caseId === "c01");
    expect(c01?.decision).toBe("translation-bug");
    // 最后一轮(轮数已满)的指令应提示不再强推修复
    const lastPrompt = String(harness.spawn.mock.calls.at(-1)![0][1]);
    expect(lastPrompt).toMatch(/修复轮数上限/);
  });
});

describe("assembleSmokeReport", () => {
  it("plan/比较/裁决三方合并;未 finish 或含 translation-bug → 未收敛", () => {
    const state: SmokeContextState = {
      requirement: "r",
      sourceLang: "C#",
      targetLang: "Java",
      sourceRoot: "/s",
      targetRoot: "/t",
      sourceModuleFiles: [],
      targetModuleFiles: [{ relativePath: "A.java", content: "class A {}" }],
      plan: [{ id: "c01", intent: "intent1" }],
      runners: { source: null, target: null },
      compile: { source: null, target: null },
      run: { source: null, target: null },
      comparisons: [
        {
          caseId: "c01",
          verdict: "pass",
          source: { caseId: "c01", outcome: "return", returnValue: { type: "string", value: "x" } },
          target: { caseId: "c01", outcome: "return", returnValue: { type: "string", value: "x" } },
          details: [],
        },
      ],
      decisions: [{ caseId: "c01", decision: "translation-bug", reasoning: "r" }],
      sourceIssues: [],
      rounds: 0,
      steps: 5,
      finished: true,
      summary: "s",
      compileFailures: { source: 0, target: 0 },
    };
    const report = assembleSmokeReport(state);
    expect(report.converged).toBe(false);
    expect(report.steps).toBe(5);
    expect(report.cases[0]).toMatchObject({
      caseId: "c01",
      intent: "intent1",
      mechanical: "pass",
      decision: "translation-bug",
    });
    expect(report.targetFiles[0]?.path).toBe("A.java");
  });

  it("未调用 finish → 未收敛;计划为空 → 未收敛", () => {
    const base: SmokeContextState = {
      requirement: "r",
      sourceLang: "C#",
      targetLang: "Java",
      sourceRoot: "/s",
      targetRoot: "/t",
      sourceModuleFiles: [],
      targetModuleFiles: [],
      plan: [],
      runners: { source: null, target: null },
      compile: { source: null, target: null },
      run: { source: null, target: null },
      comparisons: null,
      decisions: [],
      sourceIssues: [],
      rounds: 0,
      steps: 3,
      finished: false,
      summary: "",
      compileFailures: { source: 0, target: 0 },
    };
    expect(assembleSmokeReport(base).converged).toBe(false);
  });
});

describe("runClaude 与 SmokeAgent 的注入通道", () => {
  it("SmokeAgent 通过注入的 spawnClaude 走 runClaude 单轮契约(args 含 -p)", async () => {
    harness.spawn = scriptedSpawn(happyPathScript());
    const agent = makeAgent(harness);
    await agent.run();
    // 每次调用都是 claude -p 模式:args[0]="-p", args[1]=完整 prompt
    const first = harness.spawn.mock.calls[0];
    expect(first[0]).toEqual(["-p", expect.stringContaining("TASK BRIEFING"), "--output-format", "text"]);
  });
});
