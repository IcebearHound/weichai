import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractCorpus } from './index.js';

const temporaryRoots: string[] = [];

async function createCorpus(manifest: string): Promise<{
  manifestPath: string;
  root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-code-indexer-'));
  temporaryRoots.push(root);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, manifest, 'utf8');
  return { manifestPath, root };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('corpus manifest validation', () => {
  it('wraps malformed JSON with a stable error and preserves the cause', async () => {
    const { manifestPath, root } = await createCorpus('{');

    let failure: unknown;
    try {
      await extractCorpus(root);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const manifestError = failure as Error;
    expect(manifestError.message).toContain(`Invalid corpus manifest ${manifestPath}:`);
    expect(manifestError.cause).toBeInstanceOf(SyntaxError);
    expect(manifestError.message).toContain((manifestError.cause as Error).message);
  });

  it('reports invalid retrieval metadata through the manifest error contract', async () => {
    const { manifestPath, root } = await createCorpus(
      JSON.stringify({ language: 'TypeScript' }),
    );

    await expect(extractCorpus(root)).rejects.toThrow(
      `Invalid corpus manifest ${manifestPath}: Corpus manifest ${manifestPath} has invalid retrieval metadata.`,
    );
  });

  it('rejects source roots outside the repository', async () => {
    const { root } = await createCorpus(
      JSON.stringify({
        repository: 'escaped',
        language: 'TypeScript',
        sourceRoot: '..',
      }),
    );

    await expect(extractCorpus(root)).rejects.toThrow(
      'sourceRoot must stay inside',
    );
  });
});
