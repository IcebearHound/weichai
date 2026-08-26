/**
 * quality 指标层单测:CSR 编译、conformance 三态解析、检出/误报判定、聚合统计。
 * 全部使用 fake executor + 合成报告(纯函数级),不依赖真实工具链。
 */
import { describe, expect, it } from "vitest";
import { FakeDriverExecutor } from "../executor.js";
import type { VerificationReport } from "../verifier.js";
import type { TestDescription } from "../description.js";
import type { DatasetEntry, GeneratedTest, PerEntryResult } from "./types.js";
import {
  buildConformancePrompt,
  compileGeneratedTest,
  detectFromDifferential,
  detectRunnerDifferential,
  falsePositiveFromClean,
  injectBug,
  parseConformanceVerdict,
  smokeReportHasBugSignal,
  targetViolations,
} from "./metrics.js";
import { aggregateMetrics, sampleEntries, defaultBugKinds } from "./evaluate.js";
import type { QualityDataset } from "./types.js";

// ---------------------------------------------------------------------------
// 共享 fixture
// ---------------------------------------------------------------------------

const ENTRY: DatasetEntry = {
  id: "e1",
  requirement: "返回输入 + 1;非法输入抛异常。",
  source: { language: "Java", file: "src/ParameterParser.java", className: "ParameterParser", method: "parse" },
  target: { language: "C#", file: "src/Target.cs", className: "Target", method: "Compute", isStatic: true, constructorArgs: [] },
  requirementDiffs: ["需求明确:空输入抛异常;检索代码返回 null(历史缺陷)。"],
};

const DESCRIPTION: TestDescription = {
  schemaVersion: "1.0",
  requirement: ENTRY.requirement,
  target: { language: "C#", className: "Target", method: "Compute", isStatic: true, constructorArgs: [] },
  cases: [
    {
      id: "c01",
      inputs: [{ type: "number", value: 1 }],
      expected: { kind: "return", value: { type: "number", value: 42 } },
    },
  ],
};

const DESCRIPTION_TEST: GeneratedTest = { kind: "description", description: DESCRIPTION, meta: { llmCalls: 1 } };

/** 合成 VerificationReport(comparisons 可注入)。 */
function makeReport(comparisons: VerificationReport["comparisons"], targetCompileOk = true, sourceUsable = true): VerificationReport {
  const usableResults = { side: "source" as const, results: [{ caseId: "c01", outcome: "return" as const, returnValue: { type: "number" as const, value: 42 } }], rawStdout: "", parseErrors: [] as string[] };
  return {
    schemaVersion: "1.0",
    source: {
      language: "Java",
      compile: { success: sourceUsable, errors: [], output: "" },
      run: sourceUsable ? { exitCode: 0, stdout: "", stderr: "" } : null,
      results: sourceUsable ? usableResults : null,
    },
    target: {
      language: "C#",
      compile: { success: targetCompileOk, errors: [], output: "" },
      run: targetCompileOk ? { exitCode: 0, stdout: "", stderr: "" } : null,
      results: targetCompileOk ? usableResults : null,
    },
    comparisons,
    passRate: 0,
    totalCases: comparisons.length,
    passedCases: 0,
    failedCases: 0,
    divergentCases: 0,
  };
}

const comparison = (verdict: "pass" | "fail" | "divergent", requirementVerdict?: "target-conforms" | "target-diverges") => ({
  caseId: "c01",
  verdict,
  source: null,
  target: null,
  details: [],
  ...(requirementVerdict === undefined ? {} : { requirementVerdict }),
});

// ---------------------------------------------------------------------------
// conformance 三态解析
// ---------------------------------------------------------------------------

