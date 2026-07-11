export type Language = 'TypeScript' | 'Python' | 'Java' | 'Rust' | 'Go';

export type ModuleKind = 'workspace' | 'folder' | 'file' | 'class' | 'function';

export interface ModuleNode {
  id: string;
  name: string;
  kind: ModuleKind;
  path: string;
  language?: Language;
  signature?: string;
  line?: number;
  children?: ModuleNode[];
}

export interface ModuleTarget {
  id: string;
  name: string;
  kind: 'class' | 'function';
  path: string;
  language: Language;
  signature: string;
  line?: number;
}

export type RetrievalMode = 'hybrid' | 'semantic' | 'structure';

export interface SearchRequest {
  target: ModuleTarget;
  requirement: string;
  topK: number;
  retrievalMode: RetrievalMode;
  repositoryScopes: string[];
}

export interface CandidateScore {
  overall: number;
  semantic: number;
  symbol: number;
  contract: number;
}

export interface SearchCandidate {
  id: string;
  title: string;
  repository: string;
  license: string;
  language: Language;
  kind: 'class' | 'function';
  path: string;
  signature: string;
  summary: string;
  score: CandidateScore;
  preview: string;
  dependencies: string[];
  compatibility: string[];
  risks: string[];
}

export type AdaptationStrategy = 'translate' | 'bridge' | 'wrap' | 'reuse';

export interface AdaptationRequest {
  target: ModuleTarget;
  candidate: SearchCandidate;
  requirement: string;
  strategy: AdaptationStrategy;
  decisionNotes: string;
}

export interface InterfaceMapping {
  source: string;
  target: string;
  action: 'rename' | 'convert' | 'inject' | 'preserve';
  note: string;
}

export interface PatchHunk {
  header: string;
  lines: Array<{ type: 'context' | 'add' | 'remove'; content: string }>;
}

export interface FilePatch {
  path: string;
  status: 'modified' | 'created';
  additions: number;
  deletions: number;
  hunks: PatchHunk[];
}

export interface AdaptationResult {
  strategy: AdaptationStrategy;
  targetLanguage: Language;
  generatedCode: string;
  interfaceMappings: InterfaceMapping[];
  validation: Array<{ label: string; status: 'pass' | 'warn'; detail: string }>;
  files: FilePatch[];
}

export interface ApplyResult {
  appliedFiles: string[];
  checkpointId: string;
}
