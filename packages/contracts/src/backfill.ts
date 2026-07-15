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

export interface ApplyResult {
  appliedFiles: string[];
  checkpointId: string;
}