describe("parseConformanceVerdict", () => {
  it("解析 conforms", () => {
    expect(parseConformanceVerdict('{"verdict":"conforms","reasoning":"符合需求"}')).toEqual({
      verdict: "conforms",
      reasoning: "符合需求",
    });
  });

  it("解析 diverges(fenced 容错)", () => {
    expect(parseConformanceVerdict('```json\n{"verdict":"diverges","reasoning":"照抄了检索代码"}\n```')).toEqual({
      verdict: "diverges",
      reasoning: "照抄了检索代码",
    });
  });

  it("解析 unverified", () => {
    expect(parseConformanceVerdict('{"verdict":"unverified","reasoning":"需求不明确"}').verdict).toBe("unverified");
  });

  it("垃圾输入回退 unverified", () => {
    expect(parseConformanceVerdict("no json here").verdict).toBe("unverified");
    expect(parseConformanceVerdict("").verdict).toBe("unverified");
  });

  it("非法 verdict 回退 unverified", () => {
    expect(parseConformanceVerdict('{"verdict":"maybe","reasoning":"x"}').verdict).toBe("unverified");
  });
});

// ---------------------------------------------------------------------------
// conformance prompt 构造
// ---------------------------------------------------------------------------

describe("buildConformancePrompt", () => {
  it("包含需求、需求差异标注、检索代码、生成的测试", () => {
    const prompt = buildConformancePrompt(DESCRIPTION_TEST, {
      entry: ENTRY,
      source: { language: "Java", driverSource: "", sourceFiles: [{ relativePath: "S.java", content: "// source" }] },
      target: { language: "C#", driverSource: "", sourceFiles: [{ relativePath: "T.cs", content: "// target" }] },
    });
    expect(prompt).toContain(ENTRY.requirement);
    expect(prompt).toContain("非法输入抛异常");
    expect(prompt).toContain("// source");
    expect(prompt).toContain("// target");
    expect(prompt).toContain("GENERATED_TEST");
    expect(prompt).toContain('"verdict"');
  });
});

// ---------------------------------------------------------------------------
// 目标违规(检出/误报信号)
// ---------------------------------------------------------------------------

