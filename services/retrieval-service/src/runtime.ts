import type { RetrievalConfig } from './config.js';
import {
  HashEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
} from './embedding.js';
import { SeekDbSearchEngine } from './search-engine.js';
import { SeekDbStore } from './seekdb-store.js';
import type { EmbeddingProvider } from './types.js';

export function createEmbeddingProvider(config: RetrievalConfig): EmbeddingProvider {
  if (config.embedding.provider === 'openai') {
    return new OpenAiCompatibleEmbeddingProvider(
      config.embedding.dimension,
      config.embedding.url,
      config.embedding.apiKey,
      config.embedding.model,
    );
  }
  return new HashEmbeddingProvider(config.embedding.dimension);
}

export function createRuntime(config: RetrievalConfig) {
  const store = new SeekDbStore(config.seekdb);
  const embeddings = createEmbeddingProvider(config);
  const engine = new SeekDbSearchEngine(store, embeddings);
  return { store, embeddings, engine };
}
