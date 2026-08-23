/**
 * 五个生成器适配器的调用链单测:fake spawnClaude + FakeDriverExecutor。
 * 覆盖:baseline(描述 + 成本计数)、smoke(完整循环 → runner)、
 * distinct(baseline + 分支一致性 → flag-fail 信号)、aid(变体轨道 + 检出)、
 * mitgen(片段级定向输入 + 源侧实跑录制)。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriverExecutor, type RunOutcome } from "../executor.js";
import type { SpawnClaude } from "../claude-client.js";
import type { DatasetEntry, QualityTask } from "./types.js";
import { BaselineAdapter } from "./adapters/baseline.js";
import { SmokeAdapter, RecordingExecutor, splitSideSpec } from "./adapters/smoke.js";
import { DistinctAdapter } from "./adapters/distinct.js";
import { AidAdapter } from "./adapters/aid.js";
import { MitGenAdapter } from "./adapters/mitgen.js";
import type { AdapterContext } from "./adapters.js";

// ---------------------------------------------------------------------------
// 共享 fixture
// ---------------------------------------------------------------------------

const ENTRY: DatasetEntry = {
  id: "ParameterParser.parse",
  requirement: "解析参数对:空输入抛异常,非法引号输入抛异常(检索代码返回 null 是历史缺陷)。",
  source: { language: "Java", file: "src/Source.java", className: "Source", method: "clamp" },
  target: { language: "C#", file: "src/Target.cs", className: "Target", method: "Compute", isStatic: true, constructorArgs: [] },
  requirementDiffs: ["需求明确:非法输入抛异常;检索代码返回 null(历史缺陷)。"],
};

const SOURCE_JAVA = `public class Source {
  public static int clamp(int value, int max) {
    if (value > max) {
      return max;
    }
    return value;
  }
}`;

const TARGET_CS = `public class Target {
  public static int Compute(int value) {
    if (value > 10) return value * 2;
    return value + 1;
  }
}`;

const DESCRIPTION_JSON = JSON.stringify({
  schemaVersion: "1.0",
  target: { language: "C#", className: "Target", method: "Compute", isStatic: true, constructorArgs: [] },
  cases: [
    {
      id: "c01",
      description: "场景:常规输入 / 触发行为:计算 / 目标分支或边界:nominal",
      inputs: [{ type: "number", value: 1 }],
      expected: { kind: "return", value: { type: "number", value: 42 } },
    },
  ],
});

function makeTask(): QualityTask {
  return {
    entry: ENTRY,
    source: { language: "Java", driverSource: "", sourceFiles: [{ relativePath: "Source.java", content: SOURCE_JAVA }] },
    target: { language: "C#", driverSource: "", sourceFiles: [{ relativePath: "Target.cs", content: TARGET_CS }] },
  };
}

/** 按序返回 stdout 的 fake spawnClaude。 */
function scriptedSpawn(responses: string[]): SpawnClaude {
  let index = 0;
  return async () => ({ stdout: responses[index++] ?? "", exitCode: 0 });
}

/** 按 prompt 内容匹配返回 stdout 的 fake spawnClaude(重复调用确定性)。
 * 注意:runClaude 的 spawn 参数为 ["-p", prompt, ...],prompt 在 args[1]。 */
function contentSpawn(rules: { contains: string; output: string }[], fallback = ""): SpawnClaude {
  return async (args) => {
    const prompt = args.slice(1).join(" ");
    const rule = rules.find((r) => prompt.includes(r.contains));
    return { stdout: rule?.output ?? fallback, exitCode: 0 };
  };
}

const fakeExecutor = (runOutcome?: RunOutcome) =>
  new FakeDriverExecutor({
    compileResults: { success: true, errors: [], output: "" },
    runResults: runOutcome ?? {
      exitCode: 0,
      stdout: JSON.stringify({ results: [{ caseId: "c01", outcome: "return", returnValue: { type: "number", value: 42 } }] }),
      stderr: "",
    },
  });

