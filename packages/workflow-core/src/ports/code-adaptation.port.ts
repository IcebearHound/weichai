import type { AdaptationRequest, AdaptationResult } from '@forexplore/contracts';

export interface CodeAdaptationPort {
  adapt(request: AdaptationRequest, signal?: AbortSignal): Promise<AdaptationResult>;
}
