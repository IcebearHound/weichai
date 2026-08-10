import type { FilePatch } from './backfill';
import type { Language, ModuleTarget } from './module';
import type { SearchCandidate } from './retrieval';
import type { ValidationRecord } from './validation';

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

export interface AdaptationResult {
  strategy: AdaptationStrategy;
  targetLanguage: Language;
  generatedCode: string;
  interfaceMappings: InterfaceMapping[];
  validation: ValidationRecord[];
  files: FilePatch[];
}
