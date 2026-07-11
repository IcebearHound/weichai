import type {
  AdaptationRequest,
  AdaptationResult,
  ApplyResult,
  FilePatch,
  SearchCandidate,
  SearchRequest,
} from '../domain/model';

export interface CodeSearchPort {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchCandidate[]>;
}

export interface CodeAdaptationPort {
  adapt(request: AdaptationRequest, signal?: AbortSignal): Promise<AdaptationResult>;
}

export interface CodeBackfillPort {
  apply(files: FilePatch[], signal?: AbortSignal): Promise<ApplyResult>;
}

export interface WorkflowPorts {
  search: CodeSearchPort;
  adaptation: CodeAdaptationPort;
  backfill: CodeBackfillPort;
}
