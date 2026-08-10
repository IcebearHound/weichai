import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { RepositoryStatus, ServiceStatus } from '../../src/ui-types';
import {
  initialWorkflowState,
  selectedCandidate,
  workflowReducer,
  type WorkflowState,
} from '@forexplore/workflow-core';
import type { PanelInitPayload } from '../../src/protocol/messages';
import { AdaptationStage } from './components/AdaptationStage';
import { CandidatesStage } from './components/CandidatesStage';
import { FooterStatus } from './components/FooterStatus';
import { PatchStage } from './components/PatchStage';
import { RequirementStage } from './components/RequirementStage';
import { StepRail } from './components/StepRail';
import { errorEvent } from './errors';
import { createMessageBus, type MessageBus } from './vscode-api';

export default function App() {
  const bus: MessageBus = useMemo(() => createMessageBus(), []);
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [payload, setPayload] = useState<PanelInitPayload | null>(null);
  const [repositoryStatuses, setRepositoryStatuses] = useState<RepositoryStatus[]>([]);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<WorkflowState['pending']>(null);
  pendingRef.current = state.pending;

  useEffect(() => {
    bus.post({ type: 'READY' });
    return bus.subscribe((message) => {
      switch (message.type) {
        case 'INIT':
          setPayload(message.payload);
          setRepositoryStatuses(message.payload.repositoryStatuses);
          setServiceStatus(message.payload.serviceStatus);
          setError(null);
          dispatch({ type: 'SELECT_TARGET', target: message.payload.target });
          break;
        case 'SEARCH_RESULT':
          dispatch({ type: 'SEARCH_SUCCESS', candidates: message.candidates });
          break;
        case 'ADAPT_RESULT':
          dispatch({ type: 'ADAPT_SUCCESS', result: message.result });
          break;
        case 'APPLY_RESULT':
          dispatch({ type: 'APPLY_SUCCESS', result: message.result });
          break;
        case 'REPOSITORY_STATUS':
          setRepositoryStatuses(message.statuses);
          break;
        case 'SERVICE_STATUS':
          setServiceStatus(message.status);
          break;
        case 'ERROR': {
          setError(message.message);
          const event = errorEvent(pendingRef.current, message.message);
          if (event) dispatch(event);
          break;
        }
      }
    });
  }, [bus]);

  function handleSearch(): void {
    if (!state.target) return;
    setError(null);
    dispatch({ type: 'SEARCH_START' });
    bus.post({
      type: 'START_SEARCH',
      requirement: state.requirement.trim(),
      topK: state.topK,
      retrievalMode: state.retrievalMode,
    });
  }

  function handleAdapt(): void {
    const candidate = selectedCandidate(state);
    if (!state.target || !candidate) return;
    setError(null);
    dispatch({ type: 'ADAPT_START' });
    bus.post({
      type: 'START_ADAPT',
      decisionNotes: state.decisionNotes,
    });
  }

  function handleApply(): void {
    if (!state.adaptation) return;
    setError(null);
    dispatch({ type: 'APPLY_START' });
    bus.post({ type: 'APPLY_CURRENT_RUN' });
  }

  function handleCheckRepositories(): void {
    setError(null);
    bus.post({ type: 'CHECK_REPOSITORIES' });
  }

  function handleSelectCandidate(candidateId: string): void {
    dispatch({ type: 'SELECT_CANDIDATE', candidateId });
    bus.post({ type: 'SELECT_CANDIDATE', candidateId });
  }

  function handleOpenTarget(): void {
    bus.post({ type: 'OPEN_TARGET' });
  }

  if (!payload || !state.target) {
    return (
      <div className="app">
        <div className="loading-state">正在初始化 ForeXplore 翻译面板…</div>
      </div>
    );
  }

  const candidate = selectedCandidate(state);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-glyph">FX</span>
          <strong>ForeXplore</strong>
        </div>
        <StepRail stage={state.stage} />
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <main className="stage-body">
        {state.stage === 'requirement' ? (
          <RequirementStage
            state={state}
            target={state.target}
            dispatch={dispatch}
            repositoryStatuses={repositoryStatuses}
            onSearch={handleSearch}
            onCheckRepositories={handleCheckRepositories}
          />
        ) : null}

        {state.stage === 'candidates' ? (
          <CandidatesStage
            state={state}
            dispatch={dispatch}
            adaptationProvider={payload.adaptationProvider}
            onSelectCandidate={handleSelectCandidate}
            onAdapt={handleAdapt}
          />
        ) : null}

        {state.stage === 'adaptation' ? (
          <AdaptationStage state={state} candidate={candidate} />
        ) : null}

        {(state.stage === 'patch' || state.stage === 'complete') && state.adaptation ? (
          <PatchStage
            state={state}
            onApply={handleApply}
            onBack={() => dispatch({ type: 'RETURN_TO_CANDIDATES' })}
            onOpenTarget={handleOpenTarget}
          />
        ) : null}
      </main>

      <FooterStatus
        serviceStatus={serviceStatus}
        repositoryStatuses={repositoryStatuses}
        workspaceRoot={payload.workspaceRoot}
      />
    </div>
  );
}
