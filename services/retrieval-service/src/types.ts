import type {
  IndexedCodeDocument,
  Language,
  SearchRequest,
} from '@forexplore/contracts';

export type { IndexedCodeDocument } from '@forexplore/contracts';

export interface RetrievedCodeDocument extends IndexedCodeDocument {
  semanticScore?: number;
  textScore?: number;
}

export interface SearchFilters {
  repositories: string[];
  languages: Language[];
  kind?: 'class' | 'function';
}

export interface SearchStore {
  ping(): Promise<void>;
  initialize(): Promise<void>;
  clear(): Promise<void>;
  upsert(documents: Array<IndexedCodeDocument & { embedding: number[] }>): Promise<void>;
  refreshIndex(): Promise<void>;
  semanticSearch(
    embedding: number[],
    filters: SearchFilters,
    limit: number,
  ): Promise<RetrievedCodeDocument[]>;
  textSearch(
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<RetrievedCodeDocument[]>;
  close(): Promise<void>;
}

export interface EmbeddingProvider {
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SearchEngine {
  search(request: SearchRequest): Promise<import('@forexplore/contracts').SearchCandidate[]>;
}
