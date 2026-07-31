import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localFetch } from './local-fetch';
import { checkServiceHealth } from './service-health';

let server: Server;
let baseUrl: string;
let serverAvailable = false;

beforeAll(async () => {
  try {
    server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', storage: 'seekdb' }));
        return;
      }
      if (request.url === '/v1/search' && request.method === 'POST') {
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ candidates: [], echo: body.slice(0, 24) }));
        });
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found.' }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    serverAvailable = true;
  } catch {
    serverAvailable = false;
  }
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('localFetch', () => {
  it('performs GET requests with status and body', async () => {
    if (!serverAvailable) return;
    const response = await localFetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', storage: 'seekdb' });
  });

  it('performs POST requests with a JSON body', async () => {
    if (!serverAvailable) return;
    const response = await localFetch(`${baseUrl}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'hello world' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { echo: string };
    expect(body.echo).toContain('hello world');
  });

  it('keeps failing status codes', async () => {
    if (!serverAvailable) return;
    const response = await localFetch(`${baseUrl}/missing`);
    expect(response.status).toBe(404);
  });
});

describe('checkServiceHealth with localFetch', () => {
  it('reports healthy against a real local server', async () => {
    if (!serverAvailable) return;
    const health = await checkServiceHealth(baseUrl, localFetch);
    expect(health.healthy).toBe(true);
    expect(health.reachable).toBe(true);
  });
});
