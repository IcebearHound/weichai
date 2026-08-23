import { describe, expect, it, vi } from "vitest";
import {
  buildConsistencyPrompt,
  LlmAnalyzer,
  NoneCoverageProvider,
  type AnalyzerLike,
  type BranchCoverage,
  type BranchInventory,
  type CaseConsistency,
  type CoverageProvider,
} from "./analyzer.js";
import { runConsistencyVerification } from "./consistency-verifier.js";
import type { SpawnClaude } from "./claude-client.js";
import type { TestDescription, TypedValue } from "./description.js";
import {
  FakeDriverExecutor,
  type CompileOutcome,
  type RunOutcome,
  type SideSpec,
} from "./executor.js";
import { createLogger } from "./logger.js";
import { verify, type VerificationJob } from "./verifier.js";

type FakeSpawn = SpawnClaude & ReturnType<typeof vi.fn>;

function fakeSpawn(stdout: string, exitCode = 0, stderr = ""): FakeSpawn {
  const mock = vi.fn(async () => ({ stdout, exitCode, stderr }));
  return mock as unknown as FakeSpawn;
}

// ---- 测试数据 ----

const inventoryJson = JSON.stringify({
  methodId: "Calculator.add",
  methodSummary: "需求语义:add 返回两数之和;输入为 null 时返回 0(而非抛异常)。",
  branches: [
    {
      id: "b1",
      kind: "if",
      location: "方法开头",
      condition: "任一输入为 null",
      semantics: "返回 0",
      nldConsistent: true,
    },
    {
      id: "b2",
      kind: "boundary",
      location: "求和处",
      condition: "正数 + 负数(符号相消)",
      semantics: "返回代数正确和",
      nldConsistent: true,
    },
    {
      id: "b3",
      kind: "implicit",
      location: "返回语句",
      condition: "常规两数相加",
      semantics: "返回 x + y",
      nldConsistent: false,
      defectNote: "缺陷实现直接返回 x - y,与需求相反",
    },
  ],
});

const inventory = JSON.parse(inventoryJson) as BranchInventory;

function description(): TestDescription {
  return {
    schemaVersion: "1.0",
    requirement: "add(x, y) 返回两数之和;任一输入为 null 时返回 0",
    target: { language: "Java", className: "Calculator", method: "add", isStatic: true, constructorArgs: [] },
    cases: [
      {
        id: "c1",
        description: "场景:常规加法 / 触发行为:返回和 / 目标分支或边界:nominal",
        branches: ["nominal"],
        inputs: [
          { type: "number", value: 1 },
          { type: "number", value: 2 },
        ],
        expected: { kind: "return", value: { type: "number", value: 3 } },
      },
      {
        id: "c2",
        description: "场景:null 输入 / 触发行为:返回 0 / 目标分支或边界:boundary",
        branches: ["boundary: null"],
        inputs: [{ type: "null", value: null }],
        expected: { kind: "return", value: { type: "number", value: 0 } },
      },
    ],
  };
}

const okCompile: CompileOutcome = { success: true, errors: [], output: "" };

function resultsStdout(cases: Array<{ caseId: string; value: number }>): RunOutcome {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      results: cases.map((c) => ({
        caseId: c.caseId,
        outcome: "return",
        returnValue: { type: "number", value: c.value },
      })),
    }),
    stderr: "",
  };
}

function sourceSide(): SideSpec {
  return {
    language: "C#",
    driverSource: "public static class SourceDriver { }",
    sourceFiles: [{ relativePath: "source.cs", content: "public static class Calculator { public static int Add(int x, int y) => x + y; }" }],
  };
}

function targetSide(): SideSpec {
  return {
    language: "Java",
    driverSource: "public class Driver_abc12345 { }",
    sourceFiles: [{ relativePath: "Calculator.java", content: "public class Calculator { public static int add(int x, int y) { return x + y; } }" }],
  };
}

function makeJob(desc: TestDescription = description()): VerificationJob {
  return { description: desc, source: sourceSide(), target: targetSide() };
}

/** fake AnalyzerLike:预设 inventory/consistencies/augmentations(编排层单测不需要真实 LLM)。 */
function fakeAnalyzer(overrides: Partial<AnalyzerLike>): AnalyzerLike {
  return {
    buildBranchInventory: vi.fn(async () => inventory),
    analyzeCases: vi.fn(async () => []),
    generateAugmentations: vi.fn(async () => []),
    ...overrides,
  };
}

const quietLogger = createLogger("test", { disabled: true });

// ---- LlmAnalyzer 单测(fake spawnClaude) ----

