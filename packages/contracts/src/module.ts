export type Language = 'TypeScript' | 'Python' | 'Java' | 'C#' | 'Rust' | 'Go';

export type ModuleKind =
  | 'workspace'
  | 'folder'
  | 'file'
  | 'class'
  | 'record'
  | 'interface'
  | 'function';

export type ImplementationStatus = 'implemented' | 'unimplemented';

export interface ModuleNode {
  id: string;
  name: string;
  kind: ModuleKind;
  path: string;
  language?: Language;
  signature?: string;
  line?: number;
  implementationStatus?: ImplementationStatus;
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
  implementationStatus?: ImplementationStatus;
}
