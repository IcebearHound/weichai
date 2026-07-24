/**
 * CodeBackfillPort 实现 — 将翻译结果写回 C# 项目文件
 */

import type { ApplyResult, FilePatch } from "@forexplore/contracts";
import type { CodeBackfillPort } from "@forexplore/workflow-core";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BackfillAdapterOptions {
  /** 文件系统根目录（回填时以此为基准拼接相对路径） */
  projectRoot: string;
}

export class BackfillAdapter implements CodeBackfillPort {
  #projectRoot: string;

  constructor(options: BackfillAdapterOptions) {
    this.#projectRoot = options.projectRoot;
  }

  async apply(
    files: FilePatch[],
    _signal?: AbortSignal,
  ): Promise<ApplyResult> {
    const appliedFiles: string[] = [];

    for (const file of files) {
      const fullPath = join(this.#projectRoot, file.path);

      if (file.status === "modified" && existsSync(fullPath)) {
        const original = readFileSync(fullPath, "utf-8");
        const patched = applyHunks(original, file.hunks);
        writeFileSync(fullPath, patched, "utf-8");
      } else if (file.status === "created") {
        mkdirSync(dirname(fullPath), { recursive: true });
        const newContent = file.hunks
          .flatMap((h) => h.lines)
          .filter((l) => l.type === "add")
          .map((l) => l.content)
          .join("\n");
        writeFileSync(fullPath, newContent, "utf-8");
      }

      appliedFiles.push(file.path);
    }

    return {
      appliedFiles,
      checkpointId: `checkpoint-${Date.now().toString(36)}`,
    };
  }
}

/** 简化版 diff apply —— 把 add/remove lines 应用到原文件 */
function applyHunks(
  original: string,
  hunks: FilePatch["hunks"],
): string {
  const originalLines = original.split("\n");
  const result: string[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      switch (line.type) {
        case "context":
        case "add":
          result.push(line.content);
          break;
        case "remove":
          // 跳过被删除的行
          break;
      }
    }
  }

  // 如果 hunk 只包含 add 和 remove（无 context），则是全文替换
  const hasContext = hunks.some((h) =>
    h.lines.some((l) => l.type === "context"),
  );
  if (!hasContext) {
    return result.join("\n");
  }

  // 有 context 时做行级 patch
  // Phase 1 简化: 直接用 result 覆盖匹配区域
  return result.length > 0 ? result.join("\n") : original;
}
