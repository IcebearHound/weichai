import type { RetrievalMode, SearchCandidate, SearchRequest } from '@forexplore/contracts';
import type {
  EmbeddingProvider,
  IndexedCodeDocument,
  RetrievedCodeDocument,
  SearchEngine,
  SearchFilters,
  SearchStore,
} from './types.js';
import { expandedSearchText, overlap } from './text-analysis.js';

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function repositoryScopes(values: string[]): string[] {
  return values
    .map((value) => value.replace(/^repo:/, '').trim())
    .filter((value) => value.includes('/') && !value.includes('*'));
}

function expandedLimit(topK: number): number {
  return Math.min(250, Math.max(50, topK * 5));
}

function queryText(request: SearchRequest): string {
  const raw = [
    request.target.name,
    request.target.signature,
    request.target.kind,
    request.target.language,
    request.target.path,
    request.requirement,
  ].join('\n');
  return `${raw}\n${expandedSearchText(raw)}`;
}

function documentText(document: IndexedCodeDocument): string {
  return [
    document.title,
    document.repository,
    document.path,
    document.signature,
    document.summary,
    document.content || document.preview,
    ...document.dependencies,
  ].join('\n');
}

function mergeResults(
  semantic: RetrievedCodeDocument[],
  text: RetrievedCodeDocument[],
): RetrievedCodeDocument[] {
  const merged = new Map<
    string,
    { document: RetrievedCodeDocument; reciprocalRank: number }
  >();
  const add = (
    documents: RetrievedCodeDocument[],
    weight: number,
    scoreKey: 'semanticScore' | 'textScore',
  ) => {
    documents.forEach((document, index) => {
      const current = merged.get(document.id);
      const reciprocalRank = weight / (60 + index + 1);
      merged.set(document.id, {
        document: {
          ...(current?.document ?? document),
          [scoreKey]: document[scoreKey],
        },
        reciprocalRank: (current?.reciprocalRank ?? 0) + reciprocalRank,
      });
    });
  };
  add(semantic, 0.65, 'semanticScore');
  add(text, 0.35, 'textScore');
  return [...merged.values()]
    .sort((left, right) => right.reciprocalRank - left.reciprocalRank)
    .map(({ document }) => document);
}

function overallScore(
  mode: RetrievalMode,
  semantic: number,
  symbol: number,
  contract: number,
  text: number,
): number {
  if (mode === 'semantic') return clamp(0.8 * semantic + 0.1 * symbol + 0.1 * contract);
  if (mode === 'structure') return clamp(0.55 * text + 0.3 * symbol + 0.15 * contract);
  return clamp(0.5 * semantic + 0.2 * text + 0.15 * symbol + 0.15 * contract);
}

function candidate(
  document: RetrievedCodeDocument,
  request: SearchRequest,
): SearchCandidate {
  const semantic = clamp(document.semanticScore ?? overlap(request.requirement, documentText(document)));
  const lexical = overlap(queryText(request), documentText(document));
  const text = clamp(
    document.textScore === undefined ? lexical : 0.7 * document.textScore + 0.3 * lexical,
  );
  const targetContext = [
    request.target.name,
    request.target.signature,
    request.target.path,
  ].join('\n');
  const candidateSymbol = [document.title, document.signature].join('\n');
  const symbol = clamp(
    0.4 * overlap(request.target.name, candidateSymbol) +
      0.35 * overlap(request.target.signature, candidateSymbol) +
      0.25 * overlap(targetContext, documentText(document)),
  );
  const contract = clamp(
    (request.target.kind === document.kind ? 0.55 : 0.2) +
      (request.target.language === document.language ? 0.3 : 0.15) +
      (document.dependencies.length === 0 ? 0.15 : 0.05),
  );
  return {
    id: document.id,
    title: document.title,
    repository: document.repository,
    license: document.license,
    language: document.language,
    kind: document.kind,
    path: document.path,
    signature: document.signature,
    summary: document.summary,
    score: {
      overall: overallScore(request.retrievalMode, semantic, symbol, contract, text),
      semantic,
      symbol,
      contract,
    },
    preview: document.preview,
    dependencies: document.dependencies,
    compatibility: document.compatibility,
    risks: document.risks,
  };
}

export class SeekDbSearchEngine implements SearchEngine {
  constructor(
    private readonly store: SearchStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async search(request: SearchRequest): Promise<SearchCandidate[]> {
    const text = queryText(request);
    const filters: SearchFilters = {
      repositories: repositoryScopes(request.repositoryScopes),
      kind: request.retrievalMode === 'structure' ? request.target.kind : undefined,
    };
    const candidateLimit = expandedLimit(request.topK);
    let documents: RetrievedCodeDocument[];

    if (request.retrievalMode === 'structure') {
      documents = await this.store.textSearch(text, filters, candidateLimit);
    } else {
      const [embedding] = await this.embeddings.embed([text]);
      if (!embedding) throw new Error('Embedding provider returned no query vector.');
      if (request.retrievalMode === 'semantic') {
        documents = await this.store.semanticSearch(embedding, filters, candidateLimit);
      } else {
        const [semantic, fullText] = await Promise.all([
          this.store.semanticSearch(embedding, filters, candidateLimit),
          this.store.textSearch(text, filters, candidateLimit),
        ]);
        documents = mergeResults(semantic, fullText);
      }
    }

    return documents
      .map((document) => candidate(document, request))
      .sort((left, right) => right.score.overall - left.score.overall)
      .slice(0, request.topK);
  }
}

export const searchInternals = {
  expandedLimit,
  mergeResults,
  overlap,
  queryText,
  repositoryScopes,
};
