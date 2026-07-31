import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  ModuleTarget,
  RepositoryStatus,
  ServiceStatus,
} from '../../src/vendor/contracts';
import {
  initialWorkflowState,
  selectedCandidate,
  workflowReducer,
  type WorkflowState,
} from '../../src/vendor/workflow-core';
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
  const [target, setTarget] = useState<ModuleTarget | null>(null);
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
          setTarget(message.payload.target);
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
    if (!target) return;
    setError(null);
    dispatch({ type: 'SEARCH_START' });
    bus.post({
      type: 'START_SEARCH',
      request: {
        target,
        requirement: state.requirement.trim(),
        topK: state.topK,
        retrievalMode: state.retrievalMode,
        repositoryScopes: ['configured-repositories'],
      },
    });
  }

  function handleAdapt(): void {
    const candidate = selectedCandidate(state);
    if (!target || !candidate) return;
    setError(null);
    dispatch({ type: 'ADAPT_START' });
    bus.post({
      type: 'START_ADAPT',
      request: {
        target,
        candidate,
        requirement: state.requirement,
        strategy: state.strategy,
        decisionNotes: state.decisionNotes,
      },
    });
  }

  function handleApply(): void {
    if (!state.adaptation) return;
    setError(null);
    dispatch({ type: 'APPLY_START' });
    bus.post({ type: 'APPLY_PATCHES', files: state.adaptation.files });
  }

  function handleCheckRepositories(): void {
    setError(null);
    bus.post({ type: 'CHECK_REPOSITORIES' });
  }

  function handleOpenFile(pathValue: string, line: number): void {
    bus.post({ type: 'OPEN_FILE', path: pathValue, line });
  }

  if (!payload || !target) {
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
            target={target}
            dispatch={dispatch}
            repositoryStatuses={repositoryStatuses}
            onTargetChange={setTarget}
            onSearch={handleSearch}
            onCheckRepositories={handleCheckRepositories}
          />
        ) : null}

        {state.stage === 'candidates' ? (
          <CandidatesStage
            state={state}
            dispatch={dispatch}
            adaptationProvider={payload.adaptationProvider}
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
            onOpenFile={handleOpenFile}
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
