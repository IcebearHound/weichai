import type { SearchCandidate, SearchRequest } from '../../contracts';

export interface CodeSearchPort {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchCandidate[]>;
}
