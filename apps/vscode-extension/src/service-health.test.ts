import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkServiceHealth } from './service-health';

describe('checkServiceHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports healthy on a 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    );
    const health = await checkServiceHealth('http://127.0.0.1:8787');
    expect(health.healthy).toBe(true);
    expect(health.reachable).toBe(true);
  });

  it('keeps the error detail for failing status codes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'SeekDB connection refused' }), { status: 503 }),
      ),
    );
    const health = await checkServiceHealth('http://127.0.0.1:8787');
    expect(health.healthy).toBe(false);
    expect(health.reachable).toBe(true);
    expect(health.detail).toContain('503');
    expect(health.detail).toContain('SeekDB connection refused');
  });

  it('distinguishes unreachable endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('fetch failed'))));
    const health = await checkServiceHealth('http://127.0.0.1:8787');
    expect(health.healthy).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.detail).toContain('无法连接');
  });
});
