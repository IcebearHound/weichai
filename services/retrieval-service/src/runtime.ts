import type { RetrievalConfig } from './config.js';
import {
  HashEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
} from './embedding.js';
import { OpenAiCompatibleReranker } from './reranker.js';
import { RerankingSearchEngine } from './reranking-engine.js';
import { SeekDbSearchEngine } from './search-engine.js';
import { SeekDbStore } from './seekdb-store.js';
import type { EmbeddingProvider, LlmReranker, SearchEngine } from './types.js';

export function createEmbeddingProvider(config: RetrievalConfig): EmbeddingProvider {
  if (config.embedding.provider === 'openai') {
    return new OpenAiCompatibleEmbeddingProvider(
      config.embedding.dimension,
      config.embedding.url,
      config.embedding.apiKey,
      config.embedding.model,
      { supportsDimensions: config.embedding.supportsDimensions },
    );
  }
  return new HashEmbeddingProvider(config.embedding.dimension);
}

export function createReranker(config: RetrievalConfig): LlmReranker | null {
  if (config.reranking.provider === 'none') return null;

  const apiKey =
    config.reranking.provider === 'openai' ? config.reranking.apiKey : '';

  return new OpenAiCompatibleReranker(
    config.reranking.model,
    config.reranking.url,
    apiKey,
    config.reranking.timeoutMs,
    config.reranking.maxRetries,
  );
}

export function createRuntime(config: RetrievalConfig) {
  const store = new SeekDbStore(config.seekdb);
  const embeddings = createEmbeddingProvider(config);
  const baseEngine: SearchEngine = new SeekDbSearchEngine(store, embeddings);
  const reranker = createReranker(config);
  const engine: SearchEngine = reranker
    ? new RerankingSearchEngine(baseEngine, reranker)
    : baseEngine;
  return { store, embeddings, engine };
}
