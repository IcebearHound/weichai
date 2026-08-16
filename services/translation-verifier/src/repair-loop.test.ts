import { describe, expect, it, vi } from "vitest";
import { deepSeekModelConfig } from "@forexplore/adaptation-service";
import type { TestCase, TestDescription, TypedValue, VerifierLanguage } from "./description.js";
import type { CaseResult } from "./result-capture.js";
import type { CompileOutcome, RunOutcome, SideSpec } from "./executor.js";
import { FakeDriverExecutor } from "./executor.js";
import type { VerificationJob } from "./verifier.js";
import {
  buildRepairPrompt,
  RepairAgent,
  RepairLoop,
  type RepairAgentLike,
  type RepairDiagnosis,
  type RepairInput,
} from "./repair-loop.js";

// ---- 测试辅助 ----

function str(value: string): TypedValue {
  return { type: "string", value };
}

function caseReturn(id: string, value: TypedValue): TestCase {
  return { id, inputs: [], expected: { kind: "return", value } };
}

/** 描述的目标侧固定为 Java(修复闭环 v1 面向 Java);requirement 可选(需求原文)。 */
function makeDescription(cases: TestCase[], requirement?: string): TestDescription {
  return {
    schemaVersion: "1.0",
    requirement,
    target: { language: "Java", className: "Util", method: "DoubleIt", isStatic: true, constructorArgs: [] },
    cases,
  };
}

function side(language: VerifierLanguage, marker: string): SideSpec {
  return {
    language,
    driverSource: `// driver ${marker}`,
    sourceFiles: [{ relativePath: "Util.cs", content: `// source ${marker}` }],
  };
}

function returnResult(caseId: string, value: TypedValue): CaseResult {
  return { caseId, outcome: "return", returnValue: value };
}

function stdoutFor(results: CaseResult[]): string {
  return JSON.stringify({
    results: results.map((r) => ({
      caseId: r.caseId,
      outcome: r.outcome,
      ...(r.outcome === "return"
        ? { returnValue: r.returnValue }
        : { exceptionType: r.exceptionType, exceptionMessage: r.exceptionMessage ?? "" }),
    })),
  });
}

/**
 * FakeRepairAgent(测试替身):记录每次 repair 的 RepairInput,返回预设方法代码。
 * 与 FakeDriverExecutor 配合:目标侧若含 "FIXED" 标记则返回修复后 stdout,否则返回损坏 stdout。
 */
class FakeRepairAgent implements RepairAgentLike {
  readonly calls: RepairInput[] = [];
  constructor(private readonly methodCode: string) {}
  async repair(input: RepairInput): Promise<string> {
    this.calls.push(input);
    return this.methodCode;
  }
}

class ThrowingRepairAgent implements RepairAgentLike {
  readonly calls: RepairInput[] = [];
  async repair(input: RepairInput): Promise<string> {
    this.calls.push(input);
    throw new Error("repair exploded");
  }
}

/** 首轮 target 与源不一致(fail);修复后(目标侧源码含 FIXED 标记)第二轮一致(pass)。 */
function failThenPassExecutor(
  sourceSpec: SideSpec,
  sourceStdout: string,
  targetBuggyStdout: string,
  targetFixedStdout: string,
): FakeDriverExecutor {
  return new FakeDriverExecutor({
    compileResults: (): CompileOutcome => ({ success: true, errors: [], output: "" }),
    runResults: (sideArg: SideSpec): RunOutcome => {
      if (sideArg === sourceSpec) return { exitCode: 0, stdout: sourceStdout, stderr: "" };
      const content = sideArg.sourceFiles.map((f) => f.content).join("\n");
      return {
        exitCode: 0,
        stdout: content.includes("FIXED") ? targetFixedStdout : targetBuggyStdout,
        stderr: "",
      };
    },
  });
}

/** 永远 fail 的执行器(修复无法收敛):目标侧永远返回错误值。 */
function alwaysFailExecutor(sourceSpec: SideSpec, sourceStdout: string): FakeDriverExecutor {
  return new FakeDriverExecutor({
    compileResults: (): CompileOutcome => ({ success: true, errors: [], output: "" }),
    runResults: (sideArg: SideSpec): RunOutcome => ({
      exitCode: 0,
      stdout: sideArg === sourceSpec ? sourceStdout : stdoutFor([returnResult("c1", str("y"))]),
      stderr: "",
    }),
  });
}

function rebuildTargetSide(methodCode: string): SideSpec {
  return {
    language: "Java",
    driverSource: "// target driver",
    sourceFiles: [{ relativePath: "Util.java", content: methodCode }],
  };
}

