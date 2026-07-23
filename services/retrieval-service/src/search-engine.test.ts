import type { SearchRequest } from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import { SeekDbSearchEngine, searchInternals } from './search-engine.js';
import type {
  EmbeddingProvider,
  RetrievedCodeDocument,
  SearchStore,
} from './types.js';

const baseDocument: RetrievedCodeDocument = {
  id: 'cache',
  title: 'AsyncTTLCache.get_or_load',
  repository: 'demo/cache',
  license: 'Apache-2.0',
  language: 'Python',
  kind: 'function',
  path: 'cache.py',
  signature: 'async def get_or_load(key, loader)',
  summary: 'TTL cache with stale fallback',
  preview: 'async def get_or_load(): pass',
  dependencies: [],
  compatibility: ['async'],
  risks: [],
};

const request: SearchRequest = {
  target: {
    id: 'target',
    name: 'getQuote',
    kind: 'function',
    path: 'quote.ts',
    language: 'TypeScript',
    signature: 'getQuote(): Promise<Quote>',
  },
  requirement: 'add ttl cache and stale fallback',
  topK: 2,
  retrievalMode: 'hybrid',
  repositoryScopes: ['configured-repositories', 'repo:demo/cache'],
};

function fakeStore(): SearchStore {
  return {
    ping: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
    refreshIndex: vi.fn(async () => undefined),
    semanticSearch: vi.fn(async () => [
      { ...baseDocument, semanticScore: 0.92 },
      {
        ...baseDocument,
        id: 'queue',
        title: 'Queue.push',
        semanticScore: 0.3,
      },
    ]),
    textSearch: vi.fn(async () => [{ ...baseDocument, textScore: 0.88 }]),
    close: vi.fn(async () => undefined),
  };
}

const embeddings: EmbeddingProvider = {
  dimension: 3,
  embed: vi.fn(async () => [[1, 0, 0]]),
};

describe('SeekDbSearchEngine', () => {
  it('queries vector and full-text indexes and fuses duplicate candidates', async () => {
    const store = fakeStore();
    const engine = new SeekDbSearchEngine(store, embeddings);

    const candidates = await engine.search(request);

    expect(candidates[0]?.id).toBe('cache');
    expect(candidates).toHaveLength(2);
    expect(store.semanticSearch).toHaveBeenCalledWith(
      [1, 0, 0],
      expect.objectContaining({ repositories: ['demo/cache'] }),
      50,
    );
    expect(store.textSearch).toHaveBeenCalledOnce();
  });

  it('uses only full-text search for structure mode', async () => {
    const store = fakeStore();
    const provider: EmbeddingProvider = {
      dimension: 3,
      embed: vi.fn(async () => [[1, 0, 0]]),
    };
    const engine = new SeekDbSearchEngine(store, provider);

    await engine.search({ ...request, retrievalMode: 'structure' });

    expect(provider.embed).not.toHaveBeenCalled();
    expect(store.semanticSearch).not.toHaveBeenCalled();
    expect(store.textSearch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: 'function' }),
      50,
    );
  });
});

describe('search internals', () => {
  it('ignores UI labels while preserving explicit repository scopes', () => {
    expect(
      searchInternals.repositoryScopes([
        'configured-repositories',
        'mock-catalog',
        'repo:oceanbase/seekdb',
        'chiparon/weichai',
        'org/*',
      ]),
    ).toEqual(['oceanbase/seekdb', 'chiparon/weichai']);
  });

  it('expands camel-case symbols and target paths into searchable domain terms', () => {
    const settlementRequest: SearchRequest = {
      ...request,
      target: {
        id: 'settle-batch',
        name: 'settleBatch',
        kind: 'function',
        path: 'src/application/settlement/settlement-service.ts',
        language: 'TypeScript',
        signature:
          'settleBatch(request: SettlementBatchRequest): Promise<SettlementBatchResult>',
      },
      requirement: 'settleBatch',
    };

    const query = searchInternals.queryText(settlementRequest);
    expect(query).toContain('settle');
    expect(query).toContain('batch');
    expect(query).toContain('settlement');
    expect(searchInternals.overlap('settleBatch', 'settlement batch queue')).toBeGreaterThan(0);
  });

  it('reranks a broad but bounded candidate pool for large corpora', () => {
    expect(searchInternals.expandedLimit(1)).toBe(50);
    expect(searchInternals.expandedLimit(20)).toBe(100);
    expect(searchInternals.expandedLimit(50)).toBe(250);
  });
});
