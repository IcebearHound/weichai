import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDriverExecutor, type CompileOutcome, type RunOutcome } from "./executor.js";
import { createLogger } from "./logger.js";
import type { SmokeContextState } from "./smoke-types.js";
import { SmokeTools, buildSideSpec, splitDriverEntry, validateRunnerContract } from "./smoke-tools.js";

// ---- 测试辅助 ----

function makeState(overrides: Partial<SmokeContextState> = {}): SmokeContextState {
  return {
    requirement: "解码 MIME 文本",
    sourceLang: "C#",
    targetLang: "Java",
    sourceRoot: "/src",
    targetRoot: "/tgt",
    sourceModuleFiles: [{ relativePath: "MimeUtility.cs", content: "public static class MimeUtility {}" }],
    targetModuleFiles: [{ relativePath: "MimeUtility.java", content: "public class MimeUtility {}" }],
    plan: [],
    runners: { source: null, target: null },
    compile: { source: null, target: null },
    run: { source: null, target: null },
    comparisons: null,
    decisions: [],
    sourceIssues: [],
    rounds: 0,
    steps: 0,
    finished: false,
    summary: "",
    compileFailures: { source: 0, target: 0 },
    ...overrides,
  };
}

const okCompile: CompileOutcome = { success: true, errors: [], output: "" };
const failCompile: CompileOutcome = { success: false, errors: ["error: cannot find symbol"], output: "javac output" };
const okRun: RunOutcome = { exitCode: 0, stdout: "", stderr: "" };

/** 标准 run stdout:与 plan 的 caseId 一一对应。 */
const runStdout = JSON.stringify({
  results: [
    { caseId: "c01", outcome: "return", returnValue: { type: "string", value: "hello" } },
    { caseId: "c02", outcome: "exception", exceptionType: "NullReferenceException", exceptionMessage: "null" },
  ],
});

function makeTools(
  state: SmokeContextState,
  options: { compileResults?: CompileOutcome | ((s: unknown) => CompileOutcome); runResults?: RunOutcome | ((s: unknown) => RunOutcome) } = {},
): { tools: SmokeTools; executor: FakeDriverExecutor } {
  const executor = new FakeDriverExecutor({
    compileResults: options.compileResults ?? okCompile,
    runResults: options.runResults ?? { exitCode: 0, stdout: runStdout, stderr: "" },
  });
  const tools = new SmokeTools(state, { executor, logger: createLogger("smoke-tools-test", { disabled: true }) });
  return { tools, executor };
}

/** 写入一个含合法 runner 的状态(源=Driver.cs,目标=SmokeRunner.java)。 */
function withRunners(state: SmokeContextState): SmokeContextState {
  return {
    ...state,
    runners: {
      source: [{ path: "Driver.cs", content: "public class SmokeDriver { public static void Main() {} }" }],
      target: [
        {
          path: "SmokeRunner.java",
          content: "public class SmokeRunner { public static void main(String[] args) {} }",
        },
      ],
    },
  };
}

const C_SOURCE_RUNNER = "public class SmokeDriver { public static void Main() {} }";
const JAVA_TARGET_RUNNER = "public class SmokeRunner { public static void main(String[] args) {} }";

describe("SmokeTools:list_files / read_file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smoke-tools-test-"));
    writeFileSync(join(dir, "a.cs"), "a", "utf-8");
    writeFileSync(join(dir, "b.cs"), "b", "utf-8");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("list_files 列出目录条目并过滤构建目录/隐藏文件", async () => {
    const state = makeState({ sourceRoot: dir });
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({ action: "list_files", params: { path: "." } });
    expect(obs).toContain("a.cs");
    expect(obs).toContain("b.cs");
  });

  it("read_file 读取文件内容;超过 20KB 截断并带标记", async () => {
    const state = makeState({ sourceRoot: dir });
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({ action: "read_file", params: { path: "a.cs" } });
    expect(obs).toContain("a.cs");

    const big = "x".repeat(30_000);
    writeFileSync(join(dir, "big.cs"), big, "utf-8");
    const bigObs = await tools.dispatch({ action: "read_file", params: { path: "big.cs" } });
    expect(bigObs).toContain("[truncated");
  });

  it("路径超出源/目标根目录 → 错误 observation", async () => {
    const state = makeState({ sourceRoot: dir });
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({ action: "read_file", params: { path: "/etc/passwd" } });
    expect(obs).toMatch(/超出允许范围/);
  });
});

