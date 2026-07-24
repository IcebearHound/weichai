import type { AddressInfo } from 'node:net';
import type { SearchCandidate, SearchRequest } from '@forexplore/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from './http-server.js';
import type { SearchEngine, SearchStore } from './types.js';

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

function store(): SearchStore {
  return {
    ping: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
    refreshIndex: vi.fn(async () => undefined),
    semanticSearch: vi.fn(async () => []),
    textSearch: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  };
}

async function listen(
  engine: SearchEngine,
  searchStore: SearchStore,
): Promise<string> {
  const server = createHttpServer({
    engine,
    store: searchStore,
    corsOrigin: 'http://localhost:4173',
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const request: SearchRequest = {
  target: {
    id: 'target',
    name: 'getQuote',
    kind: 'function',
    path: 'quote.ts',
    language: 'TypeScript',
    signature: 'getQuote(): Promise<Quote>',
  },
  requirement: 'add a resilient cache',
  topK: 3,
  retrievalMode: 'hybrid',
  repositoryScopes: [],
};

describe('retrieval HTTP API', () => {
  it('checks SeekDB health and serves the shared search contract', async () => {
    const candidate = { id: 'cache' } as SearchCandidate;
    const engine: SearchEngine = {
      search: vi.fn(async () => [candidate]),
    };
    const searchStore = store();
    const url = await listen(engine, searchStore);

    const health = await fetch(`${url}/health`);
    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(await health.json()).toEqual({ status: 'ok', storage: 'seekdb' });
    expect(await response.json()).toEqual({ candidates: [candidate] });
    expect(searchStore.ping).toHaveBeenCalledOnce();
    expect(engine.search).toHaveBeenCalledWith(request);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:4173',
    );
  });

  it('rejects malformed search requests before querying the engine', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store());

    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topK: 0 }),
    });

    expect(response.status).toBe(400);
    expect(engine.search).not.toHaveBeenCalled();
  });

  it('reports invalid JSON and oversized bodies as client errors', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store());

    const invalidJson = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const oversized = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(1024 * 1024 + 1),
    });

    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: 'Request body must be valid JSON.' });
    expect(oversized.status).toBe(413);
    expect(engine.search).not.toHaveBeenCalled();
  });
});
