import type { ApplyResult, FilePatch } from '../../contracts';

export interface CodeBackfillPort {
  apply(files: FilePatch[], signal?: AbortSignal): Promise<ApplyResult>;
}
