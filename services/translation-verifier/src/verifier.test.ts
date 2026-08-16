import { describe, expect, it } from "vitest";
import type { TestCase, TestDescription, TypedValue, VerifierLanguage } from "./description.js";
import type { CaseResult, SideResults } from "./result-capture.js";
import type { CompileOutcome, RunOutcome, SideSpec } from "./executor.js";
import { FakeDriverExecutor } from "./executor.js";
import { compareCases } from "./comparator.js";
import { verify } from "./verifier.js";

// ---- 测试辅助 ----

function str(value: string): TypedValue {
  return { type: "string", value };
}

function num(value: number): TypedValue {
  return { type: "number", value };
}

function caseReturn(id: string, value: TypedValue): TestCase {
  return { id, inputs: [], expected: { kind: "return", value } };
}

function description(cases: TestCase[]): TestDescription {
  return {
    schemaVersion: "1.0",
    target: { language: "C#", className: "Util", method: "DoubleIt", isStatic: true, constructorArgs: [] },
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

/** 双侧编译均成功;run 按 side 对象身份分派不同 stdout。 */
function agreeingExecutor(sourceSpec: SideSpec, sourceStdout: string, targetSpec: SideSpec, targetStdout: string): FakeDriverExecutor {
  return new FakeDriverExecutor({
    compileResults: (): CompileOutcome => ({ success: true, errors: [], output: "" }),
    runResults: (sideArg: SideSpec): RunOutcome => {
      const stdout = sideArg === sourceSpec ? sourceStdout : targetStdout;
      return { exitCode: 0, stdout, stderr: "" };
    },
  });
}

describe("verify: 双轨道验证编排器", () => {
  it("1. 双方编译+运行成功且结果一致 → 全 PASS,passRate=1,无 requirementVerdict", async () => {
    const desc = description([caseReturn("c1", str("hi")), caseReturn("c2", num(42))]);
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = agreeingExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("hi")), returnResult("c2", num(42))]),
      targetSpec,
      stdoutFor([returnResult("c1", str("hi")), returnResult("c2", num(42))]),
    );

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    expect(report.schemaVersion).toBe("1.0");
    expect(report.totalCases).toBe(2);
    expect(report.passedCases).toBe(2);
    expect(report.failedCases).toBe(0);
    expect(report.divergentCases).toBe(0);
    expect(report.passRate).toBe(1);
    for (const cmp of report.comparisons) {
      expect(cmp.verdict).toBe("pass");
      expect(cmp.requirementVerdict).toBeUndefined();
    }
  });

  it("2. 源侧返回值与目标侧不同 → FAIL,passRate<1,details 非空", async () => {
    const desc = description([caseReturn("c1", str("x"))]);
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = agreeingExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("x"))]),
      targetSpec,
      stdoutFor([returnResult("c1", str("y"))]),
    );

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    expect(report.passRate).toBeLessThan(1);
    expect(report.failedCases).toBe(1);
    const [cmp] = report.comparisons;
    expect(cmp?.verdict).toBe("fail");
    expect(cmp?.details.length).toBeGreaterThan(0);
    expect(cmp?.details).toContain("return value mismatch");
  });

  it("3. 一侧编译失败 → 该侧 results=null,所有 case DIVERGENT", async () => {
    const desc = description([caseReturn("c1", str("hi"))]);
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = new FakeDriverExecutor({
      compileResults: (sideArg: SideSpec): CompileOutcome =>
        sideArg === sourceSpec
          ? { success: false, errors: ["CS1002: ; expected"], output: "build failed" }
          : { success: true, errors: [], output: "" },
      runResults: (): RunOutcome => ({ exitCode: 0, stdout: stdoutFor([returnResult("c1", str("hi"))]), stderr: "" }),
    });

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    expect(report.source.compile.success).toBe(false);
    expect(report.source.results).toBeNull();
    expect(report.source.run).toBeNull();
    expect(report.target.results).not.toBeNull();
    expect(report.divergentCases).toBe(1);
    expect(report.passedCases).toBe(0);
    expect(report.comparisons[0]?.verdict).toBe("divergent");
  });

  it("4. 一侧运行失败(exitCode≠0)→ DIVERGENT", async () => {
    const desc = description([caseReturn("c1", str("hi"))]);
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = new FakeDriverExecutor({
      compileResults: (): CompileOutcome => ({ success: true, errors: [], output: "" }),
      runResults: (sideArg: SideSpec): RunOutcome =>
        sideArg === sourceSpec
          ? { exitCode: 0, stdout: stdoutFor([returnResult("c1", str("hi"))]), stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "Exception in thread main: boom" },
    });

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    expect(report.target.run?.exitCode).toBe(1);
    expect(report.target.results).toBeNull();
    expect(report.divergentCases).toBe(1);
    expect(report.comparisons[0]?.verdict).toBe("divergent");
  });

  it("5. 驱动输出解析失败 → parseErrors 进报告,所有 case DIVERGENT", async () => {
    const desc = description([caseReturn("c1", str("hi"))]);
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = agreeingExecutor(sourceSpec, "not-json", targetSpec, stdoutFor([returnResult("c1", str("hi"))]));

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    expect(report.source.results?.parseErrors.length).toBeGreaterThan(0);
    expect(report.source.results?.results).toEqual([]);
    expect(report.divergentCases).toBe(1);
    expect(report.comparisons[0]?.verdict).toBe("divergent");
  });

  it("6. 两侧一致但都不符合声明的 expected → 黄金校验改判 fail('declared expectation mismatch'),无 requirementVerdict", async () => {
    const desc = description([caseReturn("c1", str("y"))]); // expected="y",两侧实际都返回 "x"
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = agreeingExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("x"))]),
      targetSpec,
      stdoutFor([returnResult("c1", str("x"))]),
    );

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    const [cmp] = report.comparisons;
    expect(cmp?.verdict).toBe("fail");
    expect(cmp?.details).toContain("declared expectation mismatch");
    expect(cmp?.requirementVerdict).toBeUndefined();
    expect(report.failedCases).toBe(1);
  });

  it("7. 报告字段齐全且计数正确(pass/fail/divergent 混合)", async () => {
    const desc = description([
      caseReturn("c1", str("z")), // pass:两侧都返回 z 且符合 expected
      caseReturn("c2", str("y")), // fail:两侧不一致
      caseReturn("c3", str("w")), // divergent:源侧缺此 case
    ]);
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = agreeingExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("z")), returnResult("c2", str("x"))]),
      targetSpec,
      stdoutFor([returnResult("c1", str("z")), returnResult("c2", str("y")), returnResult("c3", str("w"))]),
    );

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    expect(report.schemaVersion).toBe("1.0");
    expect(report.totalCases).toBe(3);
    expect(report.passedCases).toBe(1);
    expect(report.failedCases).toBe(1);
    expect(report.divergentCases).toBe(1);
    expect(report.passRate).toBeCloseTo(1 / 3);
    expect(report.source).toMatchObject({ language: "C#" });
    expect(report.target).toMatchObject({ language: "Java" });
  });

  it("8. caseId 顺序与描述 cases 顺序一致(两侧驱动输出乱序时仍按描述顺序排序)", async () => {
    const desc = description([caseReturn("a1", str("1")), caseReturn("b2", str("2")), caseReturn("c3", str("3"))]);
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    // 目标侧驱动输出乱序(任务指定);源侧也乱序 —— compareCases 按 caseId 集合迭代时
    // 先取源侧顺序,若 verifier 末尾不按描述 case 顺序排序,comparisons 顺序会泄漏源侧
    // 驱动顺序(b2→a1→c3),断言即失败;排序守卫由此真实(删除 sort 必须让本测试失败)。
    const executor = agreeingExecutor(
      sourceSpec,
      stdoutFor([returnResult("b2", str("2")), returnResult("a1", str("1")), returnResult("c3", str("3"))]),
      targetSpec,
      stdoutFor([returnResult("c3", str("3")), returnResult("b2", str("2")), returnResult("a1", str("1"))]),
    );

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    expect(report.comparisons.map((c) => c.caseId)).toEqual(["a1", "b2", "c3"]);
  });

  it("9. 需求裁决(差异探测器):两侧不一致、目标侧符合 expected → verdict 保持 fail 且 requirementVerdict=target-conforms", async () => {
    const desc = description([caseReturn("c1", str("y"))]); // 需求黄金值 = "y"(与目标侧一致)
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = agreeingExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("x"))]),
      targetSpec,
      stdoutFor([returnResult("c1", str("y"))]),
    );

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    const [cmp] = report.comparisons;
    expect(cmp?.verdict).toBe("fail");
    expect(cmp?.requirementVerdict).toBe("target-conforms");
    expect(cmp?.details[0]).toBe("target matches declared requirement; divergence is source-side");
  });

  it("10. 需求裁决(目标侧也偏离):两侧不一致、expected 与两侧都不同 → requirementVerdict=target-diverges", async () => {
    const desc = description([caseReturn("c1", str("z"))]); // 需求黄金值 = "z",两侧分别返回 x / y
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = agreeingExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("x"))]),
      targetSpec,
      stdoutFor([returnResult("c1", str("y"))]),
    );

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    const [cmp] = report.comparisons;
    expect(cmp?.verdict).toBe("fail");
    expect(cmp?.requirementVerdict).toBe("target-diverges");
    expect(cmp?.details).toContain("declared expectation mismatch");
    // 需求裁决不改变 verdict
    expect(report.failedCases).toBe(1);
  });

  it("11. 两侧一致且符合 expected → pass,requirementVerdict 可选字段不出现", async () => {
    const desc = description([caseReturn("c1", str("hi"))]);
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = agreeingExecutor(
      sourceSpec,
      stdoutFor([returnResult("c1", str("hi"))]),
      targetSpec,
      stdoutFor([returnResult("c1", str("hi"))]),
    );

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    expect(report.comparisons[0]?.verdict).toBe("pass");
    expect(report.comparisons[0]?.requirementVerdict).toBeUndefined();
    expect("requirementVerdict" in report.comparisons[0]!).toBe(false);
  });

  it("12. 两侧驱动输出均解析失败 → 兜底为全部 case DIVERGENT,totalCases=描述 case 数", async () => {
    const desc = description([caseReturn("c1", str("hi")), caseReturn("c2", num(42))]);
    const sourceSpec = side("C#", "source");
    const targetSpec = side("Java", "target");
    const executor = agreeingExecutor(sourceSpec, "not-json", targetSpec, "not-json");

    const report = await verify({ description: desc, source: sourceSpec, target: targetSpec }, executor);

    expect(report.source.results?.parseErrors.length).toBeGreaterThan(0);
    expect(report.target.results?.parseErrors.length).toBeGreaterThan(0);
    expect(report.totalCases).toBe(desc.cases.length);
    expect(report.divergentCases).toBe(desc.cases.length);
    expect(report.passedCases).toBe(0);
    expect(report.failedCases).toBe(0);
    for (const cmp of report.comparisons) {
      expect(cmp.verdict).toBe("divergent");
    }
    expect(report.comparisons.map((c) => c.caseId)).toEqual(["c1", "c2"]);
    const details = report.comparisons.flatMap((c) => c.details);
    expect(details).toContain("Source side produced no usable results.");
    expect(details).toContain("Target side produced no usable results.");
  });

  it("comparator 自身保持差异探测器语义:compareCases 的 CaseComparison 不带 requirementVerdict", () => {
    const source: SideResults = { side: "source", results: [returnResult("c1", str("x"))], rawStdout: "", parseErrors: [] };
    const target: SideResults = { side: "target", results: [returnResult("c1", str("y"))], rawStdout: "", parseErrors: [] };
    const [cmp] = compareCases(source, target);
    expect(cmp.verdict).toBe("fail");
    expect(cmp.requirementVerdict).toBeUndefined();
  });
});
