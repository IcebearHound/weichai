import { describe, expect, it } from 'vitest';
import type {
  AdaptationResult,
  ModuleTarget,
  SearchCandidate,
} from '@forexplore/contracts';
import { initialWorkflowState, workflowReducer } from './workflow';

const target: ModuleTarget = {
  id: 'target-1',
  name: 'getQuote',
  kind: 'function',
  path: 'services/rate-quote.service.ts',
  language: 'TypeScript',
  signature: 'getQuote(request: QuoteRequest): Promise<Quote>',
};

const candidate: SearchCandidate = {
  id: 'candidate-1',
  title: 'get_or_load',
  repository: 'demo/repository',
  license: 'MIT',
  language: 'Python',
  kind: 'function',
  path: 'cache.py',
  signature: 'async def get_or_load()',
  summary: 'cache loader',
  score: { overall: 0.9, semantic: 0.9, symbol: 0.8, contract: 0.9 },
  preview: 'pass',
  dependencies: [],
  compatibility: [],
  risks: [],
};

const adaptation: AdaptationResult = {
  strategy: 'translate',
  targetLanguage: 'TypeScript',
  generatedCode: 'return quote;',
  interfaceMappings: [],
  validation: [],
  files: [],
};

describe('workflowReducer', () => {
  it('runs through target, search, adaptation and apply stages', () => {
    let state = workflowReducer(initialWorkflowState, { type: 'SELECT_TARGET', target });
    expect(state.stage).toBe('requirement');

    state = workflowReducer(state, {
      type: 'SET_REQUIREMENT',
      value: 'add resilient cache behavior',
    });
    state = workflowReducer(state, { type: 'SEARCH_START' });
    expect(state.pending).toBe('search');

    state = workflowReducer(state, { type: 'SEARCH_SUCCESS', candidates: [candidate] });
    expect(state.stage).toBe('candidates');
    expect(state.selectedCandidateId).toBeNull();

    state = workflowReducer(state, { type: 'SELECT_CANDIDATE', candidateId: candidate.id });
    expect(state.selectedCandidateId).toBe(candidate.id);

    state = workflowReducer(state, { type: 'ADAPT_START' });
    expect(state.stage).toBe('adaptation');

    state = workflowReducer(state, { type: 'ADAPT_SUCCESS', result: adaptation });
    expect(state.stage).toBe('patch');
    expect(state.adaptation).toBe(adaptation);

    state = workflowReducer(state, { type: 'APPLY_START' });
    state = workflowReducer(state, {
      type: 'APPLY_SUCCESS',
      result: {
        appliedFiles: ['services/rate-quote.service.ts'],
        checkpointId: 'cp-1',
        rollbackAvailable: true,
      },
    });
    expect(state.stage).toBe('complete');
    expect(state.applyResult?.checkpointId).toBe('cp-1');
  });

  it('clears downstream decisions when the target symbol changes', () => {
    const populated = {
      ...initialWorkflowState,
      stage: 'patch' as const,
      target,
      requirement: 'old requirement',
      candidates: [candidate],
      selectedCandidateId: candidate.id,
      adaptation,
    };

    const nextTarget = { ...target, id: 'target-2', name: 'settleBatch' };
    const state = workflowReducer(populated, {
      type: 'SELECT_TARGET',
      target: nextTarget,
    });

    expect(state.stage).toBe('requirement');
    expect(state.target).toEqual(nextTarget);
    expect(state.requirement).toBe('');
    expect(state.candidates).toEqual([]);
    expect(state.adaptation).toBeNull();
  });
});
