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
