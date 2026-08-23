import { describe, expect, it, vi } from "vitest";
import type { SpawnClaude } from "./claude-client.js";
import { FakeDriverExecutor, type CompileOutcome, type SideSpec } from "./executor.js";
import { createLogger } from "./logger.js";
import { TestMigratorAgent, type MigrationInput } from "./test-migrator.js";
import { buildValidatorFeedbackPrompt, DescriptionValidator, filterDriverErrors, driverFileNames } from "./validator.js";

type FakeSpawn = SpawnClaude & ReturnType<typeof vi.fn>;

function fakeSpawn(stdout: string, exitCode = 0, stderr = ""): FakeSpawn {
  const mock = vi.fn(async () => ({ stdout, exitCode, stderr }));
  return mock as unknown as FakeSpawn;
}

const quietLogger = createLogger("test", { disabled: true });

const okCompile: CompileOutcome = { success: true, errors: [], output: "" };

function descriptionJson(caseOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    target: { language: "Java", className: "Calculator", method: "add", isStatic: true, constructorArgs: [] },
    cases: [
      {
        id: "c1",
        description: "场景:常规加法 / 触发行为:返回和 / 目标分支或边界:nominal",
        inputs: [{ type: "string", value: "wrong-type" }],
        expected: { kind: "return", value: { type: "number", value: 3 } },
        ...caseOverrides,
      },
    ],
  });
}

function sampleInput(): MigrationInput {
  return {
    sourceLanguage: "C#",
    sourceCode: "public static class Calculator { public static int Add(int x, int y) => x + y; }",
    requirement: "两数相加返回和",
    target: { language: "Java", className: "Calculator", method: "add", isStatic: true },
    // Validator 需要重建源侧驱动。
    sourceInvocation: { language: "C#", className: "Calculator", method: "Add", isStatic: true, constructorArgs: [] },
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
    driverSource: "public class Driver_placeholder { }",
    sourceFiles: [{ relativePath: "Calculator.java", content: "public class Calculator { public static int add(int x, int y) { return x + y; } }" }],
  };
}

describe("filterDriverErrors(驱动错误行归属过滤)", () => {
  it("只保留错误行中出现任一驱动文件名的行", () => {
    const errors = [
      "Driver.cs(3,9): error CS1503: argument 1: cannot convert from 'string' to 'int'",
      "Calculator.cs(2,1): error CS1001: identifier expected",
      "Driver_abc12345.java:5: error: incompatible types",
      "error: package does not exist",
    ];
    expect(filterDriverErrors(errors, ["Driver.cs"])).toEqual([
      "Driver.cs(3,9): error CS1503: argument 1: cannot convert from 'string' to 'int'",
    ]);
    expect(filterDriverErrors(errors, ["Driver_abc12345.java"])).toEqual([
      "Driver_abc12345.java:5: error: incompatible types",
    ]);
    expect(filterDriverErrors(["error: package does not exist"], ["Driver.cs", "Driver.java"])).toEqual([]);
  });
});

describe("driverFileNames(驱动文件名解析)", () => {
  it("Java 按 public class 名;其余语言固定脚本名", () => {
    expect(driverFileNames("Java", "public class Driver_abc12345 { }")).toEqual(["Driver_abc12345.java"]);
    expect(driverFileNames("Java", "public class Driver { }")).toEqual(["Driver.java"]);
    expect(driverFileNames("C#", "anything")).toEqual(["Driver.cs"]);
    expect(driverFileNames("Python", "anything")).toEqual(["driver.py"]);
    expect(driverFileNames("TypeScript", "anything")).toEqual(["driver.ts"]);
  });
});

describe("buildValidatorFeedbackPrompt(反馈 prompt)", () => {
  it("声明是描述/驱动问题而非翻译问题,并携带编译器诊断", () => {
    const input = sampleInput();
    const feedback = buildValidatorFeedbackPrompt(input, [
      "Driver_abc12345.java:5: error: incompatible types: String cannot be converted to int",
    ]);
    expect(feedback).toContain("VALIDATION_FEEDBACK");
    expect(feedback).toContain("Driver_*.java / Driver.cs / driver.py / driver.ts");
    expect(feedback).toContain("不是目标翻译实现的质量问题");
    expect(feedback).toContain("COMPILER_DIAGNOSTICS");
    expect(feedback).toContain("Driver_abc12345.java:5: error: incompatible types");
  });
});