describe("targetViolations", () => {
  it("target-diverges 计入违规", () => {
    const violations = targetViolations(makeReport([comparison("fail", "target-diverges")]));
    expect(violations).toEqual(["c01"]);
  });

  it("黄金改判 fail(无 requirementVerdict)计入违规", () => {
    const violations = targetViolations(makeReport([comparison("fail")]));
    expect(violations).toEqual(["c01"]);
  });

  it("target-conforms 不计入违规(需求差异合法)", () => {
    const violations = targetViolations(makeReport([comparison("fail", "target-conforms")]));
    expect(violations).toEqual([]);
  });

  it("pass 不计入违规", () => {
    expect(targetViolations(makeReport([comparison("pass")]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 检出判定
// ---------------------------------------------------------------------------

describe("detectFromDifferential", () => {
  it("注入目标违规且干净目标无违规 → 检出", () => {
    const clean = { report: makeReport([comparison("pass")]) };
    const buggy = makeReport([comparison("fail", "target-diverges")]);
    expect(detectFromDifferential(clean, buggy, "off-by-one")).toEqual({ kind: "off-by-one", detected: true });
  });

  it("干净目标已有违规 → clean-already-violating(排除,不算漏检)", () => {
    const clean = { report: makeReport([comparison("fail", "target-diverges")]) };
    const buggy = makeReport([comparison("fail", "target-diverges")]);
    const trial = detectFromDifferential(clean, buggy, "fixed-value");
    expect(trial.detected).toBe(false);
    expect(trial.note).toBe("clean-already-violating");
  });

  it("注入目标 target-conforms(需求差异)不算检出", () => {
    const clean = { report: makeReport([comparison("pass")]) };
    const buggy = makeReport([comparison("fail", "target-conforms")]);
    expect(detectFromDifferential(clean, buggy, "off-by-one").detected).toBe(false);
  });

  it("注入目标编译失败 → note", () => {
    const clean = { report: makeReport([comparison("pass")]) };
    const buggy = makeReport([comparison("divergent")], false);
    const trial = detectFromDifferential(clean, buggy, "condition-flip");
    expect(trial.detected).toBe(false);
    expect(trial.note).toBe("target-compile-failed");
  });

  it("干净报告不可用 → note", () => {
    const clean = { report: null, note: "source-run-failed" };
    const buggy = makeReport([comparison("fail", "target-diverges")]);
    expect(detectFromDifferential(clean, buggy, "off-by-one").note).toBe("source-run-failed");
  });
});

// ---------------------------------------------------------------------------
// 误报判定
// ---------------------------------------------------------------------------

describe("falsePositiveFromClean", () => {
  it("干净目标无违规 → 不误报", () => {
    expect(falsePositiveFromClean({ report: makeReport([comparison("pass")]) })).toEqual({ falsePositive: false });
  });

  it("干净目标违规 → 误报", () => {
    expect(falsePositiveFromClean({ report: makeReport([comparison("fail", "target-diverges")]) })).toEqual({ falsePositive: true });
  });

  it("干净目标不可用 → note", () => {
    expect(falsePositiveFromClean({ report: null, note: "target-compile-failed" }).note).toBe("target-compile-failed");
  });
});

// ---------------------------------------------------------------------------
// 冒烟检出信号
// ---------------------------------------------------------------------------

describe("smokeReportHasBugSignal", () => {
  it("任一 case translation-bug → 检出信号", () => {
    const report = {
      converged: false,
      steps: 3,
      rounds: 0,
      cases: [
        { caseId: "c01", intent: "", source: null, target: null, mechanical: "pass" as const, decision: "translation-bug" as const, reasoning: "x" },
      ],
      targetFiles: [],
      sourceIssues: [],
      summary: "",
    };
    expect(smokeReportHasBugSignal(report)).toBe(true);
  });

  it("全 pass → 无检出信号", () => {
    const report = {
      converged: true,
      steps: 3,
      rounds: 0,
      cases: [{ caseId: "c01", intent: "", source: null, target: null, mechanical: "pass" as const, decision: "pass" as const, reasoning: "x" }],
      targetFiles: [],
      sourceIssues: [],
      summary: "",
    };
    expect(smokeReportHasBugSignal(report)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CSR 编译(描述型 + runner 型,fake executor)
// ---------------------------------------------------------------------------

describe("compileGeneratedTest", () => {
  it("描述型:驱动 + 目标模块编译,compile 调用带 C# 驱动", async () => {
    const executor = new FakeDriverExecutor({
      compileResults: { success: true, errors: [], output: "" },
      runResults: { exitCode: 0, stdout: "{}", stderr: "" },
    });
    const task = {
      entry: ENTRY,
      source: { language: "Java" as const, driverSource: "", sourceFiles: [{ relativePath: "S.java", content: "// s" }] },
      target: { language: "C#" as const, driverSource: "", sourceFiles: [{ relativePath: "Target.cs", content: "// t" }] },
    };
    const outcome = await compileGeneratedTest(DESCRIPTION_TEST, task, executor);
    expect(outcome.success).toBe(true);
    const side = executor.compileCalls[0];
    expect(side).toBeDefined();
    expect(side!.language).toBe("C#");
    expect(side!.driverSource).toContain("public class Driver_");
    expect(side!.sourceFiles.map((f) => f.relativePath)).toContain("Target.cs");
  });

  it("runner 型:runner 驱动 + 模块编译", async () => {
    const executor = new FakeDriverExecutor({
      compileResults: { success: true, errors: [], output: "" },
      runResults: { exitCode: 0, stdout: "{}", stderr: "" },
    });
    const runnerTest: GeneratedTest = {
      kind: "runner",
      runner: {
        language: "C#",
        files: [{ path: "Driver.cs", content: "public class Driver { }" }],
      },
      meta: { llmCalls: 9 },
    };
    const task = {
      entry: ENTRY,
      source: { language: "Java" as const, driverSource: "", sourceFiles: [] },
      target: { language: "C#" as const, driverSource: "", sourceFiles: [{ relativePath: "Target.cs", content: "// t" }] },
    };
    const outcome = await compileGeneratedTest(runnerTest, task, executor);
    expect(outcome.success).toBe(true);
    expect(executor.compileCalls[0]!.driverSource).toContain("public class Driver");
    expect(executor.compileCalls[0]!.sourceFiles.map((f) => f.relativePath)).toContain("Target.cs");
  });

  it("空产物 → 编译失败", async () => {
    const executor = new FakeDriverExecutor({
      compileResults: { success: true, errors: [], output: "" },
      runResults: { exitCode: 0, stdout: "{}", stderr: "" },
    });
    const empty: GeneratedTest = { kind: "runner", runner: { language: "C#", files: [] }, meta: { llmCalls: 0 } };
    const outcome = await compileGeneratedTest(empty, {
      entry: ENTRY,
      source: { language: "Java", driverSource: "", sourceFiles: [] },
      target: { language: "C#", driverSource: "", sourceFiles: [] },
    }, executor);
    expect(outcome.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runner 机械差分检出(干净 vs 注入,同一 runner)
// ---------------------------------------------------------------------------

describe("detectRunnerDifferential", () => {
  it("注入目标行为改变 → 检出", async () => {
    const executor = new FakeDriverExecutor({
      compileResults: { success: true, errors: [], output: "" },
      runResults: (side) => {
        const module = side.sourceFiles.find((f) => f.relativePath === "Target.cs")?.content ?? "";
        const buggy = module.includes("-999");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            results: [
              { caseId: "c01", outcome: "return", returnValue: { type: "number", value: buggy ? -999 : 42 } },
            ],
          }),
          stderr: "",
        };
      },
    });
    const runnerTest: GeneratedTest = {
      kind: "runner",
      runner: {
        language: "C#",
        files: [{ path: "Driver.cs", content: "public class Driver { }" }],
      },
      meta: { llmCalls: 9 },
    };
    const task = {
      entry: ENTRY,
      source: { language: "Java" as const, driverSource: "", sourceFiles: [] },
      target: { language: "C#" as const, driverSource: "", sourceFiles: [{ relativePath: "Target.cs", content: "public class Target { }" }] },
    };
    const buggy = "public class Target { public static int Compute(int v) { return -999; } }";
    const trial = await detectRunnerDifferential(runnerTest, task, executor, buggy, "fixed-value");
    expect(trial.detected).toBe(true);
  });

  it("注入目标编译失败 → note", async () => {
    const executor = new FakeDriverExecutor({
      compileResults: (side) =>
        side.sourceFiles.some((f) => f.content === "y")
          ? { success: false, errors: ["CS0001"], output: "err" }
          : { success: true, errors: [], output: "" },
      runResults: { exitCode: 0, stdout: JSON.stringify({ results: [{ caseId: "c01", outcome: "return", returnValue: { type: "number", value: 42 } }] }), stderr: "" },
    });
    const runnerTest: GeneratedTest = {
      kind: "runner",
      runner: { language: "C#", files: [{ path: "Driver.cs", content: "public class Driver { }" }] },
      meta: { llmCalls: 1 },
    };
    const task = {
      entry: ENTRY,
      source: { language: "Java" as const, driverSource: "", sourceFiles: [] },
      target: { language: "C#" as const, driverSource: "", sourceFiles: [{ relativePath: "Target.cs", content: "x" }] },
    };
    const trial = await detectRunnerDifferential(runnerTest, task, executor, "y", "off-by-one");
    expect(trial.note).toBe("target-compile-failed");
  });
});

// ---------------------------------------------------------------------------
// bug 注入(复用 bug-injection.ts)
// ---------------------------------------------------------------------------

describe("injectBug", () => {
  const CSHARP_SOURCE = `public class Target {
  public static int Compute(int value) {
    if (value > 10) return value * 2;
    return value + 1;
  }
}`;

  it("fixed-value 注入:方法体替换为错误返回值", () => {
    const result = injectBug(CSHARP_SOURCE, "fixed-value", ENTRY);
    expect(result.note).toBeUndefined();
    expect(result.source).toContain("return -999;");
    expect(result.source).not.toContain("value * 2");
  });

  it("off-by-one 注入:比较运算符移位", () => {
    const result = injectBug(CSHARP_SOURCE, "off-by-one", ENTRY);
    expect(result.source).toContain("value >= 10");
  });

  it("方法不存在 → note", () => {
    const result = injectBug(CSHARP_SOURCE, "fixed-value", { ...ENTRY, target: { ...ENTRY.target, method: "Missing" } });
    expect(result.note).toContain("注入失败");
    expect(result.source).toBe(CSHARP_SOURCE);
  });

  it("无可替换 token 的策略 → 注入失败，而不是把原目标计入检出率", () => {
    const noMutationPoint = `public class Target {
  public static string Compute(string value) {
    return value;
  }
}`;
    const result = injectBug(noMutationPoint, "off-by-one", ENTRY);
    expect(result.note).toContain("注入失败");
    expect(result.source).toBe(noMutationPoint);
  });
});

// ---------------------------------------------------------------------------
// 抽样与聚合
// ---------------------------------------------------------------------------

const DATASET: QualityDataset = {
  schemaVersion: "1.0",
  source: "test",
  entries: Array.from({ length: 10 }, (_, i) => ({
    ...ENTRY,
    id: `e${String(i).padStart(2, "0")}`,
    requirement: `req-${i}`,
  })),
};

describe("sampleEntries / defaultBugKinds", () => {
  it("full 模式返回全部 entry", () => {
    expect(sampleEntries(DATASET, "full", 5)).toHaveLength(10);
  });

  it("quick 模式等距抽样 sampleSize 个", () => {
    const sampled = sampleEntries(DATASET, "quick", 4);
    expect(sampled).toHaveLength(4);
    expect(sampled.map((e) => e.id)).toEqual(["e00", "e02", "e05", "e07"]);
  });

  it("quick 模式默认 1 策略,full 模式 4 策略", () => {
    expect(defaultBugKinds("quick")).toEqual(["off-by-one"]);
    expect(defaultBugKinds("full")).toHaveLength(4);
  });
});

describe("aggregateMetrics", () => {
  const entry = (id: string, partial: Partial<PerEntryResult>): PerEntryResult => ({
    entryId: id,
    generated: true,
    csr: true,
    conformance: { verdict: "conforms", reasoning: "" },
    detections: [],
    falsePositive: false,
    llmCalls: 1,
    ...partial,
  });

  it("汇总五维:报告所有注入尝试，检出率只使用 eligible 试验", () => {
    const metrics = aggregateMetrics([
      entry("a", {
        csr: true,
        conformance: { verdict: "conforms", reasoning: "" },
        detections: [
          { kind: "off-by-one", detected: true },
          { kind: "fixed-value", detected: false },
        ],
        falsePositive: false,
        llmCalls: 2,
      }),
      entry("b", {
        csr: false,
        conformance: { verdict: "diverges", reasoning: "" },
        detections: [
          { kind: "off-by-one", detected: false, note: "target-compile-failed", status: "unverified" },
          { kind: "fixed-value", detected: false, note: "injection failed", status: "injection-failed" },
        ],
        falsePositive: true,
        llmCalls: 1,
      }),
    ]);
    expect(metrics.csr).toBe(0.5);
    expect(metrics.conformance.rate).toBe(0.5);
    expect(metrics.detectionRate).toBe(0.5); // 1 检出 / 2 eligible
    expect(metrics.detection).toEqual({ attempted: 4, eligible: 2, injectionFailed: 1, unverified: 1, detected: 1 });
    expect(metrics.falsePositiveRate).toBe(0.5);
    expect(metrics.llmCalls).toBe(3);
  });

  it("无有效试验时各率为 0", () => {
    const metrics = aggregateMetrics([
      entry("a", { detections: [{ kind: "off-by-one", detected: false, note: "no-runner" }] }),
    ]);
    expect(metrics.detectionRate).toBe(0);
    expect(metrics.detection).toEqual({ attempted: 1, eligible: 0, injectionFailed: 0, unverified: 1, detected: 0 });
    expect(metrics.csr).toBe(1);
  });

  it("生成失败 entry 不计入 CSR 分母", () => {
    const metrics = aggregateMetrics([
      entry("a", { generated: false, error: "generate-failed", csr: false, conformance: null }),
    ]);
    expect(metrics.csr).toBe(0);
  });
});