describe("SmokeTools:plan_smoke / write_runner", () => {
  it("plan_smoke 记录用例计划;空 id / 重复 id 报错", async () => {
    const state = makeState();
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({
      action: "plan_smoke",
      params: { cases: [{ id: "c01", intent: "空输入" }, { id: "c02", intent: "正常路径" }] },
    });
    expect(obs).toContain("已记录冒烟用例计划");
    expect(state.plan).toHaveLength(2);

    const dup = await tools.dispatch({ action: "plan_smoke", params: { cases: [{ id: "c01", intent: "x" }, { id: "c01", intent: "y" }] } });
    expect(dup).toMatch(/重复/);
    const empty = await tools.dispatch({ action: "plan_smoke", params: { cases: [{ id: " ", intent: "x" }] } });
    expect(empty).toMatch(/不能为空/);
  });

  it("write_runner:C# 缺 Driver.cs / Driver.cs 无 public class → 契约校验报错", async () => {
    const state = makeState();
    const { tools } = makeTools(state);
    const noDriver = await tools.dispatch({
      action: "write_runner",
      params: { side: "source", language: "C#", files: [{ path: "Other.cs", content: "class X {}" }] },
    });
    expect(noDriver).toMatch(/Driver\.cs/);

    const noPublicClass = await tools.dispatch({
      action: "write_runner",
      params: { side: "source", language: "C#", files: [{ path: "Driver.cs", content: "class X {}" }] },
    });
    expect(noPublicClass).toMatch(/public class/);
  });

  it("write_runner:Python 缺 driver.py / TS 缺 driver.ts / Java 缺 main → 契约校验报错", async () => {
    const state = makeState();
    const { tools } = makeTools(state);
    expect(await tools.dispatch({ action: "write_runner", params: { side: "source", language: "Python", files: [{ path: "x.py", content: "" }] } })).toMatch(/driver\.py/);
    expect(await tools.dispatch({ action: "write_runner", params: { side: "source", language: "TypeScript", files: [{ path: "x.ts", content: "" }] } })).toMatch(/driver\.ts/);
    expect(
      await tools.dispatch({ action: "write_runner", params: { side: "target", language: "Java", files: [{ path: "X.java", content: "public class X {}" }] } }),
    ).toMatch(/main/);
  });

  it("write_runner:Java 文件名与 public 类名不一致 → 契约校验报错", async () => {
    const state = makeState();
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({
      action: "write_runner",
      params: { side: "target", language: "Java", files: [{ path: "Wrong.java", content: "public class Right { public static void main(String[] a) {} }" }] },
    });
    expect(obs).toMatch(/Right\.java/);
  });

  it("write_runner:合法 runner 被记录并重置该侧编译/运行结果", async () => {
    const state = withRunners(makeState());
    state.compile.source = okCompile;
    state.run.source = { side: "source", results: [], rawStdout: "", parseErrors: [] };
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({
      action: "write_runner",
      params: { side: "source", language: "C#", files: [{ path: "Driver.cs", content: C_SOURCE_RUNNER }] },
    });
    expect(obs).toContain("已记录源侧 runner");
    expect(state.runners.source).toHaveLength(1);
    expect(state.compile.source).toBeNull();
    expect(state.run.source).toBeNull();
  });
});

