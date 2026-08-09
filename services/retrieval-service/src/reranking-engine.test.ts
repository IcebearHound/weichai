import type { SearchCandidate, SearchRequest } from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import { RerankingSearchEngine } from './reranking-engine.js';
import type { LlmReranker, SearchEngine } from './types.js';

const request: SearchRequest = {
  target: {
    id: 'target',
    name: 'getQuote',
    kind: 'function',
    path: 'src/quote.ts',
    language: 'TypeScript',
    signature: 'getQuote(): Promise<Quote>',
  },
  requirement: 'load a quote from cache',
  topK: 2,
  retrievalMode: 'hybrid',
  repositoryScopes: [],
};

function candidate(id: string, overall: number): SearchCandidate {
  return {
    id,
    title: id,
    repository: 'example/repository',
    license: 'Apache-2.0',
    language: 'Java',
    kind: 'function',
    path: `${id}.java`,
    signature: `${id}()`,
    summary: id,
    score: { overall, semantic: overall, symbol: overall, contract: overall },
    preview: `${id}() {}`,
    dependencies: [],
    compatibility: [],
    risks: [],
  };
}

const candidates = [candidate('first', 0.9), candidate('second', 0.7), candidate('third', 0.5)];

function baseEngine(): SearchEngine {
  return { search: vi.fn(async () => candidates) };
}

function reranker(
  results: Array<{ id: string; score: number; reason: string }>,
): LlmReranker {
  return { model: 'test', rerank: vi.fn(async () => results) };
}

describe('RerankingSearchEngine', () => {
  it('uses a complete, known rerank response to reorder candidates', async () => {
    const engine = new RerankingSearchEngine(
      baseEngine(),
      reranker([
        { id: 'first', score: 0.2, reason: 'weak' },
        { id: 'second', score: 0.9, reason: 'strong' },
        { id: 'third', score: 0.5, reason: 'medium' },
      ]),
    );

    await expect(engine.search(request)).resolves.toMatchObject([
      { id: 'second', score: { rerank: 0.9 }, rerankReason: 'strong' },
      { id: 'third', score: { rerank: 0.5 }, rerankReason: 'medium' },
    ]);
  });

  it.each([
    ['partial', [{ id: 'second', score: 0.9, reason: 'only result' }]],
    ['duplicate', [
      { id: 'second', score: 0.9, reason: 'first copy' },
      { id: 'second', score: 0.8, reason: 'second copy' },
      { id: 'third', score: 0.7, reason: 'third' },
    ]],
    ['unknown', [
      { id: 'first', score: 0.2, reason: 'first' },
      { id: 'second', score: 0.9, reason: 'second' },
      { id: 'invented', score: 1, reason: 'not a candidate' },
    ]],
  ] as const)('falls back to the original order on a %s rerank response', async (_kind, results) => {
    const engine = new RerankingSearchEngine(baseEngine(), reranker(results));

    await expect(engine.search(request)).resolves.toEqual(candidates.slice(0, request.topK));
  });
});
