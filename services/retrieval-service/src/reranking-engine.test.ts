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
    const base = baseEngine();
    const engine = new RerankingSearchEngine(
      base,
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
    expect(base.search).toHaveBeenCalledWith(expect.objectContaining({ topK: 20 }));
  });

  it('retries a contract failure with structured feedback and accepts the repair', async () => {
    const rerank = vi.fn()
      .mockResolvedValueOnce([{ id: 'second', score: 0.9, reason: 'only result' }])
      .mockResolvedValueOnce([
        { id: 'first', score: 0.2, reason: 'weak' },
        { id: 'second', score: 0.9, reason: 'strong' },
        { id: 'third', score: 0.5, reason: 'medium' },
      ]);
    const engine = new RerankingSearchEngine(baseEngine(), { model: 'test', rerank }, 20, 2);

    await expect(engine.search(request)).resolves.toMatchObject([
      { id: 'second', score: { rerank: 0.9 } },
      { id: 'third', score: { rerank: 0.5 } },
    ]);
    expect(rerank).toHaveBeenCalledTimes(2);
    expect(rerank.mock.calls[1]?.[2]).toMatchObject({
      attempt: 1,
      message: expect.stringContaining('Missing candidate IDs'),
    });
  });

  it('fails after exhausted contract repairs instead of falling back', async () => {
    const invalid = [
      { id: 'first', score: 0.2, reason: 'first' },
      { id: 'second', score: 0.9, reason: 'second' },
      { id: 'invented', score: 1, reason: 'not a candidate' },
    ];
    const rerank = vi.fn(async () => invalid);
    const engine = new RerankingSearchEngine(baseEngine(), { model: 'test', rerank }, 20, 1);

    await expect(engine.search(request)).rejects.toThrow(
      'DeepSeek reranking violated the candidate contract after 2 attempts',
    );
    expect(rerank).toHaveBeenCalledTimes(2);
  });
});
