export const DEFAULT_RETRIEVAL_URL = 'http://127.0.0.1:8787';
export const DEFAULT_ADAPTATION_URL = 'http://127.0.0.1:8788';

const HEALTH_TIMEOUT_MS = 2_000;

export interface ServiceHealth {
  healthy: boolean;
  /** Whether an HTTP response arrived (even a failing status like 503). */
  reachable: boolean;
  detail: string;
}

export async function checkServiceHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceHealth> {
  const url = `${baseUrl.replace(/\/+$/, '')}/health`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (response.ok) return { healthy: true, reachable: true, detail: 'ok' };
    let body = '';
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim()) body = parsed.error.trim();
    } catch {
      body = response.statusText || `HTTP ${response.status}`;
    }
    return {
      healthy: false,
      reachable: true,
      detail: `HTTP ${response.status}${body ? `：${body}` : ''}`,
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? `${error.message}${error.cause instanceof Error ? `（${error.cause.message}）` : ''}`
        : String(error);
    return {
      healthy: false,
      reachable: false,
      detail: `无法连接 ${url}（${reason}）`,
    };
  }
}
