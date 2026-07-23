import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractSymbols, indexCorpus } from './corpus-indexer.js';

describe('extractSymbols', () => {
  it('extracts TypeScript classes, methods, and top-level functions', () => {
    const symbols = extractSymbols(
      `
/** Coordinates cache refreshes. */
export class QuoteCache {
  async get(key: string): Promise<string> { return key; }
}

export async function loadQuote(id: string): Promise<string> {
  return id;
}
`,
      'TypeScript',
    );
    expect(symbols.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: 'class', name: 'QuoteCache' },
      { kind: 'function', name: 'get' },
      { kind: 'function', name: 'loadQuote' },
    ]);
    expect(symbols[0]?.summary).toContain('Coordinates cache refreshes');
  });

  it('extracts Python, Rust, Go, and Java declarations', () => {
    expect(extractSymbols('class Cache:\n    pass\n\ndef load():\n    pass', 'Python')).toHaveLength(2);
    expect(
      extractSymbols('pub struct Cache {}\nimpl Cache { pub fn load(&self) {} }', 'Rust').map(
        (symbol) => symbol.name,
      ),
    ).toContain('Cache');
    expect(
      extractSymbols('type Cache struct {}\nfunc (c Cache) Load() {}', 'Go').map(
        (symbol) => symbol.name,
      ),
    ).toEqual(['Cache', 'Load']);
    expect(extractSymbols('public final class Cache {}', 'Java')[0]?.name).toBe('Cache');
  });

  it('discovers the updated Java translation dataset and indexes its methods', async () => {
    const datasetRoot = fileURLToPath(
      new URL('../../../fixtures/translation-datasets', import.meta.url),
    );
    const documents = await indexCorpus(datasetRoot);

    expect(documents.length).toBeGreaterThan(79);
    expect(
      documents.some(
        (document) =>
          document.title === 'apply' &&
          document.path.endsWith('application/SettlementBatch.java'),
      ),
    ).toBe(true);
    expect(documents.every((document) => document.language === 'Java')).toBe(true);
  });

  it('rejects malformed manifests and source roots outside the repository', async () => {
    const malformed = await mkdtemp(path.join(tmpdir(), 'forexplore-malformed-'));
    await writeFile(path.join(malformed, 'manifest.json'), '{', 'utf8');
    await expect(indexCorpus(malformed)).rejects.toThrow('Invalid corpus manifest');

    const invalidMetadata = await mkdtemp(path.join(tmpdir(), 'forexplore-invalid-'));
    await writeFile(
      path.join(invalidMetadata, 'manifest.json'),
      JSON.stringify({ language: 'TypeScript' }),
      'utf8',
    );
    await expect(indexCorpus(invalidMetadata)).rejects.toThrow(
      'invalid retrieval metadata',
    );

    const escaped = await mkdtemp(path.join(tmpdir(), 'forexplore-escaped-'));
    await writeFile(
      path.join(escaped, 'manifest.json'),
      JSON.stringify({
        repository: 'escaped',
        language: 'TypeScript',
        sourceRoot: '..',
      }),
      'utf8',
    );
    await expect(indexCorpus(escaped)).rejects.toThrow('sourceRoot must stay inside');
  });
});
