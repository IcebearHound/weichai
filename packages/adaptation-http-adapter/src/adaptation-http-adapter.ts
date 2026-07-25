import type { AdaptationRequest, AdaptationResult, ApplyResult, FilePatch } from '@forexplore/contracts';
import type { CodeAdaptationPort, CodeBackfillPort, WorkflowPorts } from '@forexplore/workflow-core';

export interface AdaptationHttpOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    // The status text below is more useful than a JSON parse failure.
  }
  return response.statusText || `HTTP ${response.status}`;
}

export class AdaptationHttpAdapter implements CodeAdaptationPort {
  private readonly adaptUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: AdaptationHttpOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error('Adaptation API base URL must not be empty.');
    }
    this.adaptUrl = endpoint(options.baseUrl, '/v1/adapt');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async adapt(request: AdaptationRequest, signal?: AbortSignal): Promise<AdaptationResult> {
    const response = await this.request(this.adaptUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Adaptation failed: ${await responseError(response)}`);
    }

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('generatedCode' in body)) {
      throw new Error('Adaptation service returned an invalid response.');
    }
    return body as AdaptationResult;
  }
}

export class BackfillHttpAdapter implements CodeBackfillPort {
  private readonly backfillUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: AdaptationHttpOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error('Adaptation API base URL must not be empty.');
    }
    this.backfillUrl = endpoint(options.baseUrl, '/v1/backfill');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async apply(files: FilePatch[], signal?: AbortSignal): Promise<ApplyResult> {
    const response = await this.request(this.backfillUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(files),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Backfill failed: ${await responseError(response)}`);
    }

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('appliedFiles' in body)) {
      throw new Error('Backfill service returned an invalid response.');
    }
    return body as ApplyResult;
  }
}

export function withAdaptationService(
  ports: WorkflowPorts,
  options: AdaptationHttpOptions,
): WorkflowPorts {
  return {
    ...ports,
    adaptation: new AdaptationHttpAdapter(options),
    backfill: new BackfillHttpAdapter(options),
  };
}
