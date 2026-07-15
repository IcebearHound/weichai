import type { SearchCandidate, SearchRequest } from '@forexplore/contracts';

export interface CodeSearchPort {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchCandidate[]>;
}
