/** Types that exist only at the extension presentation boundary. */
export type ExecutionMode = 'real' | 'guided-demo';

export type ServiceConnection = 'connected' | 'demo' | 'unconfigured' | 'error';

export interface ServiceStatus {
  retrieval: ServiceConnection;
  adaptation: ServiceConnection;
  executionMode: ExecutionMode;
  message?: string;
}

export interface RepositoryStatus {
  path: string;
  exists: boolean;
  readable: boolean;
  /** Local paths are not proof of service-side indexing. */
  indexed: boolean;
  stale: boolean;
  message: string;
}
