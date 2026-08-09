import type { SearchCandidate, SearchRequest } from '@forexplore/contracts';
import type { LlmReranker, SearchEngine } from './types.js';

/**
 * Decorator that wraps an existing {@link SearchEngine}, expands recall, and
 * re-ranks candidates through an {@link LlmReranker}.
 *
 * The decorated engine is called with an enlarged `topK` (`recallLimit`) so
 * the reranker has more candidates to choose from.  When the reranker fails
 * for any reason the engine falls back to the original ranking (silent
 * degradation).
 */
export class RerankingSearchEngine implements SearchEngine {
  constructor(
    private readonly baseEngine: SearchEngine,
    private readonly reranker: LlmReranker,
    private readonly recallLimit: number = 20,
  ) {}

  async search(request: SearchRequest): Promise<SearchCandidate[]> {
    // a. Explicit per-request opt-out → pass through unchanged.
    if (request.rerank === false) {
      return this.baseEngine.search(request);
    }

    // b. Expand recall so the reranker has more candidates to work with.
    const expandedRequest: SearchRequest = {
      ...request,
      topK: Math.max(this.recallLimit, request.topK),
    };
    const candidates = await this.baseEngine.search(expandedRequest);

    // c. Nothing to re-rank — return as-is.
    if (candidates.length <= 1) {
      return candidates.slice(0, request.topK);
    }

    // d. Ask the LLM to re-rank.
    try {
      const rerankResults = await this.reranker.rerank(request, candidates);
      return this.applyRerank(candidates, rerankResults, request.topK);
    } catch (error: unknown) {
      // f. Silent degradation — log and fall back to original order.
      console.warn(
        `LLM reranking failed, falling back to original ranking: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return candidates.slice(0, request.topK);
    }
  }

  // ── private helpers ───────────────────────────────────────────────────

  /**
   * Merge LLM scores back into candidates, sort by rerank score (ties broken
   * by the original overall score), and truncate to `topK`.
   *
   * Candidates that were not scored by the LLM are pushed to the end with a
   * rerank score of 0 so they are never fully lost.
   */
  private applyRerank(
    candidates: SearchCandidate[],
    rerankResults: Array<{ id: string; score: number; reason: string }>,
    topK: number,
  ): SearchCandidate[] {
    this.assertCompleteRerankResults(candidates, rerankResults);
    const rerankMap = new Map(rerankResults.map((r) => [r.id, r]));

    const reranked = candidates.map((c) => {
      const rerank = rerankMap.get(c.id);
      return {
        ...c,
        score: { ...c.score, rerank: rerank?.score },
        rerankReason: rerank?.reason,
      };
    });

    reranked.sort((a, b) => {
      const aScore = a.score.rerank ?? 0;
      const bScore = b.score.rerank ?? 0;
      if (bScore !== aScore) return bScore - aScore;
      return b.score.overall - a.score.overall;
    });

    return reranked.slice(0, topK);
  }

  /**
   * A partial or fabricated LLM response must never reshuffle the original
   * search results. Treat it as a failed rerank so {@link search} falls back
   * to the deterministic retrieval order.
   */
  private assertCompleteRerankResults(
    candidates: SearchCandidate[],
    rerankResults: Array<{ id: string; score: number; reason: string }>,
  ): void {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    if (candidateIds.size !== candidates.length) {
      throw new Error('Cannot rerank a candidate list with duplicate ids.');
    }

    if (!Array.isArray(rerankResults)) {
      throw new Error('Reranker returned a non-array result.');
    }

    const seen = new Set<string>();
    for (const result of rerankResults) {
      if (
        typeof result !== 'object' || result === null ||
        typeof result.id !== 'string' ||
        !Number.isFinite(result.score)
      ) {
        throw new Error('Reranker returned an invalid result item.');
      }
      if (!candidateIds.has(result.id)) {
        throw new Error(`Reranker returned an unknown candidate id: ${result.id}`);
      }
      if (seen.has(result.id)) {
        throw new Error(`Reranker returned a duplicate candidate id: ${result.id}`);
      }
      seen.add(result.id);
    }

    if (seen.size !== candidateIds.size) {
      throw new Error(
        `Reranker returned ${seen.size}/${candidateIds.size} candidate ids; refusing partial ranking.`,
      );
    }
  }
}
