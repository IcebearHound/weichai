import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepositoryIndexRecord, RepositoryStatus } from './vendor/contracts';

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  '.codex',
  'coverage',
]);

const MAX_SCAN_DEPTH = 8;
const MAX_ENTRIES = 20_000;

/** Latest file modification time (ms) under the directory, or null when empty/unreadable. */
export async function latestMtime(root: string): Promise<number | null> {
  let newest: number | null = null;
  let visited = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (visited >= MAX_ENTRIES || depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_ENTRIES) return;
      visited += 1;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await walk(path.join(directory, entry.name), depth + 1);
        }
        continue;
      }
      try {
        const stat = await fs.stat(path.join(directory, entry.name));
        if (stat.isFile() && stat.mtimeMs > (newest ?? 0)) {
          newest = stat.mtimeMs;
        }
      } catch {
        // Unreadable file: ignore for mtime purposes.
      }
    }
  }

  try {
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) return null;
    await walk(root, 0);
  } catch {
    return null;
  }
  return newest;
}

export async function checkRepositoryStatus(
  repositoryPath: string,
  record: RepositoryIndexRecord | undefined,
): Promise<RepositoryStatus> {
  const resolved = path.resolve(repositoryPath);
  let exists = false;
  let readable = false;
  try {
    const stat = await fs.stat(resolved);
    exists = true;
    readable = stat.isDirectory() && (await isReadable(resolved));
  } catch {
    exists = false;
  }

  if (!exists) {
    return {
      path: repositoryPath,
      exists: false,
      readable: false,
      indexed: false,
      stale: false,
      message: '路径不存在，请检查 forexplore.repositoryPaths 设置。',
    };
  }
  if (!readable) {
    return {
      path: repositoryPath,
      exists: true,
      readable: false,
      indexed: false,
      stale: false,
      message: '路径不是可读目录。',
    };
  }

  const indexed = record !== undefined;
  let stale = false;
  let message = indexed ? '已索引' : '尚未索引';
  if (indexed && record) {
    const newest = await latestMtime(resolved);
    if (newest !== null && newest > record.indexedAt) {
      stale = true;
      message = '索引已过期，需要重新索引';
    }
  }
  return { path: repositoryPath, exists: true, readable: true, indexed, stale, message };
}

async function isReadable(directory: string): Promise<boolean> {
  try {
    await fs.access(directory, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