function ctx(spawn: SpawnClaude, executor?: FakeDriverExecutor): AdapterContext {
  return {
    llm: { apiKey: "offline-test", spawnClaude: spawn },
    executor: executor ?? fakeExecutor(),
    logger: undefined,
  };
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

describe("BaselineAdapter", () => {
  it("需求+源码 → 描述(含 expected),成本 = 1 次 LLM 调用", async () => {
    const adapter = new BaselineAdapter(ctx(scriptedSpawn([DESCRIPTION_JSON])));
    const test = await adapter.generateTest(makeTask());
    expect(test.kind).toBe("description");
    expect(test.description?.cases[0]?.id).toBe("c01");
    expect(test.meta.llmCalls).toBe(1);
  });

  it("非法 LLM 输出触发重试,成本统计含重试次数", async () => {
    const adapter = new BaselineAdapter(ctx(scriptedSpawn(["not json", DESCRIPTION_JSON])));
    const test = await adapter.generateTest(makeTask());
    expect(test.description?.cases).toHaveLength(1);
    expect(test.meta.llmCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// smoke
// ---------------------------------------------------------------------------

describe("SmokeAdapter", () => {
  it("完整冒烟循环 → runner 文件 + SmokeReport(converged)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quality-smoke-"));
    try {
      writeFileSync(join(dir, "Source.java"), SOURCE_JAVA, "utf-8");
      writeFileSync(join(dir, "Target.cs"), TARGET_CS, "utf-8");
      const entry: DatasetEntry = {
        ...ENTRY,
        source: { ...ENTRY.source, file: "Source.java" },
        target: { ...ENTRY.target, file: "Target.cs" },
      };
      const task: QualityTask = {
        entry,
        source: { language: "Java", driverSource: "", sourceFiles: [{ relativePath: "Source.java", content: SOURCE_JAVA }] },
        target: { language: "C#", driverSource: "", sourceFiles: [{ relativePath: "Target.cs", content: TARGET_CS }] },
      };
      const responses = [
        JSON.stringify({ action: "plan_smoke", params: { cases: [{ id: "c01", intent: "常规输入返回 +1" }] } }),
        JSON.stringify({ action: "write_runner", params: { side: "source", language: "Java", files: [{ path: "SmokeRunner.java", content: "public class SmokeRunner { public static void main(String[] args) {} }" }] } }),
        JSON.stringify({ action: "write_runner", params: { side: "target", language: "C#", files: [{ path: "Driver.cs", content: "public class Driver { public static void Main(string[] args) {} }" }] } }),
        JSON.stringify({ action: "compile_runner", params: { side: "source" } }),
        JSON.stringify({ action: "compile_runner", params: { side: "target" } }),
        JSON.stringify({ action: "run_runner", params: { side: "source" } }),
        JSON.stringify({ action: "run_runner", params: { side: "target" } }),
        JSON.stringify({ action: "compare", params: {} }),
        JSON.stringify({ action: "judge", params: { verdicts: [{ caseId: "c01", decision: "pass", reasoning: "两侧一致" }] } }),
        JSON.stringify({ action: "finish", params: { summary: "验收完成" } }),
      ];
      const adapter = new SmokeAdapter({ ...ctx(scriptedSpawn(responses)), rootDir: dir });
      const test = await adapter.generateTest(task);
      expect(test.kind).toBe("runner");
      expect(test.runner?.files.length).toBeGreaterThan(0);
      expect(test.runner?.files.some((f) => f.path === "Driver.cs")).toBe(true);
      expect(test.runner?.report?.converged).toBe(true);
      expect(test.runner?.report?.cases.some((c) => c.decision === "pass")).toBe(true);
      expect(test.meta.llmCalls).toBeGreaterThanOrEqual(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("RecordingExecutor 按模块内容归类还原目标侧 runner", async () => {
    const executor = new FakeDriverExecutor({
      compileResults: { success: true, errors: [], output: "" },
      runResults: { exitCode: 0, stdout: "{}", stderr: "" },
    });
    const recorder = new RecordingExecutor(executor, { sourceContent: SOURCE_JAVA, targetContent: TARGET_CS });
    // 模拟冒烟循环:先源侧编译(Source.java + 源 runner),再目标侧编译(Target.cs + Driver.cs)。
    await recorder.compile({
      language: "Java",
      driverSource: "public class RunnerSrc { }",
      sourceFiles: [{ relativePath: "Source.java", content: SOURCE_JAVA }, { relativePath: "RunnerSrc.java", content: "public class RunnerSrc { }" }],
    });
    await recorder.compile({
      language: "C#",
      driverSource: "public class Driver { public static void Main(string[] args) {} }",
      sourceFiles: [{ relativePath: "Target.cs", content: TARGET_CS }, { relativePath: "Helper.cs", content: "public class Helper { }" }],
    });
    const runner = recorder.targetRunner();
    expect(runner).not.toBeNull();
    expect(runner!.files.map((f) => f.path)).toContain("Driver.cs");
    expect(runner!.files.map((f) => f.path)).toContain("Helper.cs");
    expect(runner!.files.some((f) => f.path === "Target.cs")).toBe(false);
    expect(runner!.compileOk).toBe(true);

    const files = splitSideSpec(runner!.side, TARGET_CS);
    expect(files.map((f) => f.path)).toEqual(["Driver.cs", "Helper.cs"]);
  });

  it("多文件 C# 项目:标记为模块文件内容(而非全项目拼接)才能命中编译侧", async () => {
    const executor = new FakeDriverExecutor({
      compileResults: { success: true, errors: [], output: "" },
      runResults: { exitCode: 0, stdout: "{}", stderr: "" },
    });
    // 冒烟编译侧只含目标模块文件(磁盘原内容)+ runner 附加文件。
    const moduleContent = "namespace Apache.Commons.FileUpload { public static class Base64Decoder { } }";
    const joinedProject = `${moduleContent}\npublic class GlobalUsings { }`; // 旧实现:全项目拼接标记
    const recorder = new RecordingExecutor(executor, { sourceContent: SOURCE_JAVA, targetContent: moduleContent });
    await recorder.compile({
      language: "C#",
      driverSource: "public class Driver { public static void Main(string[] args) {} }",
      sourceFiles: [
        { relativePath: "Base64Decoder.cs", content: moduleContent },
        { relativePath: "Helper.cs", content: "public class Helper { }" },
      ],
    });
    const runner = recorder.targetRunner();
    expect(runner).not.toBeNull();
    expect(runner!.files.map((f) => f.path)).toEqual(["Driver.cs", "Helper.cs"]);
    // 旧实现(全项目拼接)在真实数据集(多文件项目)下必然失配。
    expect(moduleContent).not.toBe(joinedProject);
  });

  it("完整冒烟循环(多文件 C# 项目任务)→ 目标侧 runner 仍被捕获", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quality-smoke-multi-"));
    try {
      writeFileSync(join(dir, "Source.java"), SOURCE_JAVA, "utf-8");
      writeFileSync(join(dir, "Target.cs"), TARGET_CS, "utf-8");
      const entry: DatasetEntry = {
        ...ENTRY,
        source: { ...ENTRY.source, file: "Source.java" },
        target: { ...ENTRY.target, file: "Target.cs" },
      };
      // 模拟真实数据集:C# 目标侧 sourceFiles 为整项目文件(项目相对路径),非单文件。
      const task: QualityTask = {
        entry,
        source: { language: "Java", driverSource: "", sourceFiles: [{ relativePath: "Source.java", content: SOURCE_JAVA }] },
        target: {
          language: "C#",
          driverSource: "",
          sourceFiles: [
            { relativePath: "Commons/FileUpload/Target.cs", content: TARGET_CS },
            { relativePath: "Commons/FileUpload/GlobalUsings.cs", content: "global using System;\n" },
          ],
        },
      };
      const responses = [
        JSON.stringify({ action: "plan_smoke", params: { cases: [{ id: "c01", intent: "常规输入返回 +1" }] } }),
        JSON.stringify({ action: "write_runner", params: { side: "source", language: "Java", files: [{ path: "SmokeRunner.java", content: "public class SmokeRunner { public static void main(String[] args) {} }" }] } }),
        JSON.stringify({ action: "write_runner", params: { side: "target", language: "C#", files: [{ path: "Driver.cs", content: "public class Driver { public static void Main(string[] args) {} }" }] } }),
        JSON.stringify({ action: "compile_runner", params: { side: "source" } }),
        JSON.stringify({ action: "compile_runner", params: { side: "target" } }),
        JSON.stringify({ action: "run_runner", params: { side: "source" } }),
        JSON.stringify({ action: "run_runner", params: { side: "target" } }),
        JSON.stringify({ action: "compare", params: {} }),
        JSON.stringify({ action: "judge", params: { verdicts: [{ caseId: "c01", decision: "pass", reasoning: "两侧一致" }] } }),
        JSON.stringify({ action: "finish", params: { summary: "验收完成" } }),
      ];
      const adapter = new SmokeAdapter({ ...ctx(scriptedSpawn(responses)), rootDir: dir });
      const test = await adapter.generateTest(task);
      expect(test.kind).toBe("runner");
      expect(test.runner?.files.length).toBeGreaterThan(0);
      expect(test.runner?.files.some((f) => f.path === "Driver.cs")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// distinct
// ---------------------------------------------------------------------------

describe("DistinctAdapter", () => {
  it("baseline 描述 + 分支一致性 → flag-fail 信号(偏离需求)", async () => {
    const inventory = JSON.stringify({
      methodId: "Source.clamp",
      methodSummary: "clamp 到 [0, max]",
      branches: [{ id: "b1", kind: "if", location: "L1", condition: "value > max", semantics: "返回 max", nldConsistent: true }],
    });
    const consistency = JSON.stringify([
      { caseId: "c01", touchedBranches: ["b1"], assertionConsistent: false, nldVerdict: "diverges", recommend: "flag-fail", reasons: ["expected 照抄了检索代码的旧行为"] },
    ]);
    const adapter = new DistinctAdapter(ctx(scriptedSpawn([DESCRIPTION_JSON, inventory, consistency]), fakeExecutor()));
    const test = await adapter.generateTest(makeTask());
    expect(test.kind).toBe("description");
    expect(test.description?.cases[0]?.id).toBe("c01");
    expect(test.meta.signal?.kind).toBe("flag-fail");
    expect(test.meta.signal?.caseIds).toEqual(["c01"]);
    expect(test.meta.llmCalls).toBe(3);
  });

  it("无 flag-fail 时不带检出信号", async () => {
    const inventory = JSON.stringify({
      methodId: "Source.clamp",
      methodSummary: "clamp",
      branches: [{ id: "b1", kind: "if", location: "L1", condition: "value > max", semantics: "返回 max", nldConsistent: true }],
    });
    const consistency = JSON.stringify([
      { caseId: "c01", touchedBranches: ["b1"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
    ]);
    const adapter = new DistinctAdapter(ctx(scriptedSpawn([DESCRIPTION_JSON, inventory, consistency]), fakeExecutor()));
    const test = await adapter.generateTest(makeTask());
    expect(test.meta.signal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// aid
// ---------------------------------------------------------------------------

/** 从驱动源码提取全部 caseId(Java/C# 两种驱动格式)。 */
function caseIdsFromDriver(driverSource: string): string[] {
  const ids: string[] = [];
  const re = /(?:name|Name)\("caseId"\)\.(?:value|Value)\("([^"]*)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(driverSource)) !== null) {
    ids.push(m[1] as string);
  }
  return ids;
}

const VARIANT_JAVA = `public class Variant_1 {
  public static int clamp(int value, int max) {
    return Math.min(value, max);
  }
}`;

const INPUT_SCRIPT = `function sampleOne(): unknown[] {
  return [{ type: "number", value: 1 }];
}`;

function aidSpawn(): SpawnClaude {
  return contentSpawn(
    [
      { contains: "test migration specialist", output: DESCRIPTION_JSON },
      { contains: "translation verification specialist", output: VARIANT_JAVA },
      { contains: "software testing engineer", output: INPUT_SCRIPT },
    ],
    "{}",
  );
}

function aidExecutor(cleanTarget: string, buggyMark = "-999") {
  return new FakeDriverExecutor({
    compileResults: { success: true, errors: [], output: "" },
    runResults: (side) => {
      if (side.language === "TypeScript") {
        return { exitCode: 0, stdout: JSON.stringify({ inputs: [[{ type: "number", value: 1 }]] }), stderr: "" };
      }
      const ids = caseIdsFromDriver(side.driverSource);
      const value = 42;
      const results = ids.map((id) => ({ caseId: id, outcome: "return", returnValue: { type: "number", value } }));
      if (side.language === "C#") {
        const module = side.sourceFiles.find((f) => f.relativePath.endsWith(".cs"))?.content ?? "";
        if (module !== cleanTarget && module.includes(buggyMark)) {
          for (const r of results) r.returnValue = { type: "number", value: -999 };
        }
      }
      return { exitCode: 0, stdout: JSON.stringify({ results }), stderr: "" };
    },
  });
}

describe("AidAdapter", () => {
  it("变体轨道 → 描述 + 共识差分信号(干净目标全 pass)", async () => {
    const adapter = new AidAdapter({
      ...ctx(aidSpawn(), aidExecutor(TARGET_CS)),
      variantCount: 1,
      inputCount: 2,
    });
    const test = await adapter.generateTest(makeTask());
    expect(test.kind).toBe("description");
    expect(test.description?.cases[0]?.id).toBe("c01");
    expect(test.meta.signal?.kind).toBe("aid-differential");
    expect(test.meta.signal?.detail).toContain("failed=0");
    expect(test.meta.llmCalls).toBeGreaterThanOrEqual(3);
  });

  it("detectOnTarget:注入 bug 后共识差分 fail > clean → 检出", async () => {
    const executor = aidExecutor(TARGET_CS);
    const adapter = new AidAdapter({ ...ctx(aidSpawn(), executor), variantCount: 1, inputCount: 2 });
    const test = await adapter.generateTest(makeTask());
    const buggy = TARGET_CS.replace("value + 1", "return -999;");
    const result = await adapter.detectOnTarget(makeTask(), test, buggy);
    expect(result.detected).toBe(true);
    expect(result.failedCasesBuggy).toBeGreaterThan(result.failedCasesClean);
  });

  it("detectOnTarget:干净目标不检出", async () => {
    const executor = aidExecutor(TARGET_CS);
    const adapter = new AidAdapter({ ...ctx(aidSpawn(), executor), variantCount: 1, inputCount: 2 });
    const test = await adapter.generateTest(makeTask());
    const result = await adapter.detectOnTarget(makeTask(), test, TARGET_CS);
    expect(result.detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mitgen
// ---------------------------------------------------------------------------

describe("MitGenAdapter", () => {
  it("片段划分+打分+定向输入+源侧实跑录制 → 描述", async () => {
    const scoring = JSON.stringify({
      scores: [{ fragmentId: "frag-01", llmRiskScore: 0.8, llmFixabilityScore: 0.5, rationale: "边界" }],
    });
    const inputGen = JSON.stringify({
      cases: [{ description: "触发 max 分支", inputs: [{ type: "number", value: 5 }, { type: "number", value: 3 }] }],
    });
    const correspondence = JSON.stringify({
      correspondences: [{ fragmentId: "frag-01", correspondence: "equivalent", note: "" }],
    });
    const executor = new FakeDriverExecutor({
      compileResults: { success: true, errors: [], output: "" },
      runResults: (side) => {
        const marker = /\[MARK\]([A-Za-z0-9_-]+)/.exec(side.sourceFiles[0]?.content ?? "")?.[1] ?? "frag-01";
        return {
          exitCode: 0,
          stdout: `[MARK]${marker}\n${JSON.stringify({ results: [{ caseId: "probe", outcome: "return", returnValue: { type: "number", value: 3 } }] })}`,
          stderr: "",
        };
      },
    });
    const adapter = new MitGenAdapter({ ...ctx(scriptedSpawn([scoring, inputGen, correspondence]), executor), maxFragments: 1, casesPerFragment: 1 });
    const test = await adapter.generateTest(makeTask());
    expect(test.kind).toBe("description");
    expect(test.description?.cases.length).toBeGreaterThan(0);
    // expected 来自源侧实跑录制(值 3),而非 LLM 编造。
    const expected = test.description?.cases[0]?.expected;
    expect(expected?.kind === "return" && expected.value.type === "number" && expected.value.value === 3).toBe(true);
    expect(test.meta.signal?.kind).toBe("mitgen-fragments");
  });
});
