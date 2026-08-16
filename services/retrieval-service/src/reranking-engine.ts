import {
  validateRerankContract,
  type SearchCandidate,
  type SearchRequest,
} from '@forexplore/contracts';
import type { LlmReranker, SearchEngine } from './types.js';

/**
 * Decorator that wraps an existing {@link SearchEngine}, expands recall, and
 * re-ranks candidates through an {@link LlmReranker}.
 *
 * The decorated engine is called with an enlarged `topK` (`recallLimit`) so
 * the reranker has more candidates to choose from. A response that violates
 * the candidate-ID contract is repaired through a feedback retry; it is never
 * silently substituted with an unverified hybrid ranking.
 */
class RerankValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RerankValidationError';
  }
}

export class RerankingSearchEngine implements SearchEngine {
  constructor(
    private readonly baseEngine: SearchEngine,
    private readonly reranker: LlmReranker,
    private readonly recallLimit: number = 20,
    private readonly validationRetries: number = 2,
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

    // d. Ask DeepSeek to rerank. Contract failures receive explicit feedback
    // so the next response can repair IDs rather than hiding the failure.
    let feedback: { message: string; attempt: number } | undefined;
    for (let attempt = 0; attempt <= this.validationRetries; attempt += 1) {
      const rerankResults = await this.reranker.rerank(request, candidates, feedback);
      try {
        return this.applyRerank(candidates, rerankResults, request.topK);
      } catch (error: unknown) {
        if (!(error instanceof RerankValidationError)) throw error;
        if (attempt === this.validationRetries) {
          throw new Error(
            `DeepSeek reranking violated the candidate contract after ${attempt + 1} attempts: ${error.message}`,
            { cause: error },
          );
        }
        feedback = { message: error.message, attempt: attempt + 1 };
      }
    }

    throw new Error('Reranking retry loop exited unexpectedly.');
  }

  // ── private helpers ───────────────────────────────────────────────────

  /**
   * Merge LLM scores back into candidates, sort by rerank score (ties broken
   * by the hybrid RRF score), and truncate to `topK`.
   *
   * Validation requires one score per original candidate, so no candidate can
   * be dropped or fabricated by the model.
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
      return (b.score.hybrid ?? b.score.overall) - (a.score.hybrid ?? a.score.overall);
    });

    return reranked.slice(0, topK);
  }

  /**
   * A partial or fabricated LLM response is returned to the model as repair
   * feedback. Exhausting that repair path fails the request explicitly.
   */
  private assertCompleteRerankResults(
    candidates: SearchCandidate[],
    rerankResults: Array<{ id: string; score: number; reason: string }>,
  ): void {
    const validation = validateRerankContract(
      candidates.map((candidate) => candidate.id),
      rerankResults,
    );
    if (!validation.valid) {
      throw new RerankValidationError(validation.issues.join(' '));
    }
  }
}
