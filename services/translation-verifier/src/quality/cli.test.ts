/**
 * quality CLI 参数解析单测:默认值、非法参数、模式/策略组合。
 */
import { describe, expect, it } from "vitest";
import { parseCliArgs, formatTable } from "./cli.js";
import type { EvaluationReport } from "./evaluate.js";

describe("parseCliArgs", () => {
  it("默认:quick 模式 + 全部适配器", () => {
    const result = parseCliArgs(["--dataset", "data.json"]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.dataset).toBe("data.json");
    expect(result.mode).toBe("quick");
    expect(result.adapters).toEqual(["baseline", "smoke", "distinct", "aid", "mitgen"]);
    expect(result.sampleSize).toBe(5);
    expect(result.skipConformance).toBe(false);
  });

  it("--full 与 --adapters 与 --bug-kinds 解析", () => {
    const result = parseCliArgs([
      "--dataset", "d.json",
      "--full",
      "--adapters", "baseline,mitgen",
      "--bug-kinds", "fixed-value,condition-flip",
      "--skip-conformance",
      "--sample-size", "8",
    ]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.mode).toBe("full");
    expect(result.adapters).toEqual(["baseline", "mitgen"]);
    expect(result.bugKinds).toEqual(["fixed-value", "condition-flip"]);
    expect(result.skipConformance).toBe(true);
    expect(result.sampleSize).toBe(8);
  });

  it("缺少 --dataset 报错", () => {
    const result = parseCliArgs([]);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("--dataset");
  });

  it("未知适配器/未知注入策略/未知参数报错", () => {
    expect("error" in parseCliArgs(["--dataset", "d.json", "--adapters", "nope"])).toBe(true);
    expect("error" in parseCliArgs(["--dataset", "d.json", "--bug-kinds", "bogus"])).toBe(true);
    expect("error" in parseCliArgs(["--dataset", "d.json", "--wat"])).toBe(true);
  });

  it("非法数值报错", () => {
    expect("error" in parseCliArgs(["--dataset", "d.json", "--sample-size", "abc"])).toBe(true);
  });
});

describe("formatTable", () => {
  it("输出对比表头与适配器行", () => {
    const report: EvaluationReport = {
      schemaVersion: "1.1",
      mode: "quick",
      dataset: { source: "test", totalEntries: 1, evaluatedEntries: 1 },
      adapters: {
        baseline: {
          csr: 1,
          conformance: { judged: 1, conforms: 1, diverges: 0, unverified: 0, rate: 1 },
          detectionRate: 1,
          detection: { attempted: 1, eligible: 1, injectionFailed: 0, unverified: 0, detected: 1 },
          falsePositiveRate: 0,
          llmCalls: 2,
          perEntry: [],
        },
        smoke: {
          csr: 0,
          conformance: { judged: 0, conforms: 0, diverges: 0, unverified: 0, rate: 0 },
          detectionRate: 0,
          detection: { attempted: 1, eligible: 0, injectionFailed: 1, unverified: 0, detected: 0 },
          falsePositiveRate: 0,
          llmCalls: 9,
          perEntry: [],
        },
        distinct: { csr: 1, conformance: { judged: 1, conforms: 0, diverges: 1, unverified: 0, rate: 0 }, detectionRate: 1, detection: { attempted: 1, eligible: 1, injectionFailed: 0, unverified: 0, detected: 1 }, falsePositiveRate: 0, llmCalls: 3, perEntry: [] },
        aid: { csr: 1, conformance: { judged: 1, conforms: 1, diverges: 0, unverified: 0, rate: 1 }, detectionRate: 1, detection: { attempted: 1, eligible: 1, injectionFailed: 0, unverified: 0, detected: 1 }, falsePositiveRate: 0, llmCalls: 5, perEntry: [] },
        mitgen: { csr: 1, conformance: { judged: 1, conforms: 1, diverges: 0, unverified: 0, rate: 1 }, detectionRate: 1, detection: { attempted: 1, eligible: 1, injectionFailed: 0, unverified: 0, detected: 1 }, falsePositiveRate: 0, llmCalls: 4, perEntry: [] },
      },
      generatedAt: "now",
    };
    const table = formatTable(report);
    expect(table).toContain("adapter");
    expect(table).toContain("baseline");
    expect(table).toContain("detection");
    expect(table).toContain("det-inject-failed");
    expect(table).toContain("det-unverified");
    expect(table).toContain("1.00");
  });

  it("旧版报告缺少 detection 细分时从 perEntry 回退计算", () => {
    const report = {
      schemaVersion: "1.0",
      mode: "quick",
      dataset: { source: "legacy", totalEntries: 1, evaluatedEntries: 1 },
      adapters: {
        baseline: {
          csr: 1,
          conformance: { judged: 0, conforms: 0, diverges: 0, unverified: 0, rate: 0 },
          detectionRate: 0,
          falsePositiveRate: 0,
          llmCalls: 0,
          perEntry: [
            {
              entryId: "legacy-1",
              generated: true,
              csr: true,
              conformance: null,
              detections: [{ kind: "off-by-one", detected: false, note: "target-compile-failed" }],
              falsePositive: false,
              llmCalls: 0,
            },
          ],
        },
      },
      generatedAt: "now",
    } as unknown as EvaluationReport;
    const table = formatTable(report);
    expect(table).toContain("baseline");
    expect(table).toContain("det-unverified");
    expect(table).not.toContain("undefined");
  });
});