describe("LlmAnalyzer(LLM 分支一致性分析)", () => {
  it("buildBranchInventory 解析 LLM 返回的分支清单(含 defectNote)", async () => {
    const spawnClaude = fakeSpawn(inventoryJson);
    const analyzer = new LlmAnalyzer({ apiKey: "test-key", spawnClaude });

    const result = await analyzer.buildBranchInventory("source code", "requirement text");

    expect(result.methodId).toBe("Calculator.add");
    expect(result.branches).toHaveLength(3);
    expect(result.branches[0]).toMatchObject({ id: "b1", kind: "if", nldConsistent: true });
    expect(result.branches[2]?.nldConsistent).toBe(false);
    expect(result.branches[2]?.defectNote).toContain("缺陷实现");
    expect(spawnClaude).toHaveBeenCalledTimes(1);
    // prompt 包含需求与源方法。
    const prompt = (spawnClaude.mock.calls[0]?.[0] as string[])[1] as string;
    expect(prompt).toContain("REQUIREMENT (the ONLY ground truth)");
    expect(prompt).toContain("SOURCE_METHOD");
  });

  it("analyzeCases 解析 LLM 返回的一致性判定数组", async () => {
    const spawnClaude = fakeSpawn(
      JSON.stringify([
        {
          caseId: "c1",
          touchedBranches: ["b1", "b3"],
          assertionConsistent: false,
          nldVerdict: "diverges",
          recommend: "flag-fail",
          reasons: ["expected 复制了缺陷实现 b3 的行为"],
        },
        {
          caseId: "c2",
          touchedBranches: ["b1"],
          assertionConsistent: true,
          nldVerdict: "conforms",
          recommend: "ok",
          reasons: [],
        },
      ]),
    );
    const analyzer = new LlmAnalyzer({ apiKey: "test-key", spawnClaude });
    const report = await verify(makeJob(), new FakeDriverExecutor({ compileResults: okCompile, runResults: resultsStdout([{ caseId: "c1", value: 3 }, { caseId: "c2", value: 0 }]) }));

    const result = await analyzer.analyzeCases(description(), report, inventory);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      caseId: "c1",
      touchedBranches: ["b1", "b3"],
      assertionConsistent: false,
      nldVerdict: "diverges",
      recommend: "flag-fail",
    });
    expect(result[1]?.recommend).toBe("ok");
  });

  it("analyzeCases 丢弃 LLM 返回中不存在的 caseId(防幻觉)", async () => {
    const spawnClaude = fakeSpawn(
      JSON.stringify([
        {
          caseId: "ghost-case",
          touchedBranches: [],
          assertionConsistent: true,
          nldVerdict: "conforms",
          recommend: "ok",
          reasons: [],
        },
      ]),
    );
    const analyzer = new LlmAnalyzer({ apiKey: "test-key", spawnClaude });
    const report = await verify(makeJob(), new FakeDriverExecutor({ compileResults: okCompile, runResults: resultsStdout([{ caseId: "c1", value: 3 }]) }));

    const result = await analyzer.analyzeCases(description(), report, inventory);

    expect(result).toHaveLength(0);
  });

  it("generateAugmentations 解析新 case 并过滤幻觉分支 id", async () => {
    const spawnClaude = fakeSpawn(
      JSON.stringify([
        {
          id: "a1",
          description: "场景:null 输入 / 触发行为:返回 0 / 目标分支或边界:b1",
          branches: ["b1", "b99-not-in-inventory"],
          inputs: [{ type: "null", value: null }],
          expected: { kind: "return", value: { type: "number", value: 0 } },
        },
      ]),
    );
    const analyzer = new LlmAnalyzer({ apiKey: "test-key", spawnClaude });

    const result = await analyzer.generateAugmentations(inventory, description());

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a1");
    expect(result[0]?.branches).toEqual(["b1"]); // b99 被过滤
  });

  it("CoverageProvider 返回非空覆盖时,LLM prompt 携带插桩证据(走插桩分支)", async () => {
    const provider = vi.fn(async (): Promise<BranchCoverage> => ({ covered: ["b1"], evidence: "jacoco: line 3 branch 2 hit" }));
    const spawnClaude = fakeSpawn("[]");
    const analyzer = new LlmAnalyzer({
      apiKey: "test-key",
      spawnClaude,
      coverageProvider: { getCoverage: provider },
      coverageSide: targetSide(),
      executor: new FakeDriverExecutor({ compileResults: okCompile, runResults: resultsStdout([{ caseId: "c1", value: 3 }]) }),
    });
    const report = await verify(makeJob(), new FakeDriverExecutor({ compileResults: okCompile, runResults: resultsStdout([{ caseId: "c1", value: 3 }]) }));

    await analyzer.analyzeCases(description(), report, inventory);

    expect(provider).toHaveBeenCalledTimes(1);
    const prompt = (spawnClaude.mock.calls[0]?.[0] as string[])[1] as string;
    expect(prompt).toContain("INSTRUMENTED_COVERAGE");
    expect(prompt).toContain("jacoco: line 3 branch 2 hit");
  });

  it("CoverageProvider 返回 null 时,LLM prompt 不含插桩证据(退回 LLM 退化判定)", async () => {
    const provider = vi.fn(async (): Promise<null> => null);
    const spawnClaude = fakeSpawn("[]");
    const analyzer = new LlmAnalyzer({
      apiKey: "test-key",
      spawnClaude,
      coverageProvider: { getCoverage: provider },
      coverageSide: targetSide(),
      executor: new FakeDriverExecutor({ compileResults: okCompile, runResults: resultsStdout([{ caseId: "c1", value: 3 }]) }),
    });
    const report = await verify(makeJob(), new FakeDriverExecutor({ compileResults: okCompile, runResults: resultsStdout([{ caseId: "c1", value: 3 }]) }));

    await analyzer.analyzeCases(description(), report, inventory);

    expect(provider).toHaveBeenCalledTimes(1);
    const prompt = (spawnClaude.mock.calls[0]?.[0] as string[])[1] as string;
    // 静态指令文本会提到 INSTRUMENTED_COVERAGE(引导 LLM 优先采信插桩证据),但不应出现证据段本身。
    expect(prompt.match(/INSTRUMENTED_COVERAGE/g)?.length).toBe(1);
    expect(prompt).not.toContain('"covered"');
  });

  it("CoverageProvider 注入但缺少 coverageSide/executor 时抛配置错误", async () => {
    const analyzer = new LlmAnalyzer({
      apiKey: "test-key",
      spawnClaude: fakeSpawn("[]"),
      coverageProvider: new NoneCoverageProvider(),
      // 未注入 coverageSide / executor
    });
    const report = await verify(makeJob(), new FakeDriverExecutor({ compileResults: okCompile, runResults: resultsStdout([{ caseId: "c1", value: 3 }]) }));

    await expect(analyzer.analyzeCases(description(), report, inventory)).rejects.toThrow(/coverageProvider 已注入但缺少 coverageSide\/executor/);
  });

  it("NoneCoverageProvider 恒返回 null", async () => {
    // 类自身签名无参数(设计文档原样);按接口类型调用验证兼容。
    const provider: CoverageProvider = new NoneCoverageProvider();
    await expect(
      provider.getCoverage(
        targetSide(),
        new FakeDriverExecutor({ compileResults: okCompile, runResults: resultsStdout([]) }),
        description(),
      ),
    ).resolves.toBeNull();
  });
});

