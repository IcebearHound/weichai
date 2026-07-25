import type {
  AdaptationRequest,
  AdaptationResult,
  ApplyResult,
  FilePatch,
} from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  AdaptationHttpAdapter,
  BackfillHttpAdapter,
  withAdaptationService,
} from './adaptation-http-adapter';

const request: AdaptationRequest = {
  target: {
    id: 'target',
    name: 'GetQuoteAsync',
    kind: 'function',
    path: 'src/Application/QuoteOrchestrationService.cs',
    language: 'C#',
    signature: 'public Task<Quote> GetQuoteAsync(QuoteRequest request)',
  },
  candidate: {
    id: 'candidate',
    title: 'QuoteCache.getOrLoad',
    repository: 'reference-java',
    license: 'MIT',
    language: 'Java',
    kind: 'function',
    path: 'QuoteCache.java',
    signature: 'Quote getOrLoad(QuoteRequest request)',
    summary: 'cache',
    score: { overall: 0.9, semantic: 0.9, symbol: 0.8, contract: 0.9 },
    preview: 'public Quote getOrLoad(QuoteRequest request) { return load(request); }',
    dependencies: [],
    compatibility: [],
    risks: [],
  },
  requirement: 'cache quotes',
  strategy: 'translate',
  decisionNotes: '',
};

const adaptationResult: AdaptationResult = {
  strategy: 'translate',
  targetLanguage: 'C#',
  generatedCode: 'public Task<Quote> GetQuoteAsync(QuoteRequest request) => Load(request);',
  interfaceMappings: [],
  validation: [],
  files: [],
};

const patches: FilePatch[] = [];
const applyResult: ApplyResult = {
  appliedFiles: [],
  checkpointId: 'checkpoint-1',
};

describe('adaptation HTTP adapters', () => {
  it('posts adaptation requests and validates responses', async () => {
    const fetch = vi.fn(async () => Response.json(adaptationResult));
    const adapter = new AdaptationHttpAdapter({
      baseUrl: 'http://127.0.0.1:8788/',
      fetch,
    });

    await expect(adapter.adapt(request)).resolves.toEqual(adaptationResult);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/v1/adapt',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
  });

  it('posts backfill requests and validates responses', async () => {
    const fetch = vi.fn(async () => Response.json(applyResult));
    const adapter = new BackfillHttpAdapter({
      baseUrl: 'http://127.0.0.1:8788/',
      fetch,
    });

    await expect(adapter.apply(patches)).resolves.toEqual(applyResult);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/v1/backfill',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(patches) }),
    );
  });

  it('surfaces service errors', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: 'DeepSeek API error 401' }, { status: 502 }),
    );
    const adapter = new AdaptationHttpAdapter({ baseUrl: 'http://localhost', fetch });

    await expect(adapter.adapt(request)).rejects.toThrow('DeepSeek API error 401');
  });

  it('rejects malformed successful responses', async () => {
    const fetch = vi.fn(async () => Response.json({ generatedCode: 'incomplete' }));
    const adapter = new AdaptationHttpAdapter({ baseUrl: 'http://localhost', fetch });

    await expect(adapter.adapt(request)).rejects.toThrow('invalid response');
  });

  it('replaces both remote workflow ports as one service boundary', () => {
    const ports = withAdaptationService(
      { adaptation: { adapt: vi.fn() }, backfill: { apply: vi.fn() }, search: {} as never },
      { baseUrl: 'http://localhost' },
    );

    expect(ports.adaptation).toBeInstanceOf(AdaptationHttpAdapter);
    expect(ports.backfill).toBeInstanceOf(BackfillHttpAdapter);
  });
});
