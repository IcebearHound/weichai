import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FilePatch, PatchHunk } from "@forexplore/contracts";
import { BackfillAdapter } from "./backfill-adapter";

// ---------------------------------------------------------------------------
// Temporary directory lifecycle
// ---------------------------------------------------------------------------

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "forexplore-backfill-"));
  temporaryRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// Patch builders that match real-world scenarios
// ---------------------------------------------------------------------------

/**
 * adaptation-adapter.ts 的 buildFilePatch 生产的 patch 形态：
 * 全部是 add 行，无 context / remove → 全量替换。
 */
function fullReplacePatch(filePath: string, newContent: string, status: "modified" | "created" = "modified"): FilePatch {
  const lines = newContent.split("\n");
  return {
    path: filePath,
    status,
    additions: lines.length,
    deletions: status === "modified" ? 1 : 0,   // adaptation-adapter 硬编码 deletions: 1
    hunks: [
      {
        header: `@@ -0,0 +1,${lines.length} @@`,
        lines: lines.map((content) => ({ type: "add" as const, content })),
      },
    ],
  };
}

/**
 * mock-adapters.ts 的 createPatch 生产的 patch 形态：
 * remove 行（旧占位）+ add 行（新代码），无 context → 也是全量替换。
 */
function replaceStubPatch(filePath: string, oldStub: string, newContent: string): FilePatch {
  const oldLines = oldStub.split("\n");
  const newLines = newContent.split("\n");
  return {
    path: filePath,
    status: "modified",
    additions: newLines.length,
    deletions: oldLines.length,
    hunks: [
      {
        header: `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        lines: [
          ...oldLines.map((content) => ({ type: "remove" as const, content })),
          ...newLines.map((content) => ({ type: "add" as const, content })),
        ],
      },
    ],
  };
}

/**
 * 带 context 的 patch（当前无人生产，但类型支持）。
 * 语义：在 context 行定位处删掉 remove 行、插入 add 行，其余部分不动。
 */
function contextualPatch(filePath: string, hunks: PatchHunk[]): FilePatch {
  const additions = hunks.flatMap((h) => h.lines).filter((l) => l.type === "add").length;
  const deletions = hunks.flatMap((h) => h.lines).filter((l) => l.type === "remove").length;
  return { path: filePath, status: "modified", additions, deletions, hunks };
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const ORIGINAL_FILE = [
  "// Currency Platform — Rate Quote Service",
  "// Copyright (c) 2025",
  "",
  "using System;",
  "using System.Collections.Generic;",
  "",
  "public class RateQuoteService",
  "{",
  "    public decimal GetRate(string currencyPair)",
  "    {",
  "        // TODO: 接入实时汇率",
  "        throw new NotImplementedException();",
  "    }",
  "}",
].join("\n");

const NEW_IMPLEMENTATION = [
  "public class RateQuoteService",
  "{",
  "    public decimal GetRate(string currencyPair)",
  "    {",
  "        return currencyPair switch",
  "        {",
  '            "USD/EUR" => 0.92m,',
  '            "USD/JPY" => 149.50m,',
  "            _ => 1.0m",
  "        };",
  "    }",
  "}",
].join("\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BackfillAdapter", () => {
  let root: string;
  let adapter: BackfillAdapter;

  beforeEach(async () => {
    root = await createProjectRoot();
    adapter = new BackfillAdapter({ projectRoot: root });
  });

  // ---- status: "modified" ----

  describe("when status is 'modified'", () => {
    const filePath = "src/Services/RateQuoteService.cs";

    beforeEach(async () => {
      const dir = path.join(root, path.dirname(filePath));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(root, filePath), ORIGINAL_FILE, "utf-8");
    });

    it("replaces the file content with a full-replace (add-only) patch", async () => {
      const result = await adapter.apply([fullReplacePatch(filePath, NEW_IMPLEMENTATION)]);

      expect(result.appliedFiles).toEqual([filePath]);
      const written = await readFile(path.join(root, filePath), "utf-8");
      expect(written).toBe(NEW_IMPLEMENTATION);
    });

    it("replaces the file content with a remove+add (no-context) patch", async () => {
      const result = await adapter.apply([replaceStubPatch(filePath, ORIGINAL_FILE, NEW_IMPLEMENTATION)]);

      expect(result.appliedFiles).toEqual([filePath]);
      const written = await readFile(path.join(root, filePath), "utf-8");
      expect(written).toBe(NEW_IMPLEMENTATION);
    });

    it("returns a checkpoint id with the expected format", async () => {
      const result = await adapter.apply([fullReplacePatch(filePath, "// just a comment\n")]);

      expect(result.checkpointId).toMatch(/^checkpoint-[0-9a-z]+$/);
    });

    it("throws an error when the file does not exist on disk", async () => {
      const missingPath = "src/Services/Missing.cs";

      await expect(
        adapter.apply([fullReplacePatch(missingPath, NEW_IMPLEMENTATION)]),
      ).rejects.toThrow(`Cannot modify "${missingPath}": file does not exist`);
    });

    describe("when the original file is a full C# class (not a stub)", () => {
      const classFilePath = "src/Services/FullClass.cs";

      const originalClass = [
        "using System;",
        "using System.Collections.Generic;",
        "",
        "namespace MyApp.Services",
        "{",
        "    public class RateQuoteService",
        "    {",
        "        public decimal GetRate(string currencyPair)",
        "        {",
        "            throw new NotImplementedException();",
        "        }",
        "",
        "        public void Initialize()",
        "        {",
        "            // setup",
        "        }",
        "    }",
        "}",
      ].join("\n");

      // 模拟 LLM 翻译输出：只有方法代码（adaptation-adapter 的 prompt 要求只输出方法体）
      const translatedMethod = [
        "        public decimal GetRate(string currencyPair)",
        "        {",
        "            return currencyPair switch",
        "            {",
        '                "USD/EUR" => 0.92m,',
        "                _ => 1.0m",
        "            };",
        "        }",
      ].join("\n");

      beforeEach(async () => {
        const dir = path.join(root, path.dirname(classFilePath));
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(root, classFilePath), originalClass, "utf-8");
      });

      it("preserves class structure with a context-based patch", async () => {
        // 模拟修复后的 buildFilePatch 生成的 context-based hunk
        const originalLines = originalClass.split("\n");
        // GetRate 方法从第 8 行（0-indexed）开始
        const startIdx = 7;
        // 方法到第 10 行（0-indexed）结束
        const endIdx = 10;
        const removedLines = originalLines.slice(startIdx, endIdx + 1);

        const newLines = translatedMethod.split("\n");
        const hunks: PatchHunk[] = [
          {
            header: `@@ -${startIdx + 1},${removedLines.length} +${startIdx + 1},${newLines.length} @@`,
            lines: [
              { type: "context", content: originalLines[startIdx - 1] },
              ...removedLines.map((l): PatchHunk["lines"][number] => ({ type: "remove", content: l })),
              ...newLines.map((l): PatchHunk["lines"][number] => ({ type: "add", content: l })),
              { type: "context", content: originalLines[endIdx + 1] },
            ],
          },
        ];
        const patch: FilePatch = {
          path: classFilePath,
          status: "modified",
          additions: newLines.length,
          deletions: removedLines.length,
          hunks,
        };

        await adapter.apply([patch]);

        const written = await readFile(path.join(root, classFilePath), "utf-8");

        // class 结构完整保留
        expect(written).toContain("using System;");
        expect(written).toContain("namespace MyApp.Services");
        expect(written).toContain("public class RateQuoteService");
        expect(written).toContain("Initialize");

        // 方法体被正确替换
        expect(written).toContain("currencyPair switch");
        expect(written).not.toContain("throw new NotImplementedException();");
      });
    });
  });

  // ---- status: "created" ----

  describe("when status is 'created'", () => {
    it("creates the file (and parent directories) with only the add lines", async () => {
      const filePath = "src/Generated/Calculator.cs";
      const content = "public class Calculator { }\n";

      const result = await adapter.apply([fullReplacePatch(filePath, content, "created")]);

      expect(result.appliedFiles).toEqual([filePath]);
      const written = await readFile(path.join(root, filePath), "utf-8");
      expect(written).toBe(content);
    });

    it("ignores remove and context lines when building new-file content", async () => {
      const filePath = "src/Generated/Service.cs";
      const hunks: PatchHunk[] = [
        {
          header: "@@ -1,3 +1,2 @@",
          lines: [
            { type: "context", content: "// header" },
            { type: "remove", content: "old line" },
            { type: "add", content: "new line" },
          ],
        },
      ];
      const patch: FilePatch = { path: filePath, status: "created", additions: 1, deletions: 1, hunks };

      const result = await adapter.apply([patch]);

      // 对于 created 文件，只提取 type === "add" 的行
      const written = await readFile(path.join(root, filePath), "utf-8");
      expect(written).toBe("new line");
      expect(result.appliedFiles).toEqual([filePath]);
    });
  });

  // ---- multiple files ----

  describe("when applying multiple patches", () => {
    it("processes all files and reports them in appliedFiles", async () => {
      const dirA = path.join(root, "src/A");
      const dirB = path.join(root, "src/B");
      await mkdir(dirA, { recursive: true });
      await mkdir(dirB, { recursive: true });
      await writeFile(path.join(root, "src/A/Alpha.cs"), "// stub\n", "utf-8");
      await writeFile(path.join(root, "src/B/Bravo.cs"), "// stub\n", "utf-8");

      const result = await adapter.apply([
        fullReplacePatch("src/A/Alpha.cs", "public class Alpha { }\n"),
        fullReplacePatch("src/B/Bravo.cs", "public class Bravo { }\n", "created"),
      ]);

      expect(result.appliedFiles).toHaveLength(2);
      expect(result.appliedFiles).toContain("src/A/Alpha.cs");
      expect(result.appliedFiles).toContain("src/B/Bravo.cs");
    });
  });

  // ---- context-based hunks (documenting current behavior) ----

  describe("when hunks contain context lines", () => {
    const filePath = "src/ContextTest.cs";

    beforeEach(async () => {
      const dir = path.join(root, path.dirname(filePath));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(root, filePath), ORIGINAL_FILE, "utf-8");
    });

    it("preserves original lines outside the hunk while replacing the matched region", async () => {
      // 这个 hunk 意图：只替换方法体（throw 语句），其余代码原样保留。
      const hunks: PatchHunk[] = [
        {
          header: "@@ -9,5 +9,4 @@",
          lines: [
            { type: "context", content: "    public decimal GetRate(string currencyPair)" },
            { type: "remove",  content: "    {" },
            { type: "remove",  content: "        // TODO: 接入实时汇率" },
            { type: "remove",  content: '        throw new NotImplementedException();' },
            { type: "remove",  content: "    }" },
            { type: "add",     content: "    {" },
            { type: "add",     content: "        return 0.92m;" },
            { type: "add",     content: "    }" },
            { type: "context", content: "}" },
          ],
        },
      ];

      await adapter.apply([contextualPatch(filePath, hunks)]);

      const written = await readFile(path.join(root, filePath), "utf-8");

      // hunk 之外的原始行全部保留
      expect(written).toContain("Currency Platform");
      expect(written).toContain("using System;");
      expect(written).toContain("public class RateQuoteService");

      // 被删除的行不再存在
      expect(written).not.toContain("throw new NotImplementedException()");
      expect(written).not.toContain("TODO");

      // 新增的行出现在文件中
      expect(written).toContain("return 0.92m;");
    });
  });

  // ---- edge cases in applyHunks ----

  describe("when context pattern cannot be found in the original file", () => {
    const filePath = "src/NoMatch.cs";

    beforeEach(async () => {
      const dir = path.join(root, path.dirname(filePath));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(root, filePath), ORIGINAL_FILE, "utf-8");
    });

    it("throws an error instead of silently writing corrupted content", async () => {
      // 构造一个在原文件中完全不存在的 context 行，模拟原文件已被外部修改的场景
      const hunks: PatchHunk[] = [
        {
          header: "@@ -5,3 +5,2 @@",
          lines: [
            { type: "context", content: "    public int ThisMethodDoesNotExist()" },
            { type: "remove",  content: "    {" },
            { type: "remove",  content: "        return 42;" },
            { type: "remove",  content: "    }" },
            { type: "add",     content: "    {" },
            { type: "add",     content: "        return 99;" },
            { type: "add",     content: "    }" },
            { type: "context", content: "}" },
          ],
        },
      ];

      await expect(
        adapter.apply([contextualPatch(filePath, hunks)]),
      ).rejects.toThrow("could not match hunk pattern");

      // 原文件不应被修改
      const written = await readFile(path.join(root, filePath), "utf-8");
      expect(written).toBe(ORIGINAL_FILE);
    });
  });

  describe("when the original file has Windows line endings (\\r\\n)", () => {
    const filePath = "src/WindowsFile.cs";

    beforeEach(async () => {
      const dir = path.join(root, path.dirname(filePath));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(root, filePath), ORIGINAL_FILE.replace(/\n/g, "\r\n"), "utf-8");
    });

    it("still matches context lines and applies the patch correctly", async () => {
      const hunks: PatchHunk[] = [
        {
          header: "@@ -9,5 +9,4 @@",
          lines: [
            { type: "context", content: "    public decimal GetRate(string currencyPair)" },
            { type: "remove",  content: "    {" },
            { type: "remove",  content: "        // TODO: 接入实时汇率" },
            { type: "remove",  content: '        throw new NotImplementedException();' },
            { type: "remove",  content: "    }" },
            { type: "add",     content: "    {" },
            { type: "add",     content: "        return 0.92m;" },
            { type: "add",     content: "    }" },
            { type: "context", content: "}" },
          ],
        },
      ];

      await adapter.apply([contextualPatch(filePath, hunks)]);

      const written = await readFile(path.join(root, filePath), "utf-8");

      // bug：split("\n") 后每行末尾有 \r，context 匹配会失败
      // 期望：和普通 \n 文件一样正确替换
      // 实际：pattern 匹配失败，fallback 导致文件损坏
      expect(written).toContain("Currency Platform");
      expect(written).toContain("return 0.92m;");
      expect(written).not.toContain("throw new NotImplementedException()");
    });
  });

  // ---- abort signal ----

  describe("when an abort signal is passed", () => {
    it("accepts the signal parameter without errors (no-op in current implementation)", async () => {
      const filePath = "src/AbortTest.cs";
      const dir = path.join(root, path.dirname(filePath));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(root, filePath), ORIGINAL_FILE, "utf-8");

      const controller = new AbortController();
      const result = await adapter.apply(
        [fullReplacePatch(filePath, "// replaced\n")],
        controller.signal,
      );

      expect(result.appliedFiles).toEqual([filePath]);
    });
  });
});