describe("DescriptionValidator.extractDescriptionVerified(试编译循环)", () => {
  it("① 第一次编译失败(错误行含 driver 文件名)→ LLM 收到诊断重生成 → 第二轮编译成功返回", async () => {
    const spawnClaude = fakeSpawn(descriptionJson());
    // 第一次返回带错误输入类型(string)的描述;第二次返回修正版(number 输入)。
    spawnClaude.mockResolvedValueOnce({ stdout: descriptionJson(), exitCode: 0 });
    spawnClaude.mockResolvedValueOnce({
      stdout: descriptionJson({ inputs: [{ type: "number", value: 1 }], expected: { kind: "return", value: { type: "number", value: 3 } } }),
      exitCode: 0,
    });
    let targetCompileCount = 0;
    const compileResults = (side: SideSpec): CompileOutcome => {
      if (side.language === "Java") {
        targetCompileCount += 1;
        if (targetCompileCount === 1) {
          const name = /public class (\w+)/.exec(side.driverSource)?.[1] ?? "Driver";
          return {
            success: false,
            errors: [`${name}.java:5: error: incompatible types: String cannot be converted to int`],
            output: "javac output",
          };
        }
      }
      return okCompile;
    };
    const executor = new FakeDriverExecutor({ compileResults, runResults: { exitCode: 0, stdout: "{}", stderr: "" } });
    const validator = new DescriptionValidator({
      agent: new TestMigratorAgent({ apiKey: "test-key", spawnClaude }),
      executor,
      logger: quietLogger,
    });

    const result = await validator.extractDescriptionVerified(sampleInput(), sourceSide(), targetSide());

    // 返回重生成后的描述(number 输入)。
    expect(result.cases[0]?.inputs).toEqual([{ type: "number", value: 1 }]);
    // 第一次生成 + 一次反馈重生成 = 2 次 LLM 调用。
    expect(spawnClaude).toHaveBeenCalledTimes(2);
    // 第一轮双侧编译 + 第二轮双侧编译 = 4 次 compile。
    expect(executor.compileCalls.length).toBe(4);
    // LLM 第二次调用(反馈重生成)的 prompt 携带诊断文本。
    const secondPrompt = (spawnClaude.mock.calls[1]?.[0] as string[])[1] as string;
    expect(secondPrompt).toContain("VALIDATION_FEEDBACK");
    expect(secondPrompt).toContain("incompatible types: String cannot be converted to int");
    expect(secondPrompt).toContain("不是目标翻译实现的质量问题");
  });

  it("② 编译错误行不含 driver 文件名(属目标翻译文件)→ 不重生成、按错误抛出", async () => {
    const spawnClaude = fakeSpawn(descriptionJson());
    const compileResults = (side: SideSpec): CompileOutcome =>
      side.language === "Java"
        ? { success: false, errors: ["Calculator.java:3: error: incompatible types: int cannot be converted to String"], output: "javac" }
        : okCompile;
    const executor = new FakeDriverExecutor({ compileResults, runResults: { exitCode: 0, stdout: "{}", stderr: "" } });
    const validator = new DescriptionValidator({
      agent: new TestMigratorAgent({ apiKey: "test-key", spawnClaude }),
      executor,
      logger: quietLogger,
    });

    await expect(validator.extractDescriptionVerified(sampleInput(), sourceSide(), targetSide())).rejects.toThrow(
      /编译错误不在驱动生成文件中,不触发描述重生成/,
    );
    // 错误归属非驱动 → 只生成一次,无反馈重生成。
    expect(spawnClaude).toHaveBeenCalledTimes(1);
  });

  it("③ 超过 maxRounds 轮仍失败 → 抛错", async () => {
    const spawnClaude = fakeSpawn(descriptionJson());
    const compileResults = (side: SideSpec): CompileOutcome => {
      if (side.language === "Java") {
        const name = /public class (\w+)/.exec(side.driverSource)?.[1] ?? "Driver";
        return { success: false, errors: [`${name}.java:5: error: incompatible types`], output: "javac" };
      }
      return okCompile;
    };
    const executor = new FakeDriverExecutor({ compileResults, runResults: { exitCode: 0, stdout: "{}", stderr: "" } });
    const validator = new DescriptionValidator({
      agent: new TestMigratorAgent({ apiKey: "test-key", spawnClaude }),
      executor,
      maxRounds: 2,
      logger: quietLogger,
    });

    await expect(validator.extractDescriptionVerified(sampleInput(), sourceSide(), targetSide())).rejects.toThrow(
      /超过最大重试次数\(2\)/,
    );
    // 初始生成 1 次 + 2 次反馈重生成 = 3 次 LLM 调用(每次 compile 双侧,共 6 次 compile)。
    expect(spawnClaude).toHaveBeenCalledTimes(3);
    expect(executor.compileCalls.length).toBe(6);
  });

  it("④ 双侧编译均成功 → 一次 LLM 调用即返回(无重试)", async () => {
    const spawnClaude = fakeSpawn(descriptionJson({ inputs: [{ type: "number", value: 1 }] }));
    const executor = new FakeDriverExecutor({ compileResults: okCompile, runResults: { exitCode: 0, stdout: "{}", stderr: "" } });
    const validator = new DescriptionValidator({
      agent: new TestMigratorAgent({ apiKey: "test-key", spawnClaude }),
      executor,
      logger: quietLogger,
    });

    const result = await validator.extractDescriptionVerified(sampleInput(), sourceSide(), targetSide());

    expect(result.cases).toHaveLength(1);
    expect(spawnClaude).toHaveBeenCalledTimes(1);
    expect(executor.compileCalls.length).toBe(2);
  });

  it("无 sourceInvocation 时源侧驱动退回模板 driverSource(不抛错)", async () => {
    const spawnClaude = fakeSpawn(descriptionJson({ inputs: [{ type: "number", value: 1 }] }));
    const executor = new FakeDriverExecutor({ compileResults: okCompile, runResults: { exitCode: 0, stdout: "{}", stderr: "" } });
    const validator = new DescriptionValidator({
      agent: new TestMigratorAgent({ apiKey: "test-key", spawnClaude }),
      executor,
      logger: quietLogger,
    });

    const input = sampleInput();
    delete input.sourceInvocation;
    const result = await validator.extractDescriptionVerified(input, sourceSide(), targetSide());

    expect(result.cases).toHaveLength(1);
    expect(spawnClaude).toHaveBeenCalledTimes(1);
  });
});
