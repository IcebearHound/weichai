import type { SearchCandidate, SearchRequest } from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import { buildRerankPrompt, OpenAiCompatibleReranker } from './reranker.js';

const request: SearchRequest = {
  target: {
    id: 'target',
    name: 'getQuote',
    kind: 'function',
    path: 'src/quote.ts',
    language: 'TypeScript',
    signature: 'getQuote(input: QuoteInput): Promise<Quote>',
  },
  requirement: 'use a stale cache when the quote provider is unavailable',
  topK: 2,
  retrievalMode: 'hybrid',
  repositoryScopes: [],
};

function candidate(id: string): SearchCandidate {
  return {
    id,
    title: `${id}.getOrLoad`,
    repository: 'example/cache',
    license: 'Apache-2.0',
    language: 'Java',
    kind: 'function',
    path: `src/${id}.java`,
    signature: 'Quote getOrLoad(QuoteRequest request)',
    summary: 'Loads a quote and falls back to an unexpired stale cache value.',
    score: { overall: 0.8, semantic: 0.8, symbol: 0.8, contract: 0.8 },
    preview: 'Quote getOrLoad(QuoteRequest request) { return cache.load(request); }',
    dependencies: ['QuoteCache', 'QuoteProvider'],
    compatibility: ['async'],
    risks: ['stale data'],
  };
}

function successfulResponse(id = 'first'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify([{ id, score: 0.9 }]) } }],
    }),
  );
}

function reranker(fetchImpl: typeof globalThis.fetch): OpenAiCompatibleReranker {
  return new OpenAiCompatibleReranker(
    'test-model',
    'https://rerank.example.test/v1/chat/completions',
    'test-key',
    50,
    2,
    0,
    20,
    fetchImpl,
  );
}

describe('buildRerankPrompt', () => {
  it('includes implementation evidence rather than only a title and summary', () => {
    const prompt = buildRerankPrompt(request, [candidate('cache')]);

    expect(prompt.user).toContain('Quote getOrLoad(QuoteRequest request)');
    expect(prompt.user).toContain('QuoteCache, QuoteProvider');
    expect(prompt.user).toContain('stale data');
    expect(prompt.user).toContain('return cache.load(request)');
    expect(prompt.user).toContain('必须且只能为每个给定 id 输出一项');
  });
});

describe('OpenAiCompatibleReranker', () => {
  it.each([429, 503])('retries retryable HTTP %i responses', async (status) => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'try again' } }), { status }))
      .mockResolvedValueOnce(successfulResponse());

    await expect(reranker(fetchImpl as unknown as typeof fetch).rerank(request, [candidate('first')]))
      .resolves.toEqual([{ id: 'first', score: 0.9, reason: 'rank 1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries timeout errors produced by AbortSignal.timeout', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))
      .mockResolvedValueOnce(successfulResponse());

    await expect(reranker(fetchImpl as unknown as typeof fetch).rerank(request, [candidate('first')]))
      .resolves.toEqual([{ id: 'first', score: 0.9, reason: 'rank 1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent HTTP failures', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }));

    await expect(reranker(fetchImpl as unknown as typeof fetch).rerank(request, [candidate('first')]))
      .rejects.toThrow('bad request');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