describe("SmokeTools:compile_runner / run_runner / compare", () => {
  it("compile_runner:runner 未就绪 → 前置条件错误", async () => {
    const state = makeState();
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({ action: "compile_runner", params: { side: "source" } });
    expect(obs).toMatch(/前置条件未满足/);
  });

  it("compile_runner:成功/失败 observation;失败计数,成功清零", async () => {
    const state = withRunners(makeState());
    const failExecutor = new FakeDriverExecutor({ compileResults: failCompile, runResults: okRun });
    const failTools = new SmokeTools(state, { executor: failExecutor, logger: createLogger("t", { disabled: true }) });

    const failObs = await failTools.dispatch({ action: "compile_runner", params: { side: "source" } });
    expect(failObs).toContain("编译失败");
    expect(state.compileFailures.source).toBe(1);

    // 换成成功执行器
    const okExecutor = new FakeDriverExecutor({ compileResults: okCompile, runResults: okRun });
    const okTools = new SmokeTools(state, { executor: okExecutor, logger: createLogger("t", { disabled: true }) });
    const okObs = await okTools.dispatch({ action: "compile_runner", params: { side: "source" } });
    expect(okObs).toContain("编译成功");
    expect(state.compileFailures.source).toBe(0);
    expect(state.compile.source?.success).toBe(true);
  });

  it("compile_runner:失败达 3 次上限后不再编译", async () => {
    const state = withRunners(makeState({ compileFailures: { source: 3, target: 0 } }));
    const executor = new FakeDriverExecutor({ compileResults: failCompile, runResults: okRun });
    const tools = new SmokeTools(state, { executor, logger: createLogger("t", { disabled: true }) });
    const obs = await tools.dispatch({ action: "compile_runner", params: { side: "source" } });
    expect(obs).toMatch(/已达.*上限/);
    expect(executor.compileCalls).toHaveLength(0);
  });

  it("run_runner:compile 未成功 → 前置条件错误;成功 → 逐 case 结果摘要", async () => {
    const state = withRunners(makeState());
    const { tools } = makeTools(state);
    const before = await tools.dispatch({ action: "run_runner", params: { side: "source" } });
    expect(before).toMatch(/尚未编译成功/);

    state.compile.source = okCompile;
    const obs = await tools.dispatch({ action: "run_runner", params: { side: "source" } });
    expect(obs).toContain("运行(源侧)成功");
    expect(obs).toContain("[c01] return");
    expect(obs).toContain("[c02] exception NullReferenceException");
    expect(state.run.source?.results).toHaveLength(2);
  });

  it("run_runner:运行退出码非 0 → 错误 observation", async () => {
    const state = withRunners(makeState({ compile: { source: okCompile, target: okCompile } }));
    const { tools } = makeTools(state, { runResults: { exitCode: 1, stdout: "", stderr: "boom" } });
    const obs = await tools.dispatch({ action: "run_runner", params: { side: "source" } });
    expect(obs).toMatch(/运行失败/);
    expect(state.run.source).toBeNull();
  });

  it("compare:双侧未运行 → 前置条件错误;双侧就绪 → 逐 case verdict", async () => {
    const state = withRunners(makeState());
    const { tools } = makeTools(state);
    const before = await tools.dispatch({ action: "compare", params: {} });
    expect(before).toMatch(/前置条件未满足/);

    state.run.source = {
      side: "source",
      results: [
        { caseId: "c01", outcome: "return", returnValue: { type: "string", value: "hello" } },
        { caseId: "c02", outcome: "exception", exceptionType: "NullReferenceException", exceptionMessage: "x" },
      ],
      rawStdout: "",
      parseErrors: [],
    };
    state.run.target = {
      side: "target",
      results: [
        { caseId: "c01", outcome: "return", returnValue: { type: "string", value: "hello" } },
        { caseId: "c02", outcome: "exception", exceptionType: "NullPointerException", exceptionMessage: "y" },
      ],
      rawStdout: "",
      parseErrors: [],
    };
    const obs = await tools.dispatch({ action: "compare", params: {} });
    expect(obs).toContain("[c01] pass");
    expect(obs).toContain("[c02] pass"); // NRE ↔ NPE 异常等价类映射
    expect(state.comparisons).toHaveLength(2);
  });

  it("compare:行为不一致 → fail verdict 与差异详情", async () => {
    const state = withRunners(makeState());
    state.run.source = {
      side: "source",
      results: [{ caseId: "c01", outcome: "return", returnValue: { type: "string", value: "hello" } }],
      rawStdout: "",
      parseErrors: [],
    };
    state.run.target = {
      side: "target",
      results: [{ caseId: "c01", outcome: "return", returnValue: { type: "string", value: "buggy" } }],
      rawStdout: "",
      parseErrors: [],
    };
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({ action: "compare", params: {} });
    expect(obs).toContain("[c01] fail");
    expect(obs).toContain("return value mismatch");
  });
});

