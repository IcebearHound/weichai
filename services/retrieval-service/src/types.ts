import type { Language, SearchRequest } from '@forexplore/contracts';

export interface IndexedCodeDocument {
  id: string;
  title: string;
  repository: string;
  license: string;
  language: Language;
  kind: 'class' | 'function';
  path: string;
  signature: string;
  summary: string;
  preview: string;
  dependencies: string[];
  compatibility: string[];
  risks: string[];
  content?: string;
}

export interface RetrievedCodeDocument extends IndexedCodeDocument {
  semanticScore?: number;
  textScore?: number;
}

export interface SearchFilters {
  repositories: string[];
  language?: Language;
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
