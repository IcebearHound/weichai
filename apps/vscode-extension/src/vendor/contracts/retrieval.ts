import type { Language, ModuleTarget } from './module';

export type RetrievalMode = 'hybrid' | 'semantic' | 'structure';

export interface SearchRequest {
  target: ModuleTarget;
  /** Optional natural-language context; an empty string searches by target metadata. */
  requirement: string;
  topK: number;
  retrievalMode: RetrievalMode;
  repositoryScopes: string[];
  /**
   * Hard source-language constraint for retrieved candidates.
   * Omit it when the caller can adapt candidates from any language.
   */
  candidateLanguages?: Language[];
}

export interface CandidateScore {
  overall: number;
  semantic: number;
  symbol: number;
  contract: number;
}

export interface SearchCandidate {
  id: string;
  title: string;
  repository: string;
  license: string;
  language: Language;
  kind: 'class' | 'function';
  path: string;
  signature: string;
  summary: string;
  score: CandidateScore;
  preview: string;
  dependencies: string[];
  compatibility: string[];
  risks: string[];
}
