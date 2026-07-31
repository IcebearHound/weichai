/**
 * Health-check result for one configured retrieval repository path.
 *
 * `indexed` reflects whether a prior indexing run was recorded for this path,
 * and `stale` compares the newest file modification time under the path with
 * the recorded indexing time.
 */
export interface RepositoryStatus {
  path: string;
  exists: boolean;
  readable: boolean;
  indexed: boolean;
  stale: boolean;
  message: string;
}

export interface RepositoryIndexRecord {
  path: string;
  indexedAt: number;
  symbolCount: number;
}

export type ServiceAvailability = 'connected' | 'starting' | 'mock' | 'error';

export interface ServiceStatus {
  retrieval: ServiceAvailability;
  adaptation: ServiceAvailability;
  /** Human-readable detail shown in the panel footer. */
  message?: string;
}
