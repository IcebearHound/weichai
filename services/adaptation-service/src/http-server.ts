import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AdaptationRequest, FilePatch } from '@forexplore/contracts';
import type { CodeAdaptationPort, CodeBackfillPort } from '@forexplore/workflow-core';

export interface HttpServerOptions {
  adapter: CodeAdaptationPort;
  backfill: CodeBackfillPort;
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

function isAdaptationRequest(value: unknown): value is AdaptationRequest {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<AdaptationRequest>;
  const target = body.target as Partial<AdaptationRequest['target']> | undefined;
  const candidate = body.candidate as Partial<AdaptationRequest['candidate']> | undefined;
  return (
    typeof body.requirement === 'string' &&
    body.requirement.trim().length > 0 &&
    typeof body.strategy === 'string' &&
    ['translate', 'bridge', 'wrap', 'reuse'].includes(body.strategy) &&
    typeof target === 'object' &&
    target !== null &&
    typeof target.id === 'string' &&
    typeof target.name === 'string' &&
    typeof target.path === 'string' &&
    typeof target.signature === 'string' &&
    typeof target.language === 'string' &&
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.id === 'string' &&
    typeof candidate.language === 'string'
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
        json(response, 200, { status: 'ok' }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/adapt') {
        const body = await readBody(request);
        if (!isAdaptationRequest(body)) {
          json(response, 400, { error: 'Invalid AdaptationRequest payload.' }, options.corsOrigin);
          return;
        }
        const result = await options.adapter.adapt(body);
        json(response, 200, result, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/backfill') {
        const body = await readBody(request);
        if (!Array.isArray(body) || !body.every((f) => typeof f === 'object' && f !== null && typeof (f as FilePatch).path === 'string')) {
          json(response, 400, { error: 'Invalid payload: expected FilePatch[].' }, options.corsOrigin);
          return;
        }
        const result = await options.backfill.apply(body as FilePatch[]);
        json(response, 200, result, options.corsOrigin);
        return;
      }

      json(response, 404, { error: 'Not found.' }, options.corsOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown adaptation error.';
      const status = error instanceof HttpError ? error.status : 503;
      if (!(error instanceof HttpError)) console.error(error);
      json(response, status, { error: message }, options.corsOrigin);
    }
  });
}
