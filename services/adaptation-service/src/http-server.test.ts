import type { AddressInfo } from 'node:net';
import type {
  AdaptationRequest,
  AdaptationResult,
  SearchCandidate,
} from '@forexplore/contracts';
import type { CodeAdaptationPort } from '@forexplore/workflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from './http-server';

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function listen(adapter: CodeAdaptationPort): Promise<string> {
  const server = createHttpServer({
    adapter,
    corsOrigin: 'http://localhost:4173',
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const javaCandidate: SearchCandidate = {
  id: 'java-candidate',
  title: 'calculate',
  repository: 'fixture/java',
  license: 'Apache-2.0',
  language: 'Java',
  kind: 'function',
  path: 'src/Calculator.java',
  signature: 'public double calculate()',
  summary: 'Calculates a value.',
  score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
  preview: 'public double calculate() { return 1.0; }',
  dependencies: [],
  compatibility: [],
  risks: [],
};

const adaptationRequest: AdaptationRequest = {
  target: {
    id: 'target',
    name: 'Calculate',
    kind: 'function',
    path: 'src/Calculator.cs',
    language: 'C#',
    signature: 'public decimal Calculate()',
  },
  candidate: javaCandidate,
  requirement: 'Translate the calculation.',
  strategy: 'translate',
  decisionNotes: '',
};

const adaptationResult: AdaptationResult = {
  strategy: 'translate',
  targetLanguage: 'C#',
  generatedCode: 'public decimal Calculate() { return 1.0m; }',
  interfaceMappings: [],
  validation: [
    {
      id: 'compile',
      label: '独立编译',
      status: 'pass',
      required: true,
      command: 'dotnet build --nologo -v q',
      summary: '编译通过。编译通过不证明业务行为正确。',
    },
  ],
  files: [
    {
      path: 'src/Calculator.cs',
      status: 'modified',
      expectedOriginalSha256: 'a'.repeat(64),
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -1,1 +1,1 @@',
          lines: [
            { type: 'remove', content: 'throw new NotImplementedException();' },
            { type: 'add', content: 'return 1.0m;' },
          ],
        },
      ],
    },
  ],
};

describe('adaptation HTTP API', () => {
  it('serves health check', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', provider: 'deepseek' });
  });

  it('routes adaptation requests to the adapter', async () => {
    const adapter: CodeAdaptationPort = {
      adapt: vi.fn(async () => adaptationResult),
    };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(adaptationRequest),
    });

    expect(response.status).toBe(200);
    expect(adapter.adapt).toHaveBeenCalledWith(
      adaptationRequest,
      expect.any(AbortSignal),
    );
    expect(await response.json()).toEqual(adaptationResult);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:4173',
    );
  });

  it('disables bare HTTP write-back', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/backfill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: 'HTTP write-back is disabled. Apply an approved migration from the VS Code host.',
    });
  });

  it('rejects malformed adaptation requests', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'translate' }),
    });

    expect(response.status).toBe(400);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('requires JSON content type and valid JSON', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const noContentType = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      body: JSON.stringify(adaptationRequest),
    });
    expect(noContentType.status).toBe(415);

    const invalidJson = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: 'Request body must be valid JSON.' });
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('rejects oversized request bodies', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(2 * 1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown routes and handles OPTIONS', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);
    expect((await fetch(`${url}/unknown`)).status).toBe(404);
    expect((await fetch(`${url}/v1/adapt`, { method: 'OPTIONS' })).status).toBe(204);
  });

  it('returns 502 when the adapter throws', async () => {
    const adapter: CodeAdaptationPort = {
      adapt: vi.fn(async () => {
        throw new Error('DeepSeek API timeout');
      }),
    };
    const url = await listen(adapter);
    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(adaptationRequest),
    });
    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toBe('DeepSeek API timeout');
  });
});