function sampleRepairInput(): RepairInput {
  return {
    sourceLanguage: "C#",
    sourceCode: "public static string DecodeText(string value) { return value; }",
    target: { language: "Java", className: "MimeUtil", method: "decodeText", signature: "MimeUtil.decodeText" },
    previousMethodCode: "public class MimeUtil { public static String decodeText(String value) { return \"broken\"; } }",
    requirement: "解码 MIME 编码文本(如 =?UTF-8?B?...?=),非编码文本原样返回",
    diagnosis: [
      {
        caseId: "c1",
        inputs: [{ type: "string", value: "abc" }],
        source: { caseId: "c1", outcome: "return", returnValue: { type: "string", value: "abc" } },
        target: { caseId: "c1", outcome: "return", returnValue: { type: "string", value: "broken" } },
        details: ["return value mismatch"],
        requirementVerdict: "target-diverges",
      },
    ],
  };
}

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function mockFetch(content: string): ReturnType<typeof vi.fn> {
  return vi.fn(async () => okResponse(content));
}

// ---- RepairLoop 行为 ----

describe("RepairLoop.run", () => {
  it("1. 首轮全 PASS → rounds=1,不调用 repair", async () => {
    const desc = makeDescription([caseReturn("c1", str("hi"))], "返回 hi");
    const sourceSpec = side("C#", "source");
    const executor = new FakeDriverExecutor({
      compileResults: (): CompileOutcome => ({ success: true, errors: [], output: "" }),
      runResults: (): RunOutcome => ({ exitCode: 0, stdout: stdoutFor([returnResult("c1", str("hi"))]), stderr: "" }),
    });
    const repair = new FakeRepairAgent("// FIXED");
    const loop = new RepairLoop({ repairAgent: repair, rebuildTargetSide });

    const result = await loop.run({ description: desc, source: sourceSpec, target: side("Java", "target") }, executor);

    expect(result.rounds).toBe(1);
    expect(result.reports).toHaveLength(1);
    expect(repair.calls).toHaveLength(0);
    expect(result.finalReport).toBe(result.reports[0]);
    expect(result.finalReport.passedCases).toBe(1);
  });

  it("2. 首轮 FAIL → 修复收敛 rounds=2;repair 收到 requirement,诊断含 caseId/details/requirementVerdict=target-diverges", async () => {
    const requirementText = "输入值翻倍返回";
    const desc = makeDescription([caseReturn("c1", str("x"))], requirementText);
    const sourceSpec = side("C#", "source");
    const executor = failThenPassExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("x"))]),
      stdoutFor([returnResult("c1", str("y"))]),
      stdoutFor([returnResult("c1", str("x"))]),
    );
    const repair = new FakeRepairAgent("// FIXED\nclass Util { static String DoubleIt() { return \"x\"; } }");
    const loop = new RepairLoop({ repairAgent: repair, rebuildTargetSide });

    const result = await loop.run({ description: desc, source: sourceSpec, target: side("Java", "target") }, executor);

    // 收敛:rounds=2,repair 恰好 1 次,最终报告全 PASS。
    expect(result.rounds).toBe(2);
    expect(result.reports).toHaveLength(2);
    expect(repair.calls).toHaveLength(1);
    expect(result.finalReport.failedCases).toBe(0);
    expect(result.finalReport.divergentCases).toBe(0);
    expect(result.finalReport.passedCases).toBe(1);

    // 首轮报告保留了失败证据。
    expect(result.reports[0]?.failedCases).toBe(1);

    // repair 收到需求原文与上下文。
    const input = repair.calls[0]!;
    expect(input.requirement).toBe(requirementText);
    expect(input.sourceLanguage).toBe("C#");
    expect(input.sourceCode).toContain("source");
    expect(input.previousMethodCode).toContain("target");
    expect(input.target).toEqual({ language: "Java", className: "Util", method: "DoubleIt", signature: "Util.DoubleIt" });

    // 诊断:失败 case 的 caseId、details、requirementVerdict(源 x vs 目标 y、需求 x → 目标侧偏离需求)。
    const diag = input.diagnosis[0]!;
    expect(diag.caseId).toBe("c1");
    expect(diag.details.length).toBeGreaterThan(0);
    expect(diag.details).toContain("return value mismatch");
    expect(diag.requirementVerdict).toBe("target-diverges");
    expect(diag.source?.returnValue).toEqual(str("x"));
    expect(diag.target?.returnValue).toEqual(str("y"));
  });

  it("3. 需求裁决 target-conforms:目标侧符合 expected 时诊断携带 target-conforms", async () => {
    // 需求(expected)=y;源侧返回 x、目标侧返回 y → 差分 fail,但目标侧符合需求 → target-conforms。
    const desc = makeDescription(
      [{ id: "c1", inputs: [], expected: { kind: "return", value: str("y") } }],
      "返回值必须为 y",
    );
    const sourceSpec = side("C#", "source");
    const executor = failThenPassExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("x"))]),
      stdoutFor([returnResult("c1", str("y"))]),
      stdoutFor([returnResult("c1", str("y"))]),
    );
    const repair = new FakeRepairAgent("// FIXED");
    const loop = new RepairLoop({ repairAgent: repair, rebuildTargetSide });

    await loop.run({ description: desc, source: sourceSpec, target: side("Java", "target") }, executor);

    const diag = repair.calls[0]!.diagnosis[0]!;
    expect(diag.caseId).toBe("c1");
    expect(diag.requirementVerdict).toBe("target-conforms");
    expect(diag.details).toContain("target matches declared requirement; divergence is source-side");
  });

  it("4. 达到 maxRounds(默认 3)仍未全 PASS → rounds=4,保留最终报告", async () => {
    const desc = makeDescription([caseReturn("c1", str("x"))]);
    const sourceSpec = side("C#", "source");
    const executor = alwaysFailExecutor(sourceSpec, stdoutFor([returnResult("c1", str("x"))]));
    const repair = new FakeRepairAgent("// never converges");
    const loop = new RepairLoop({ repairAgent: repair, rebuildTargetSide });

    const result = await loop.run({ description: desc, source: sourceSpec, target: side("Java", "target") }, executor);

    expect(result.rounds).toBe(4); // maxRounds=3 → 验证 maxRounds+1 次
    expect(result.reports).toHaveLength(4);
    expect(repair.calls).toHaveLength(3); // 修复尝试 maxRounds 次
    expect(result.finalReport).toBe(result.reports[3]);
    expect(result.finalReport.failedCases).toBe(1);
  });

  it("5. maxRounds=0 → 只验证一次,不调用 repair", async () => {
    const desc = makeDescription([caseReturn("c1", str("x"))]);
    const sourceSpec = side("C#", "source");
    const executor = alwaysFailExecutor(sourceSpec, stdoutFor([returnResult("c1", str("x"))]));
    const repair = new FakeRepairAgent("// FIXED");
    const loop = new RepairLoop({ maxRounds: 0, repairAgent: repair, rebuildTargetSide });

    const result = await loop.run({ description: desc, source: sourceSpec, target: side("Java", "target") }, executor);

    expect(result.rounds).toBe(1);
    expect(result.reports).toHaveLength(1);
    expect(repair.calls).toHaveLength(0);
    expect(result.finalReport.failedCases).toBe(1);
  });

  it("6. repair 抛错 → 该轮视为未修复,继续下一轮至 maxRounds,错误被记录", async () => {
    const desc = makeDescription([caseReturn("c1", str("x"))]);
    const sourceSpec = side("C#", "source");
    const executor = alwaysFailExecutor(sourceSpec, stdoutFor([returnResult("c1", str("x"))]));
    const repair = new ThrowingRepairAgent();
    const loop = new RepairLoop({ repairAgent: repair, rebuildTargetSide });

    const result = await loop.run({ description: desc, source: sourceSpec, target: side("Java", "target") }, executor);

    expect(result.rounds).toBe(4);
    expect(result.reports).toHaveLength(4);
    expect(repair.calls).toHaveLength(3);
    expect(loop.repairErrors).toHaveLength(3);
    expect(loop.repairErrors[0]).toBeInstanceOf(Error);
    expect(result.finalReport.failedCases).toBe(1);
  });

  it("7. rebuildTargetSide 注入:新方法代码被传入并用于重新 verify", async () => {
    const desc = makeDescription([caseReturn("c1", str("x"))]);
    const sourceSpec = side("C#", "source");
    const executor = failThenPassExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("x"))]),
      stdoutFor([returnResult("c1", str("y"))]),
      stdoutFor([returnResult("c1", str("x"))]),
    );
    const repairedCode = "// FIXED marker\nclass Util { static String DoubleIt() { return \"x\"; } }";
    const repair = new FakeRepairAgent(repairedCode);
    const rebuiltSides: SideSpec[] = [];
    const loop = new RepairLoop({
      repairAgent: repair,
      rebuildTargetSide: (methodCode: string) => {
        const rebuilt = {
          language: "Java" as const,
          driverSource: "// target driver",
          sourceFiles: [{ relativePath: "Util.java", content: methodCode }],
        };
        rebuiltSides.push(rebuilt);
        return rebuilt;
      },
    });

    const result = await loop.run({ description: desc, source: sourceSpec, target: side("Java", "target") }, executor);

    expect(result.rounds).toBe(2);
    expect(rebuiltSides).toHaveLength(1);
    expect(rebuiltSides[0]?.sourceFiles[0]?.content).toBe(repairedCode);
    // 第二轮 verify 的 target 侧 = rebuild 产物:executor.compileCalls/runCalls 中出现更新后的 sourceFiles。
    // compileCalls 顺序:round1 [source, target],round2 [source, rebuilt]。
    expect(executor.compileCalls[3]?.sourceFiles[0]?.content).toBe(repairedCode);
    expect(executor.runCalls[3]?.sourceFiles[0]?.content).toBe(repairedCode);
  });

  it("8. 未注入 repairAgent → 构造抛错", () => {
    expect(() => new RepairLoop({ rebuildTargetSide })).toThrow(/requires a repairAgent/);
  });
});

