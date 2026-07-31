import type {
  AdaptationResult,
  AdaptationStrategy,
  ApplyResult,
  ModuleTarget,
  RetrievalMode,
  SearchCandidate,
} from '../contracts';

export type WorkflowStage =
  | 'target'
  | 'requirement'
  | 'candidates'
  | 'adaptation'
  | 'patch'
  | 'complete';

export interface WorkflowState {
  stage: WorkflowStage;
  target: ModuleTarget | null;
  requirement: string;
  topK: number;
  retrievalMode: RetrievalMode;
  candidates: SearchCandidate[];
  selectedCandidateId: string | null;
  decisionNotes: string;
  strategy: AdaptationStrategy;
  adaptation: AdaptationResult | null;
  applyResult: ApplyResult | null;
  pending: 'search' | 'adapt' | 'apply' | null;
  error: string | null;
}

export type WorkflowEvent =
  | { type: 'SELECT_TARGET'; target: ModuleTarget }
  | { type: 'SET_REQUIREMENT'; value: string }
  | { type: 'SET_TOP_K'; value: number }
  | { type: 'SET_RETRIEVAL_MODE'; value: RetrievalMode }
  | { type: 'SEARCH_START' }
  | { type: 'SEARCH_SUCCESS'; candidates: SearchCandidate[] }
  | { type: 'SEARCH_FAILURE'; message: string }
  | { type: 'SELECT_CANDIDATE'; candidateId: string }
  | { type: 'SET_DECISION_NOTES'; value: string }
  | { type: 'SET_STRATEGY'; value: AdaptationStrategy }
  | { type: 'ADAPT_START' }
  | { type: 'ADAPT_SUCCESS'; result: AdaptationResult }
  | { type: 'ADAPT_FAILURE'; message: string }
  | { type: 'APPLY_START' }
  | { type: 'APPLY_SUCCESS'; result: ApplyResult }
  | { type: 'APPLY_FAILURE'; message: string }
  | { type: 'RETURN_TO_CANDIDATES' }
  | { type: 'RESET' };

export const initialWorkflowState: WorkflowState = {
  stage: 'target',
  target: null,
  requirement: '',
  topK: 4,
  retrievalMode: 'hybrid',
  candidates: [],
  selectedCandidateId: null,
  decisionNotes: '',
  strategy: 'translate',
  adaptation: null,
  applyResult: null,
  pending: null,
  error: null,
};

export function workflowReducer(
  state: WorkflowState,
  event: WorkflowEvent,
): WorkflowState {
  switch (event.type) {
    case 'SELECT_TARGET':
      return {
        ...initialWorkflowState,
        target: event.target,
        stage: 'requirement',
        requirement: state.target?.id === event.target.id ? state.requirement : '',
      };
    case 'SET_REQUIREMENT':
      return { ...state, requirement: event.value, error: null };
    case 'SET_TOP_K':
      return { ...state, topK: event.value };
    case 'SET_RETRIEVAL_MODE':
      return { ...state, retrievalMode: event.value };
    case 'SEARCH_START':
      return { ...state, pending: 'search', error: null };
    case 'SEARCH_SUCCESS':
      return {
        ...state,
        pending: null,
        stage: 'candidates',
        candidates: event.candidates,
        selectedCandidateId: event.candidates[0]?.id ?? null,
        adaptation: null,
        applyResult: null,
      };
    case 'SEARCH_FAILURE':
      return { ...state, pending: null, error: event.message };
    case 'SELECT_CANDIDATE':
      return {
        ...state,
        selectedCandidateId: event.candidateId,
        stage: 'candidates',
        adaptation: null,
        applyResult: null,
      };
    case 'SET_DECISION_NOTES':
      return { ...state, decisionNotes: event.value };
    case 'SET_STRATEGY':
      return { ...state, strategy: event.value };
    case 'ADAPT_START':
      return { ...state, pending: 'adapt', stage: 'adaptation', error: null };
    case 'ADAPT_SUCCESS':
      return {
        ...state,
        pending: null,
        stage: 'patch',
        adaptation: event.result,
      };
    case 'ADAPT_FAILURE':
      return {
        ...state,
        pending: null,
        stage: 'candidates',
        error: event.message,
      };
    case 'APPLY_START':
      return { ...state, pending: 'apply', error: null };
    case 'APPLY_SUCCESS':
      return {
        ...state,
        pending: null,
        stage: 'complete',
        applyResult: event.result,
      };
    case 'APPLY_FAILURE':
      return { ...state, pending: null, error: event.message };
    case 'RETURN_TO_CANDIDATES':
      return {
        ...state,
        stage: 'candidates',
        adaptation: null,
        applyResult: null,
        pending: null,
        error: null,
      };
    case 'RESET':
      return initialWorkflowState;
    default:
      return state;
  }
}

export const workflowSteps: Array<{
  id: WorkflowStage;
  label: string;
  shortLabel: string;
}> = [
  { id: 'target', label: '选择模块', shortLabel: '01' },
  { id: 'requirement', label: '描述需求', shortLabel: '02' },
  { id: 'candidates', label: '选择方案', shortLabel: '03' },
  { id: 'adaptation', label: '翻译 / 桥接', shortLabel: '04' },
  { id: 'patch', label: '校验与回填', shortLabel: '05' },
];

const stageOrder: Record<WorkflowStage, number> = {
  target: 0,
  requirement: 1,
  candidates: 2,
  adaptation: 3,
  patch: 4,
  complete: 5,
};

export function getStepStatus(
  step: WorkflowStage,
  current: WorkflowStage,
): 'done' | 'active' | 'upcoming' {
  const currentIndex = stageOrder[current];
  const stepIndex = stageOrder[step];
  if (stepIndex < currentIndex) return 'done';
  if (stepIndex === currentIndex || (current === 'complete' && step === 'patch')) {
    return 'active';
  }
  return 'upcoming';
}

export function selectedCandidate(state: WorkflowState): SearchCandidate | null {
  return (
    state.candidates.find((candidate) => candidate.id === state.selectedCandidateId) ??
    null
  );
}
