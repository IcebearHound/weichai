import type { WorkflowEvent } from '../../src/vendor/workflow-core';

/**
 * Maps a host-side error to the workflow failure event that clears the
 * pending operation, so the wizard can recover without stale spinners.
 */
export function errorEvent(
  pending: 'search' | 'adapt' | 'apply' | null,
  message: string,
): WorkflowEvent | null {
  if (pending === 'search') return { type: 'SEARCH_FAILURE', message };
  if (pending === 'adapt') return { type: 'ADAPT_FAILURE', message };
  if (pending === 'apply') return { type: 'APPLY_FAILURE', message };
  return null;
}
