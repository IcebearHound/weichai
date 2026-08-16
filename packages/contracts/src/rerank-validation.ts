/** A model-produced rank item before its IDs are accepted by the host. */
export interface RerankResultLike {
  id: string;
  score: number;
  reason?: string;
}

/** Stable, model-readable outcome of the reranking candidate-ID contract. */
export interface RerankContractValidation {
  valid: boolean;
  issues: string[];
}

/**
 * Ensures a reranker scored every supplied candidate exactly once and did not
 * invent, omit, or rewrite a candidate ID. This is shared by the MCP tool and
 * retrieval service so an Agent sees the same contract as the production host.
 */
export function validateRerankContract(
  candidateIds: readonly string[],
  results: unknown,
): RerankContractValidation {
  const issues: string[] = [];
  const expected = new Set(candidateIds);
  if (expected.size !== candidateIds.length) {
    issues.push('The candidate list contains duplicate IDs and cannot be reranked safely.');
  }
  if (!Array.isArray(results)) {
    return { valid: false, issues: [...issues, 'Reranker output must be a JSON array.'] };
  }

  const seen = new Set<string>();
  for (const [index, result] of results.entries()) {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      issues.push(`Result ${index + 1} must be an object with id and score.`);
      continue;
    }
    const item = result as Partial<RerankResultLike>;
    if (typeof item.id !== 'string' || !item.id) {
      issues.push(`Result ${index + 1} has no valid candidate ID.`);
      continue;
    }
    if (!Number.isFinite(item.score)) {
      issues.push(`Result ${index + 1} (${item.id}) has no finite score.`);
    }
    if (!expected.has(item.id)) {
      issues.push(`Result ${index + 1} references unknown candidate ID: ${item.id}`);
      continue;
    }
    if (seen.has(item.id)) {
      issues.push(`Candidate ID is repeated: ${item.id}`);
      continue;
    }
    seen.add(item.id);
  }

  const missing = candidateIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    issues.push(`Missing candidate IDs (${missing.length}): ${missing.join(', ')}`);
  }
  return { valid: issues.length === 0, issues };
}
