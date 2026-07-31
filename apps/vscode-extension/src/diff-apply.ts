import type { PatchHunk } from './vendor/contracts';
import path from 'node:path';

export function parseHunkHeader(header: string): { oldStart: number } | null {
  const match = header.match(/^@@ -(\d+)(?:,\d+)? \+/);
  if (!match?.[1]) return null;
  return { oldStart: Number(match[1]) };
}

/** Applies hunks (anchored at their `oldStart` line) onto the current content. */
export function applyHunks(content: string, hunks: PatchHunk[]): string {
  const lines = content.split(/\r?\n/);
  let lineDelta = 0;
  for (const hunk of hunks) {
    const parsed = parseHunkHeader(hunk.header);
    if (!parsed) continue;
    let cursor = Math.max(0, Math.min(parsed.oldStart - 1 + lineDelta, lines.length));
    for (const line of hunk.lines) {
      if (line.type === 'remove') {
        if (cursor < lines.length) {
          lines.splice(cursor, 1);
          lineDelta -= 1;
        }
      } else if (line.type === 'add') {
        lines.splice(cursor, 0, line.content);
        cursor += 1;
        lineDelta += 1;
      } else {
        cursor += 1;
      }
    }
  }
  return lines.join('\n');
}

export function linesFromHunks(hunks: PatchHunk[]): string[] {
  return hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => line.type === 'add').map((line) => line.content),
  );
}

/**
 * Resolves a patch path against the workspace root. Absolute patch paths
 * (as produced by the adaptation services from editor targets) are used
 * verbatim; relative paths are anchored to the opened workspace folder.
 */
export function resolvePatchPath(
  workspaceRoot: string | undefined,
  filePath: string,
): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (!workspaceRoot) {
    throw new Error('请先打开一个工作区文件夹，再应用翻译补丁。');
  }
  return path.resolve(workspaceRoot, filePath);
}