// ---- RepairAgent(DeepSeek) ----

describe("RepairAgent", () => {
  it("返回剥离代码围栏后的方法代码(stripCodeFence 风格)", async () => {
    const request = mockFetch("```java\nclass Util {\n  static String DoubleIt() { return \"x\"; }\n}\n```");
    const agent = new RepairAgent({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });

    const code = await agent.repair(sampleRepairInput());

    expect(code).toBe('class Util {\n  static String DoubleIt() { return "x"; }\n}');
  });

  it("模型返回空内容 → 抛错", async () => {
    const request = mockFetch("```\n```");
    const agent = new RepairAgent({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });

    await expect(agent.repair(sampleRepairInput())).rejects.toThrow(/empty code/);
  });

  it("请求体:POST chat/completions,temperature=0.1,user 消息 = buildRepairPrompt 输出", async () => {
    const input = sampleRepairInput();
    const request = mockFetch("class Util {}");
    const agent = new RepairAgent({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });

    await agent.repair(input);

    expect(request).toHaveBeenCalledWith(
      `${deepSeekModelConfig.apiBase}/chat/completions`,
      expect.objectContaining({ method: "POST" }),
    );
    const init = request.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
    };
    expect(body.model).toBe(deepSeekModelConfig.model);
    expect(body.temperature).toBe(0.1);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]?.content).toBe(buildRepairPrompt(input));
  });

  it("无 apiKey → 抛错且不调用 fetch", async () => {
    const request = mockFetch("class Util {}");
    const agent = new RepairAgent({ apiKey: "   ", request: request as unknown as typeof globalThis.fetch });

    await expect(agent.repair(sampleRepairInput())).rejects.toThrow(/DEEPSEEK_API_KEY is required/);
    expect(request).not.toHaveBeenCalled();
  });
});

