import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SearchRequest } from '@forexplore/contracts';
import type { SearchEngine, SearchStore } from './types.js';

export interface HttpServerOptions {
  engine: SearchEngine;
  store: SearchStore;
  corsOrigin: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  corsOrigin: string,
): void {
  response.writeHead(status, {
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > 1024 * 1024) {
    throw new HttpError(413, 'Request body exceeds 1 MiB.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body exceeds 1 MiB.');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function isSearchRequest(value: unknown): value is SearchRequest {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<SearchRequest>;
  const target = body.target as Partial<SearchRequest['target']> | undefined;
  return (
    typeof body.requirement === 'string' &&
    body.requirement.trim().length > 0 &&
    Number.isInteger(body.topK) &&
    Number(body.topK) >= 1 &&
    Number(body.topK) <= 50 &&
    ['hybrid', 'semantic', 'structure'].includes(String(body.retrievalMode)) &&
    Array.isArray(body.repositoryScopes) &&
    body.repositoryScopes.every((scope) => typeof scope === 'string') &&
    typeof target === 'object' &&
    target !== null &&
    typeof target.id === 'string' &&
    typeof target.name === 'string' &&
    typeof target.path === 'string' &&
    typeof target.signature === 'string' &&
    ['class', 'function'].includes(String(target.kind)) &&
    typeof target.language === 'string'
  );
}

export function createHttpServer(options: HttpServerOptions): Server {
  return createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      json(response, 204, null, options.corsOrigin);
      return;
    }

    try {
      if (request.method === 'GET' && request.url === '/health') {
        await options.store.ping();
        json(response, 200, { status: 'ok', storage: 'seekdb' }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/search') {
        const body = await readBody(request);
        if (!isSearchRequest(body)) {
          json(response, 400, { error: 'Invalid SearchRequest payload.' }, options.corsOrigin);
          return;
        }
        const candidates = await options.engine.search(body);
        json(response, 200, { candidates }, options.corsOrigin);
        return;
      }

      json(response, 404, { error: 'Not found.' }, options.corsOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown retrieval error.';
      const status = error instanceof HttpError ? error.status : 503;
      if (!(error instanceof HttpError)) console.error(error);
      json(response, status, { error: message }, options.corsOrigin);
    }
  });
}
