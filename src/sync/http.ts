/** HTTP helpers for provider clients. The fetch function is injected; nothing here touches the network itself. */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Retries after the first attempt (default 3). */
  retries?: number;
  /** First backoff delay; doubles per retry (default 2000 ms: 2, 4, 8 s). */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Retry-After in seconds as milliseconds; null when absent or not a number of seconds. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null || !/^\s*\d+(\.\d+)?\s*$/.test(raw)) return null;
  return Number(raw) * 1000;
}

/**
 * Calls `f` and retries 429 and 5xx responses with exponential backoff (or the response's
 * Retry-After seconds). Returns the last Response, whatever its status; errors thrown by `f`
 * propagate. `init` is re-sent as is, so use it for idempotent requests with a re-readable body
 * (a string, not a stream). Retry-After is not capped: a caller with a deadline passes its own
 * `sleep` that gives up.
 */
export async function fetchWithRetry(
  f: FetchLike,
  url: string,
  init?: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await f(url, init);
    if (!retryable(res.status) || attempt >= retries) return res;
    const delay = retryAfterMs(res) ?? baseDelayMs * 2 ** attempt;
    try {
      await res.body?.cancel();
    } catch {
      // The body is discarded either way.
    }
    await sleep(delay);
  }
}

/** A pause between provider requests. */
export function politePause(sleep: (ms: number) => Promise<void>, ms = 1000): Promise<void> {
  return sleep(ms);
}