// ---- buildRepairPrompt(需求第一) ----

describe("buildRepairPrompt(需求第一)", () => {
  it("以 USER_REQUIREMENT (highest priority) 开头,含需求原文与诊断 JSON 的 requirementVerdict", () => {
    const input = sampleRepairInput();
    const prompt = buildRepairPrompt(input);

    expect(prompt.startsWith("USER_REQUIREMENT (highest priority)\n")).toBe(true);
    expect(prompt).toContain(input.requirement);
    expect(prompt.indexOf("USER_REQUIREMENT")).toBeLessThan(prompt.indexOf("SOURCE_METHOD"));
    expect(prompt.indexOf("USER_REQUIREMENT")).toBeLessThan(prompt.indexOf("PREVIOUS_TARGET_FILE"));
    expect(prompt.indexOf("USER_REQUIREMENT")).toBeLessThan(prompt.indexOf("DIFFERENTIAL_DIAGNOSIS"));
    // 诊断 JSON:含 caseId 与 requirementVerdict(需求裁决)。
    expect(prompt).toContain('"caseId":"c1"');
    expect(prompt).toContain('"requirementVerdict":"target-diverges"');
    expect(prompt).toContain("Source language: C#");
    expect(prompt).toContain("Target signature: MimeUtil.decodeText");
    expect(prompt).toContain("SOURCE_METHOD");
    expect(prompt).toContain(input.sourceCode);
    expect(prompt).toContain("PREVIOUS_TARGET_FILE");
    expect(prompt).toContain(input.previousMethodCode);
  });
});

// ---- 类型级保证(需求必填语义) ----

describe("RepairInput/RepairDiagnosis 类型契约", () => {
  it("RepairDiagnosis 的 requirementVerdict 可选字段类型正确", () => {
    const conforms: RepairDiagnosis = {
      caseId: "c1",
      inputs: [],
      source: null,
      target: null,
      details: [],
      requirementVerdict: "target-conforms",
    };
    const diverges: RepairDiagnosis = { ...conforms, requirementVerdict: "target-diverges" };
    const absent: RepairDiagnosis = { ...conforms, requirementVerdict: undefined };
    expect([conforms, diverges, absent]).toHaveLength(3);
  });

  it("RepairInput.requirement 是必填字段", () => {
    // @ts-expect-error RepairInput.requirement 必填(需求第一:修复以需求为准)
    const bad: RepairInput = {
      sourceLanguage: "C#",
      sourceCode: "x",
      target: { language: "Java", className: "A", method: "b", signature: "A.b" },
      previousMethodCode: "y",
      diagnosis: [],
    };
    expect(bad).toBeDefined();
  });
});
