import type { AdaptationRequest, AdaptationResult } from '../../contracts';

export interface CodeAdaptationPort {
  adapt(request: AdaptationRequest, signal?: AbortSignal): Promise<AdaptationResult>;
}
