import type { RetrievalConfig } from './config.js';
import {
  HashEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
} from './embedding.js';
import { DeepSeekReranker } from './reranker.js';
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

  return new DeepSeekReranker(
    config.reranking.model,
    config.reranking.url,
    config.reranking.apiKey,
    config.reranking.timeoutMs,
    config.reranking.maxRetries,
  );
}

export function createRuntime(config: RetrievalConfig) {
  const store = new SeekDbStore(config.seekdb);
  const embeddings = createEmbeddingProvider(config);
  const reranker = createReranker(config);
  // The PDF workflow sends exactly the hybrid Top20 to the reranker. The
  // base engine keeps its broader default recall when reranking is disabled.
  const baseEngine: SearchEngine = new SeekDbSearchEngine(
    store,
    embeddings,
    reranker ? 20 : undefined,
  );
  const engine: SearchEngine = reranker
    ? new RerankingSearchEngine(
        baseEngine,
        reranker,
        20,
        config.reranking.provider === 'deepseek'
          ? config.reranking.validationRetries
          : 0,
      )
    : baseEngine;
  return { store, embeddings, engine };
}