// ---- runConsistencyVerification 编排层单测(fake analyzer + FakeDriverExecutor) ----

describe("runConsistencyVerification(编排层)", () => {
  const runC1 = resultsStdout([{ caseId: "c1", value: 3 }]);

  it("① 差分覆盖率统计正确(covered/uncovered 按 inventory 对齐,幻觉 id 过滤)", async () => {
    const analyzer = fakeAnalyzer({
      analyzeCases: vi.fn(async (): Promise<CaseConsistency[]> => [
        { caseId: "c1", touchedBranches: ["b1", "b99-ghost"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
        { caseId: "c2", touchedBranches: ["b1", "b3"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
      ]),
    });
    const executor = new FakeDriverExecutor({ compileResults: okCompile, runResults: runC1 });

    const result = await runConsistencyVerification(makeJob(), executor, analyzer, { logger: quietLogger });

    expect(result.consistency.coverage.covered).toEqual(["b1", "b3"]);
    expect(result.consistency.coverage.uncovered).toEqual(["b2"]);
    expect(result.augmented).toBe(false);
    // 编排层调用序列:buildBranchInventory → analyzeCases(不调用 generateAugmentations)。
    expect(analyzer.buildBranchInventory).toHaveBeenCalledTimes(1);
    expect(analyzer.analyzeCases).toHaveBeenCalledTimes(1);
    expect(analyzer.generateAugmentations).not.toHaveBeenCalled();
  });

  it("② strictNld=true 时 flag-fail 的 case 改判 fail 计入统计", async () => {
    const analyzer = fakeAnalyzer({
      analyzeCases: vi.fn(async (): Promise<CaseConsistency[]> => [
        { caseId: "c1", touchedBranches: ["b3"], assertionConsistent: false, nldVerdict: "diverges", recommend: "flag-fail", reasons: ["expected 复制了缺陷行为"] },
        { caseId: "c2", touchedBranches: ["b1"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
      ]),
    });
    const executor = new FakeDriverExecutor({
      compileResults: okCompile,
      runResults: resultsStdout([
        { caseId: "c1", value: 3 },
        { caseId: "c2", value: 0 },
      ]),
    });

    const result = await runConsistencyVerification(makeJob(), executor, analyzer, { strictNld: true, logger: quietLogger });

    expect(result.report.failedCases).toBe(1);
    expect(result.report.passedCases).toBe(1);
    const c1 = result.report.comparisons.find((c) => c.caseId === "c1");
    expect(c1?.verdict).toBe("fail");
    expect(c1?.details).toContain("expected 复制了缺陷行为");
    expect(result.consistency.cases[0]?.recommend).toBe("flag-fail");
  });

  it("② strictNld=false(方式 A)时仅报告字段标记,verdict 不变", async () => {
    const analyzer = fakeAnalyzer({
      analyzeCases: vi.fn(async (): Promise<CaseConsistency[]> => [
        { caseId: "c1", touchedBranches: ["b3"], assertionConsistent: false, nldVerdict: "diverges", recommend: "flag-fail", reasons: ["偏离需求"] },
        { caseId: "c2", touchedBranches: ["b1"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
      ]),
    });
    const executor = new FakeDriverExecutor({ compileResults: okCompile, runResults: runC1 });

    const result = await runConsistencyVerification(makeJob(), executor, analyzer, { logger: quietLogger });

    expect(result.report.failedCases).toBe(0);
    expect(result.report.passRate).toBe(1);
    expect(result.report.comparisons.find((c) => c.caseId === "c1")?.verdict).toBe("pass");
    expect(result.consistency.cases[0]?.nldVerdict).toBe("diverges");
    expect(result.consistency.cases[0]?.recommend).toBe("flag-fail");
  });

  it("③ 覆盖缺口触发 augmentation:并入新 case 后 verify 被再次调用且新 case 参与比较", async () => {
    const newCase: import("./description.js").TestCase = {
      id: "a-b2",
      description: "场景:符号相消 / 触发行为:代数正确和 / 目标分支或边界:b2",
      branches: ["b2"],
      inputs: [
        { type: "number", value: 5 },
        { type: "number", value: -3 },
      ],
      expected: { kind: "return", value: { type: "number", value: 2 } },
    };
    const analyzer = fakeAnalyzer({
      analyzeCases: vi.fn(async (): Promise<CaseConsistency[]> => [
        { caseId: "c1", touchedBranches: ["b1"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
        { caseId: "c2", touchedBranches: ["b1"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
      ]),
      generateAugmentations: vi.fn(async () => [newCase]),
    });
    // run 输出固定包含 c1/c2/a-b2(模拟驱动对并入后的描述产出全部结果)。
    const runResults = resultsStdout([
      { caseId: "c1", value: 3 },
      { caseId: "c2", value: 0 },
      { caseId: "a-b2", value: 2 },
    ]);
    const executor = new FakeDriverExecutor({ compileResults: okCompile, runResults });

    const result = await runConsistencyVerification(makeJob(), executor, analyzer, { augmentationBudget: 1, logger: quietLogger });

    expect(result.augmented).toBe(true);
    expect(result.consistency.augmentations).toEqual([newCase]);
    expect(result.report.comparisons.map((c) => c.caseId)).toContain("a-b2");
    // verify 两次 = compile 4 次 + run 4 次。
    expect(executor.compileCalls.length).toBe(4);
    expect(executor.runCalls.length).toBe(4);
    // 新 case 参与差分比较(两侧一致 → pass)。
    const augmented = result.report.comparisons.find((c) => c.caseId === "a-b2");
    expect(augmented?.verdict).toBe("pass");
  });

  it("③ uncovered 为空时不做 augmentation(即使 augmentationBudget > 0)", async () => {
    const analyzer = fakeAnalyzer({
      analyzeCases: vi.fn(async (): Promise<CaseConsistency[]> => [
        { caseId: "c1", touchedBranches: ["b1", "b2", "b3"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
        { caseId: "c2", touchedBranches: ["b1", "b2", "b3"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
      ]),
    });
    const executor = new FakeDriverExecutor({ compileResults: okCompile, runResults: runC1 });

    const result = await runConsistencyVerification(makeJob(), executor, analyzer, { augmentationBudget: 1, logger: quietLogger });

    expect(result.augmented).toBe(false);
    expect(executor.compileCalls.length).toBe(2); // 仅第一轮 verify
    expect(analyzer.generateAugmentations).not.toHaveBeenCalled();
  });
});

describe("buildConsistencyPrompt(调试辅助)", () => {
  it("覆盖缺口分支触发 generateAugmentations 提示词包含 UNCOVERED_BRANCHES", () => {
    const prompt = buildConsistencyPrompt(description(), {
      schemaVersion: "1.0",
      source: { language: "C#", compile: okCompile, run: null, results: null },
      target: { language: "Java", compile: okCompile, run: null, results: null },
      comparisons: [],
      passRate: 1,
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
      divergentCases: 0,
    }, inventory, null);
    expect(prompt).toContain("DIFFERENTIAL_VERIFICATION_REPORT");
    expect(prompt).toContain("BRANCH_INVENTORY");
  });
});
