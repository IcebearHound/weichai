import { describe, expect, it } from 'vitest';
import { HashEmbeddingProvider, OpenAiCompatibleEmbeddingProvider } from './embedding.js';

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

describe('HashEmbeddingProvider', () => {
  it('creates deterministic, normalized vectors with useful lexical similarity', async () => {
    const provider = new HashEmbeddingProvider(64);
    const [first, repeated, related, unrelated] = await provider.embed([
      'async ttl cache with stale fallback',
      'async ttl cache with stale fallback',
      'ttl cache and request fallback',
      'database schema migration ledger',
    ]);

    expect(first).toHaveLength(64);
    expect(first).toEqual(repeated);
    expect(Math.sqrt(dot(first!, first!))).toBeCloseTo(1, 6);
    expect(dot(first!, related!)).toBeGreaterThan(dot(first!, unrelated!));
  });
});

describe('OpenAiCompatibleEmbeddingProvider', () => {
  it('sorts and validates OpenAI-compatible vectors', async () => {
    const request = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
      );
    const provider = new OpenAiCompatibleEmbeddingProvider(
      2,
      'https://example.test/embeddings',
      'test-key',
      'test-model',
      request,
    );

    await expect(provider.embed(['first', 'second'])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('rejects duplicate indexes and non-finite vector values', async () => {
    const request = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 0, embedding: [1, null] },
          ],
        }),
      );
    const provider = new OpenAiCompatibleEmbeddingProvider(
      2,
      'https://example.test/embeddings',
      'test-key',
      'test-model',
      request,
    );

    await expect(provider.embed(['first', 'second'])).rejects.toThrow(
      'malformed vector entries',
    );
  });
});
