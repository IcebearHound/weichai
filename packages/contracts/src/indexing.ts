import type { Language } from './module';

export interface IndexedCodeDocument {
  id: string;
  title: string;
  repository: string;
  license: string;
  language: Language;
  kind: 'class' | 'function';
  path: string;
  signature: string;
  summary: string;
  preview: string;
  dependencies: string[];
  compatibility: string[];
  risks: string[];
  content?: string;
}
