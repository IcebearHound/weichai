import { describe, expect, it } from 'vitest';
import { HashEmbeddingProvider } from './embedding.js';

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
