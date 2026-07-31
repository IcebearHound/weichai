import http from 'node:http';
import https from 'node:https';
import type { RequestInfo, RequestInit } from 'undici-types';

/**
 * Minimal `fetch` implementation built on Node's native http/https clients.
 *
 * The global `fetch` in the extension host goes through the Undici agent,
 * which honors proxy environment variables and can fail for localhost calls
 * (e.g. when VSCode injects proxy settings). Node's http module does not
 * consult proxy variables, so local service calls stay on the loopback
 * interface regardless of the surrounding proxy configuration.
 */
export function localFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });
  const body = init?.body;
  const signal = init?.signal;

  return new Promise<Response>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method,
        headers: headerRecord,
        signal: signal as AbortSignal | undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') responseHeaders.set(key, value);
            else if (Array.isArray(value) && value.length > 0) {
              responseHeaders.set(key, value.join(', '));
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              statusText: response.statusMessage ?? '',
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.on('error', reject);
    if (body !== null && body !== undefined) {
      if (typeof body === 'string') {
        request.write(body);
      } else if (body instanceof ArrayBuffer) {
        request.write(Buffer.from(body));
      } else if (ArrayBuffer.isView(body)) {
        request.write(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
      }
    }
    request.end();
  });
}
