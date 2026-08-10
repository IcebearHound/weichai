import type { PatchHunk } from '@forexplore/contracts';

/**
 * Applies a unified-diff-like patch only when each old-side line matches the
 * inspected source exactly. Line headers are explanatory, not authority for a
 * destructive edit: context/remove content is the precondition.
 */
export function applyHunksStrict(original: string, hunks: PatchHunk[]): string {
  if (hunks.length === 0) {
    throw new Error('Patch contains no hunks.');
  }

  const originalLines = original.replace(/\r\n/g, '\n').split('\n');
  const result: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const oldSide = hunk.lines
      .filter((line) => line.type === 'context' || line.type === 'remove')
      .map((line) => line.content);
    if (oldSide.length === 0) {
      throw new Error(`Patch hunk ${hunk.header} has no source precondition.`);
    }

    const matchIndex = findExactSequence(originalLines, oldSide, cursor);
    if (matchIndex < 0) {
      throw new Error(
        `Patch hunk ${hunk.header} no longer matches the original file; regenerate the migration run.`,
      );
    }

    result.push(...originalLines.slice(cursor, matchIndex));
    for (const line of hunk.lines) {
      if (line.type === 'context' || line.type === 'add') result.push(line.content);
    }
    cursor = matchIndex + oldSide.length;
  }

  result.push(...originalLines.slice(cursor));
  return result.join('\n');
}

export function newFileContent(hunks: PatchHunk[]): string {
  if (hunks.length === 0) throw new Error('Patch contains no hunks.');
  const invalid = hunks.some((hunk) =>
    hunk.lines.some((line) => line.type !== 'add'),
  );
  if (invalid) {
    throw new Error('A created-file patch may contain only added lines.');
  }
  return hunks.flatMap((hunk) => hunk.lines.map((line) => line.content)).join('\n');
}

function findExactSequence(lines: string[], pattern: string[], from: number): number {
  for (let index = from; index <= lines.length - pattern.length; index += 1) {
    if (pattern.every((line, offset) => lines[index + offset] === line)) return index;
  }
  return -1;
}