describe("SmokeTools:judge / propose_target_fix / propose_runner_fix / finish", () => {
  it("judge:compare 未执行 → 前置条件错误;就绪 → 记录裁决与源侧缺陷", async () => {
    const state = withRunners(makeState());
    const { tools } = makeTools(state);
    const before = await tools.dispatch({
      action: "judge",
      params: { verdicts: [{ caseId: "c01", decision: "pass", reasoning: "r" }] },
    });
    expect(before).toMatch(/前置条件未满足/);

    state.comparisons = [];
    const obs = await tools.dispatch({
      action: "judge",
      params: {
        verdicts: [{ caseId: "c01", decision: "pass", reasoning: "两侧一致" }],
        sourceIssues: ["源侧 null 输入无防护,但目标侧行为一致"],
      },
    });
    expect(obs).toContain("已记录 1 个 case 的语义裁决");
    expect(state.decisions).toHaveLength(1);
    expect(state.sourceIssues).toContain("源侧 null 输入无防护,但目标侧行为一致");
  });

  it("propose_target_fix:覆盖目标模块文件并自动 compile→run→compare,轮数 +1", async () => {
    const state = withRunners(makeState());
    state.run.source = {
      side: "source",
      results: [{ caseId: "c01", outcome: "return", returnValue: { type: "string", value: "hello" } }],
      rawStdout: "",
      parseErrors: [],
    };
    const { tools, executor } = makeTools(state);
    const obs = await tools.dispatch({
      action: "propose_target_fix",
      params: { files: [{ path: "MimeUtility.java", content: "public class MimeUtility { /* fixed */ }" }] },
    });
    expect(state.rounds).toBe(1);
    expect(state.targetModuleFiles[0]?.content).toContain("/* fixed */");
    expect(state.comparisons).not.toBeNull();
    expect(obs).toContain("自动重新编译→运行→差分完成");
    // 自动链:目标侧被重新编译 + 运行
    const targetCompile = executor.compileCalls.filter((s) => s.language === "Java");
    const targetRun = executor.runCalls.filter((s) => s.language === "Java");
    expect(targetCompile.length).toBe(1);
    expect(targetRun.length).toBe(1);
    expect(targetCompile[0]?.sourceFiles.some((f) => f.content.includes("/* fixed */"))).toBe(true);
  });

  it("propose_target_fix:编译失败时反馈编译错误,不产生差分", async () => {
    const state = withRunners(makeState());
    const { tools } = makeTools(state, { compileResults: (side) => ((side as { language?: string }).language === "Java" ? failCompile : okCompile) });
    const obs = await tools.dispatch({
      action: "propose_target_fix",
      params: { files: [{ path: "MimeUtility.java", content: "broken" }] },
    });
    expect(state.rounds).toBe(1);
    expect(obs).toMatch(/自动编译失败/);
    expect(state.comparisons).toBeNull();
  });

  it("propose_runner_fix:更新 runner 并重置该侧编译/运行结果", async () => {
    const state = withRunners(makeState());
    state.compile.source = okCompile;
    state.run.source = { side: "source", results: [], rawStdout: "", parseErrors: [] };
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({
      action: "propose_runner_fix",
      params: { side: "source", files: [{ path: "Driver.cs", content: "public class SmokeDriver { public static void Main() { System.Console.WriteLine(\"x\"); } }" }] },
    });
    expect(obs).toContain("已更新源侧 runner");
    expect(state.compile.source).toBeNull();
    expect(state.run.source).toBeNull();
  });

  it("finish:记录总结与 finished 标记,可选合并裁决", async () => {
    const state = withRunners(makeState());
    const { tools } = makeTools(state);
    const obs = await tools.dispatch({
      action: "finish",
      params: { summary: "全部通过", verdicts: [{ caseId: "c01", decision: "pass", reasoning: "r" }] },
    });
    expect(state.finished).toBe(true);
    expect(state.summary).toBe("全部通过");
    expect(state.decisions).toHaveLength(1);
    expect(obs).toContain("冒烟验证结束");
  });
});

describe("SmokeTools:纯函数(splitDriverEntry / buildSideSpec / validateRunnerContract)", () => {
  it("splitDriverEntry:按语言契约拆分 driver 入口与附加文件", () => {
    const files = [
      { path: "driver.py", content: "print('hi')" },
      { path: "mod.py", content: "x = 1" },
    ];
    const { driverSource, extraFiles } = splitDriverEntry("Python", files);
    expect(driverSource).toContain("print");
    expect(extraFiles).toEqual([{ path: "mod.py", content: "x = 1" }]);
  });

  it("splitDriverEntry:Java 以含 main 的 public class 文件为入口", () => {
    const files = [
      { path: "SmokeRunner.java", content: "public class SmokeRunner { public static void main(String[] a) {} }" },
      { path: "Helper.java", content: "class Helper {}" },
    ];
    const { driverSource, extraFiles } = splitDriverEntry("Java", files);
    expect(driverSource).toContain("SmokeRunner");
    expect(extraFiles).toEqual([{ path: "Helper.java", content: "class Helper {}" }]);
  });

  it("splitDriverEntry:入口缺失抛错", () => {
    expect(() => splitDriverEntry("C#", [{ path: "x.cs", content: "class X {}" }])).toThrow(/Driver\.cs/);
  });

  it("buildSideSpec:组装 SideSpec(用户模块 + runner 附加文件,Java 入口为 driverSource)", () => {
    const state = withRunners(makeState());
    state.runners.target = [
      { path: "SmokeRunner.java", content: JAVA_TARGET_RUNNER },
      { path: "Extra.java", content: "class Extra {}" },
    ];
    const spec = buildSideSpec(state, "target");
    expect(spec.language).toBe("Java");
    expect(spec.driverSource).toContain("public static void main");
    expect(spec.sourceFiles.map((f) => f.relativePath)).toEqual(["MimeUtility.java", "Extra.java"]);
  });

  it("validateRunnerContract:入口文件路径约定校验", () => {
    expect(validateRunnerContract("Python", [{ path: "driver.py", content: "" }])).toBeNull();
    expect(validateRunnerContract("Python", [])).toMatch(/不能为空/);
    expect(validateRunnerContract("TypeScript", [{ path: "driver.ts", content: "" }])).toBeNull();
    expect(validateRunnerContract("C#", [{ path: "Driver.cs", content: "public class D { }" }])).toBeNull();
    expect(validateRunnerContract("Java", [{ path: "SmokeRunner.java", content: "public class SmokeRunner { public static void main(String[] a) {} }" }])).toBeNull();
  });
});
