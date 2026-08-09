import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('requests dimensions by default for the default OpenAI embedding model', () => {
    const config = loadConfig({
      SEEKDB_EMBEDDING_PROVIDER: 'openai',
      SEEKDB_EMBEDDING_API_KEY: 'test-key',
    });

    expect(config.embedding).toMatchObject({
      provider: 'openai',
      model: 'text-embedding-3-small',
      supportsDimensions: true,
    });
  });

  it('allows an OpenAI-compatible provider to opt out of dimensions', () => {
    const config = loadConfig({
      SEEKDB_EMBEDDING_PROVIDER: 'openai',
      SEEKDB_EMBEDDING_API_KEY: 'test-key',
      SEEKDB_EMBEDDING_SUPPORTS_DIMENSIONS: 'false',
    });

    expect(config.embedding).toMatchObject({
      provider: 'openai',
      supportsDimensions: false,
    });
  });

  it('allows reranking retries to be disabled explicitly', () => {
    const config = loadConfig({
      RERANK_PROVIDER: 'local',
      RERANK_MAX_RETRIES: '0',
    });

    expect(config.reranking).toMatchObject({ provider: 'local', maxRetries: 0 });
  });
});
