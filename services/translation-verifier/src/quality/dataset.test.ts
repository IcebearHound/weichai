/**
 * 数据集加载/任务构造单测:真实 commons-fileupload-31 数据集的
 * buildTask(Java maven 源侧 / C# 整项目目标侧 / 签名规范化)。
 */
import { describe, expect, it } from "vitest";
import { loadDataset, buildTask, findRepoRoot, normalizeSourceSignature, alignDescriptionTarget } from "./dataset.js";
import { sampleEntries } from "./evaluate.js";
import type { QualityDataset } from "./types.js";

const DATASET_PATH = "src/quality/dataset/commons-fileupload-31.json";

describe("loadDataset(真实数据集)", () => {
  it("40 entry 全部加载且校验无错", () => {
    const { dataset, errors } = loadDataset(DATASET_PATH);
    expect(errors).toEqual([]);
    expect(dataset).not.toBeNull();
    expect(dataset!.entries.length).toBe(40);
    const ids = new Set(dataset!.entries.map((e) => e.id));
    expect(ids.size).toBe(40);
    expect(dataset!.entries.every((e) => e.requirementDiffs.length > 0)).toBe(true);
  });

  it("无效数据集容错:坏 entry 剔除并记录", async () => {
    const { validateDataset } = await import("./dataset.js");
    const { dataset, errors } = validateDataset({
      schemaVersion: "1.0",
      source: "t",
      entries: [
        { id: "ok", requirement: "r", source: { language: "Java", file: "a.java", className: "A", method: "m" }, target: { language: "C#", file: "b.cs", className: "B", method: "M", isStatic: true, constructorArgs: [] }, requirementDiffs: [] },
        { id: "" },
        "garbage",
      ],
    });
    expect(dataset!.entries).toHaveLength(1);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildTask(真实数据集)", () => {
  it("全部 entry 可构造任务(文件存在)", () => {
    const root = findRepoRoot();
    const { dataset } = loadDataset(DATASET_PATH);
    let ok = 0;
    let fail = 0;
    for (const e of dataset!.entries) {
      const r = buildTask(e, root);
      if (r.task !== null) ok += 1;
      else fail += 1;
    }
    expect(fail).toBe(0);
    expect(ok).toBe(40);
  });

  it("Java 源侧:maven 项目根 + 签名规范化(package→FQN、静态性探测)", () => {
    const root = findRepoRoot();
    const { dataset } = loadDataset(DATASET_PATH);
    const entry = dataset!.entries.find((e) => e.id === "DefaultFileItemFactory.createItem")!;
    const task = buildTask(entry, root).task!;
    expect(task.source.language).toBe("Java");
    expect(task.source.projectRoot).toContain("commons-fileupload-java-skeleton");
    const sig = normalizeSourceSignature(entry, task.source.sourceFiles.map((f) => f.content).join("\n"), task.source.projectRoot);
    expect(sig.className).toBe("org.apache.commons.fileupload.DefaultFileItemFactory");
    expect(sig.isStatic).toBe(false); // createItem 是实例方法(接口默认无 static)
  });

  it("C# 目标侧:整项目文件 + GlobalUsings(目标命名空间 + System)", () => {
    const root = findRepoRoot();
    const { dataset } = loadDataset(DATASET_PATH);
    const entry = dataset!.entries.find((e) => e.id === "DefaultFileItem.getString")!;
    const task = buildTask(entry, root).task!;
    expect(task.target.language).toBe("C#");
    expect(task.target.sourceFiles.length).toBeGreaterThan(5); // 整个项目
    const globalUsings = task.target.sourceFiles.find((f) => f.relativePath === "GlobalUsings.cs");
    expect(globalUsings).toBeDefined();
    expect(globalUsings!.content).toContain("global using System;");
    expect(globalUsings!.content).toContain("global using Apache.Commons.FileUpload;");
    // 目标模块文件在收集集中(可被替换为注入版本)
    expect(task.target.sourceFiles.some((f) => f.relativePath.endsWith("Compatibility.cs"))).toBe(true);
  });

  it("alignDescriptionTarget:强制对齐 entry 目标签名", () => {
    const { dataset } = loadDataset(DATASET_PATH);
    const entry = dataset!.entries.find((e) => e.id === "DefaultFileItem.getString")!;
    const aligned = alignDescriptionTarget(
      {
        schemaVersion: "1.0",
        target: { language: "Java", className: "Wrong", method: "wrong", isStatic: true, constructorArgs: [] },
        cases: [{ id: "c01", inputs: [], expected: { kind: "return", value: { type: "null", value: null } } }],
      },
      entry,
    );
    expect(aligned.target.className).toBe("DefaultFileItem");
    expect(aligned.target.method).toBe("GetString");
    expect(aligned.target.isStatic).toBe(false);
    expect(aligned.target.constructorArgs.length).toBe(6);
    expect(aligned.requirement).toBe(entry.requirement);
  });
});

describe("sampleEntries(抽样)", () => {
  const dataset: QualityDataset = {
    schemaVersion: "1.0",
    source: "t",
    entries: Array.from({ length: 40 }, (_, i) => ({
      id: `e${String(i).padStart(2, "0")}`,
      requirement: `r${i}`,
      source: { language: "Java", file: "a.java", className: "A", method: "m" },
      target: { language: "C#", file: "b.cs", className: "B", method: "M", isStatic: true, constructorArgs: [] },
      requirementDiffs: [],
    })),
  };
  it("quick 抽样 5 个且等距", () => {
    const sampled = sampleEntries(dataset, "quick", 5);
    expect(sampled).toHaveLength(5);
    expect(sampled.map((e) => e.id)).toEqual(["e00", "e08", "e16", "e24", "e32"]);
  });
  it("full 返回全部", () => {
    expect(sampleEntries(dataset, "full", 5)).toHaveLength(40);
  });
});
