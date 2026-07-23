import type { EmbeddingProvider } from './types.js';

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function features(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const grams: string[] = [];
  for (const word of words) {
    grams.push(`w:${word}`);
    if (word.length < 3) continue;
    for (let index = 0; index <= word.length - 3; index += 1) {
      grams.push(`g:${word.slice(index, index + 3)}`);
    }
  }
  return grams;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

/**
 * An offline feature-hashing embedder. It is deterministic and useful for
 * development, but an OpenAI-compatible embedding model should be used when
 * semantic quality matters.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimension = 384) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array.from({ length: this.dimension }, () => 0);
      for (const feature of features(text)) {
        const hash = fnv1a(feature);
        const position = hash % this.dimension;
        const sign = (hash & 0x80000000) === 0 ? 1 : -1;
        vector[position] = (vector[position] ?? 0) + sign;
      }
      return normalize(vector);
    });
  }
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
  error?: { message?: string };
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(
    readonly dimension: number,
    private readonly url: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.request(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        dimensions: this.dimension,
        encoding_format: 'float',
      }),
    });
    const body = (await response.json()) as OpenAiEmbeddingResponse;
    if (!response.ok) {
      throw new Error(body.error?.message || `Embedding API returned HTTP ${response.status}.`);
    }
    if (!Array.isArray(body.data) || body.data.length !== texts.length) {
      throw new Error('Embedding API returned an unexpected number of vectors.');
    }
    const vectors = [...body.data]
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
    if (vectors.some((vector) => vector.length !== this.dimension)) {
      throw new Error(`Embedding API did not return ${this.dimension}-dimensional vectors.`);
    }
    return vectors;
  }
}
