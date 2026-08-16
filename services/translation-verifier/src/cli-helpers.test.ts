import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestDescription } from "./description.js";
import type { VerificationReport } from "./verifier.js";
import { formatReport, parseCliArgs, runCli } from "./cli-helpers.js";

// ---- 测试辅助 ----

function validDescription(): TestDescription {
  return {
    schemaVersion: "1.0",
    target: { language: "Java", className: "Util", method: "doubleIt", isStatic: true, constructorArgs: [] },
    cases: [
      { id: "c1", inputs: [{ type: "number", value: 21 }], expected: { kind: "return", value: { type: "number", value: 42 } } },
      { id: "c2", inputs: [{ type: "number", value: -5 }], expected: { kind: "exception", type: "IllegalArgumentException" } },
    ],
  };
}

/** 构造任意 verdict 组合的报告(不依赖真实执行)。 */
function reportWith(passed: number, failed: number, divergent: number): VerificationReport {
  const total = passed + failed + divergent;
  const comparisons: VerificationReport["comparisons"] = [];
  for (let i = 0; i < passed; i += 1) {
    comparisons.push({ caseId: `p${i}`, verdict: "pass", source: null, target: null, details: [] });
  }
  for (let i = 0; i < failed; i += 1) {
    comparisons.push({ caseId: `f${i}`, verdict: "fail", source: null, target: null, details: ["return value mismatch"] });
  }
  for (let i = 0; i < divergent; i += 1) {
    comparisons.push({ caseId: `d${i}`, verdict: "divergent", source: null, target: null, details: ["target side produced no usable results."] });
  }
  return {
    schemaVersion: "1.0",
    source: { language: "C#", compile: { success: true, errors: [], output: "" }, run: { exitCode: 0, stdout: "", stderr: "" }, results: null },
    target: { language: "Java", compile: { success: true, errors: [], output: "" }, run: { exitCode: 0, stdout: "", stderr: "" }, results: null },
    comparisons,
    passRate: total === 0 ? 0 : passed / total,
    totalCases: total,
    passedCases: passed,
    failedCases: failed,
    divergentCases: divergent,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cli-helpers-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTemp(name: string, content: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

// ---- parseCliArgs ----

describe("parseCliArgs", () => {
  it("① 缺 --description → error", () => {
    const result = parseCliArgs(["--source", "/src", "--target", "/tgt"]);
    expect("error" in result).toBe(true);
  });

  it("①b 缺 --source / --target → error", () => {
    expect("error" in parseCliArgs(["--description", "/d.json", "--target", "/tgt"])).toBe(true);
    expect("error" in parseCliArgs(["--description", "/d.json", "--source", "/src"])).toBe(true);
  });

  it("② 必填参数解析正确", () => {
    const result = parseCliArgs(["--description", "/d.json", "--source", "/src", "--target", "/tgt"]);
    expect(result).toEqual({
      descriptionPath: "/d.json",
      sourceDir: "/src",
      targetDir: "/tgt",
      json: false,
    });
  });

  it("③ 可选参数解析(--max-rounds 5 / --json / --api-key / --requirement / --method-file)", () => {
    const result = parseCliArgs([
      "--description", "/d.json",
      "--source", "/src",
      "--target", "/tgt",
      "--max-rounds", "5",
      "--json",
      "--api-key", "sk-test",
      "--requirement", "解码 MIME 文本",
      "--method-file", "src/main/java/Util.java",
    ]);
    expect(result).toEqual({
      descriptionPath: "/d.json",
      sourceDir: "/src",
      targetDir: "/tgt",
      methodFile: "src/main/java/Util.java",
      apiKey: "sk-test",
      maxRounds: 5,
      json: true,
      requirement: "解码 MIME 文本",
    });
  });

  it("④ 非法 --max-rounds → error", () => {
    const base = ["--description", "/d.json", "--source", "/src", "--target", "/tgt"];
    for (const bad of ["abc", "-1", "1.5", ""]) {
      const result = parseCliArgs([...base, "--max-rounds", bad]);
      expect("error" in result).toBe(true);
    }
  });

  it("④b 未知参数 → error", () => {
    const result = parseCliArgs(["--description", "/d.json", "--source", "/src", "--target", "/tgt", "--bogus"]);
    expect("error" in result).toBe(true);
  });

  it("④c 缺值的 flag(如 --api-key 无值)→ error", () => {
    const result = parseCliArgs(["--description", "/d.json", "--source", "/src", "--target", "/tgt", "--api-key"]);
    expect("error" in result).toBe(true);
  });
});

// ---- formatReport ----

describe("formatReport", () => {
  it("⑤ 每 case 一行(verdict 标记 + requirementVerdict + 差异摘要)+ Pass rate 汇总行", () => {
    const report = reportWith(1, 1, 1);
    // 给 fail case 附加需求裁决,验证 requirementVerdict 出现。
    report.comparisons[1] = {
      ...report.comparisons[1]!,
      requirementVerdict: "target-diverges",
      details: ["return value mismatch", "declared expectation mismatch"],
    };

    const text = formatReport(report, validDescription());

    const lines = text.split("\n");
    expect(lines).toHaveLength(4); // 3 case 行 + 1 汇总行
    expect(lines[0]).toContain("p0");
    expect(lines[0]).toContain("PASS");
    expect(lines[1]).toContain("f0");
    expect(lines[1]).toContain("FAIL");
    expect(lines[1]).toContain("target-diverges");
    expect(lines[1]).toContain("return value mismatch");
    expect(lines[2]).toContain("d0");
    expect(lines[2]).toContain("DIVERGENT");
    expect(lines[3]).toMatch(/Pass rate: 1\/3 \(33\.3%\)/);
  });

  it("⑤b 全 PASS 时 Pass rate 100%,DIVERGENT 无细节时不出现裸标记歧义", () => {
    const text = formatReport(reportWith(2, 0, 0), validDescription());
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/Pass rate: 2\/2 \(100\.0%\)/);
  });
});

// ---- runCli(纯逻辑分支;完整工具链路径留给 E2E)----

describe("runCli", () => {
  it("⑥ 描述文件不存在 → 返回 2", async () => {
    const missingDescription = join(tempDir, "nope-does-not-exist.json");
    const exitCode = await runCli(["--description", missingDescription, "--source", "/src", "--target", "/tgt"]);
    expect(exitCode).toBe(2);
  });

  it("⑥b 描述文件不是合法 JSON → 返回 2", async () => {
    const bad = writeTemp("bad.json", "{ not json");
    const exitCode = await runCli(["--description", bad, "--source", "/src", "--target", "/tgt"]);
    expect(exitCode).toBe(2);
  });

  it("⑥c 描述校验失败(非法 schemaVersion)→ 返回 2", async () => {
    const invalid = writeTemp("invalid.json", JSON.stringify({ schemaVersion: "9.9", target: {}, cases: [] }));
    const exitCode = await runCli(["--description", invalid, "--source", "/src", "--target", "/tgt"]);
    expect(exitCode).toBe(2);
  });

  it("⑥d 描述无 requirement 且未提供 --requirement → 返回 2(需求第一)", async () => {
    const desc = writeTemp("desc.json", JSON.stringify(validDescription()));
    const exitCode = await runCli(["--description", desc, "--source", "/src", "--target", "/tgt"]);
    expect(exitCode).toBe(2);
  });

  it("⑥e --source 目录不存在 → 返回 2", async () => {
    const desc = writeTemp("desc.json", JSON.stringify(validDescription()));
    const exitCode = await runCli([
      "--description", desc,
      "--source", join(tempDir, "missing-src"),
      "--target", "/tgt",
      "--requirement", "需求文本",
    ]);
    expect(exitCode).toBe(2);
  });
});
