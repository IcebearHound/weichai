/** Types that exist only at the extension presentation boundary. */
export type ExecutionMode = 'real';

export type ServiceConnection = 'connected' | 'unconfigured' | 'error';

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

export type ModuleExplorerMode = 'target' | 'history';

export type ModuleExplorerNodeKind =
  | 'module'
  | 'folder'
  | 'file'
  | 'class'
  | 'interface'
  | 'record'
  | 'struct'
  | 'enum'
  | 'method'
  | 'constructor'
  | 'function';

export type ModuleImplementationStatus = 'implemented' | 'unimplemented' | 'unknown';

/** Read-only tree item produced from a trusted host-side static-analysis snapshot. */
export interface ModuleExplorerNode {
  id: string;
  name: string;
  kind: ModuleExplorerNodeKind;
  path?: string;
  language?: string;
  signature?: string;
  line?: number;
  implementationStatus?: ModuleImplementationStatus;
  targetId?: string;
  description?: string;
  children: ModuleExplorerNode[];
}

export interface ModuleExplorerStats {
  modules: number;
  files: number;
  types: number;
  methods: number;
  implemented: number;
  unimplemented: number;
  unknown: number;
  dependencies: number;
}

export interface ModuleSummaryPresentation {
  exists: boolean;
  path: '.forexplore/module-summary.json';
  error?: string;
  planId?: string;
  status?: string;
  approvalsCurrent?: boolean;
  moduleCount?: number;
  waveCount?: number;
}

export interface ModuleWorkspacePresentation {
  id: string;
  mode: ModuleExplorerMode;
  name: string;
  rootLabel: string;
  snapshotId?: string;
  revision?: string;
  loading?: boolean;
  error?: string;
  stats: ModuleExplorerStats;
  summary: ModuleSummaryPresentation;
  tree: ModuleExplorerNode[];
}

/** Complete module-navigation snapshot sent by the trusted extension host. */
export interface ModuleExplorerPresentation {
  generatedAt: string;
  target: ModuleWorkspacePresentation;
  history: ModuleWorkspacePresentation[];
}
