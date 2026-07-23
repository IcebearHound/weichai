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

function apiErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(
    readonly dimension: number,
    private readonly url: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
    private readonly timeoutMs = 30_000,
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
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Embedding API returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(apiErrorMessage(body) || `Embedding API returned HTTP ${response.status}.`);
    }
    if (typeof body !== 'object' || body === null) {
      throw new Error('Embedding API returned an invalid response body.');
    }
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error('Embedding API returned an unexpected number of vectors.');
    }
    const items = data.map((item) => {
      if (typeof item !== 'object' || item === null) return null;
      const { index, embedding } = item as { index?: unknown; embedding?: unknown };
      if (
        !Number.isInteger(index) ||
        !Array.isArray(embedding) ||
        !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        return null;
      }
      return { index: Number(index), embedding };
    });
    if (
      items.some((item) => item === null) ||
      new Set(items.map((item) => item?.index)).size !== texts.length ||
      items.some((item) => (item?.index ?? -1) < 0 || (item?.index ?? -1) >= texts.length)
    ) {
      throw new Error('Embedding API returned malformed vector entries.');
    }
    const vectors = items
      .sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0))
      .map((item) => item?.embedding ?? []);
    if (vectors.some((vector) => vector.length !== this.dimension)) {
      throw new Error(`Embedding API did not return ${this.dimension}-dimensional vectors.`);
    }
    return vectors;
  }
}
