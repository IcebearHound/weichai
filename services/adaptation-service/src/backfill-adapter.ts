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

      if (file.status === "modified") {
        if (!existsSync(fullPath)) {
          throw new Error(`Cannot modify "${file.path}": file does not exist`);
        }
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

/**
 * 将 unified-diff 风格的 hunks 应用到原文件内容。
 *
 * - 无 context 行：全量替换（直接返回 add 行，跳过 remove 行）。
 * - 有 context 行：用 context + remove 行在原文件中定位匹配位置，
 *   仅替换匹配区域为 context + add 行，区域外的原始内容原样保留。
 */
function applyHunks(
  original: string,
  hunks: FilePatch["hunks"],
): string {
  // 归一化 Windows 换行符，避免 context 匹配失败
  const originalLines = original.replace(/\r\n/g, "\n").split("\n");

  const hasContext = hunks.some((h) =>
    h.lines.some((l) => l.type === "context"),
  );

  if (!hasContext) {
    // 无 context → 全量替换：收集所有非 remove 行
    const result: string[] = [];
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.type !== "remove") {
          result.push(line.content);
        }
      }
    }
    return result.join("\n");
  }

  // 有 context → 行级 patch：在原文件中定位每个 hunk 并替换
  const result: string[] = [];
  let originalIdx = 0;

  for (const hunk of hunks) {
    // 构建 old-side 模式（context + remove），用于在原文件中定位
    const oldPattern = hunk.lines
      .filter((l) => l.type === "context" || l.type === "remove")
      .map((l) => l.content);

    // 在原文件中查找匹配位置
    const matchIdx = findPattern(originalLines, oldPattern, originalIdx);

    // 保留匹配位置之前的原始行
    result.push(...originalLines.slice(originalIdx, matchIdx));

    // 输出 hunk 的 new-side（context + add），跳过 remove
    for (const line of hunk.lines) {
      if (line.type === "context" || line.type === "add") {
        result.push(line.content);
      }
    }

    // 跳过原文件中已匹配的区域
    originalIdx = matchIdx + oldPattern.length;
  }

  // 保留最后一个 hunk 之后的所有原始行
  result.push(...originalLines.slice(originalIdx));

  return result.join("\n");
}

/** 在 lines 中从 startFrom 开始查找 pattern 的精确匹配位置 */
function findPattern(
  lines: string[],
  pattern: string[],
  startFrom: number,
): number {
  if (pattern.length === 0) return startFrom;

  for (let i = startFrom; i <= lines.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }

  throw new Error(
    `applyHunks: could not match hunk pattern at or after line ${startFrom + 1}. ` +
    `The original file may have been modified since the patch was generated.`,
  );
}
