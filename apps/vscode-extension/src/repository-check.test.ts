import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRepositoryStatus, latestMtime } from './repository-check';

const tempDirectories: string[] = [];

async function makeTempRepo(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'forexplore-check-'));
  tempDirectories.push(directory);
  await mkdir(path.join(directory, 'src'), { recursive: true });
  await writeFile(path.join(directory, 'src', 'sample.ts'), 'export const value = 1;\n');
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('latestMtime', () => {
  it('returns the newest file mtime under the directory', async () => {
    const repo = await makeTempRepo();
    const now = Date.now();
    const newest = await latestMtime(repo);
    expect(newest).not.toBeNull();
    expect(newest!).toBeGreaterThan(now - 10_000);
  });

  it('returns null for a missing directory', async () => {
    expect(await latestMtime(path.join(tmpdir(), 'definitely-missing-' + Date.now()))).toBeNull();
  });
});

describe('checkRepositoryStatus', () => {
  it('flags missing paths', async () => {
    const status = await checkRepositoryStatus(path.join(tmpdir(), 'missing-' + Date.now()), undefined);
    expect(status.exists).toBe(false);
    expect(status.readable).toBe(false);
    expect(status.indexed).toBe(false);
    expect(status.message).toContain('路径不存在');
  });

  it('flags not-indexed directories', async () => {
    const repo = await makeTempRepo();
    const status = await checkRepositoryStatus(repo, undefined);
    expect(status.exists).toBe(true);
    expect(status.readable).toBe(true);
    expect(status.indexed).toBe(false);
    expect(status.stale).toBe(false);
  });

  it('flags stale indexes when files changed after indexing', async () => {
    const repo = await makeTempRepo();
    const status = await checkRepositoryStatus(repo, {
      path: repo,
      indexedAt: Date.now() - 60_000,
      symbolCount: 1,
    });
    expect(status.indexed).toBe(true);
    expect(status.stale).toBe(true);
  });

  it('treats fresh indexes as ready', async () => {
    const repo = await makeTempRepo();
    const newest = await latestMtime(repo);
    const status = await checkRepositoryStatus(repo, {
      path: repo,
      indexedAt: (newest ?? Date.now()) + 1_000,
      symbolCount: 1,
    });
    expect(status.indexed).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.message).toBe('已索引');
  });
});
