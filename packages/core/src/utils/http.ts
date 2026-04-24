/**
 * Retryable HTTP fetch with exponential backoff.
 * Retries on network errors AND 5xx server errors (services still warming up).
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit & { retries?: number; initialDelayMs?: number }
): Promise<Response> {
  const { retries = 5, initialDelayMs = 2000, ...fetchOpts } = options ?? {};
  let lastError: Error | undefined;
  let lastResponse: Response | undefined;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(15_000) });
      // Retry on 5xx (service still initializing)
      if (res.status >= 500 && attempt < retries) {
        lastResponse = res;
        await sleep(delay);
        delay = Math.min(delay * 2, 10_000);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries) {
        await sleep(delay);
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }
  // Return last 5xx response if we have one, otherwise throw
  if (lastResponse) return lastResponse;
  throw lastError;
}

/**
 * Poll a URL until it returns an HTTP response, with exponential backoff.
 * By default requires 2xx. Set `acceptAny: true` to accept any HTTP response
 * (including 401/403) — useful for services that require auth but where any
 * response means the service is up and listening.
 */
export async function pollUntilReady(
  url: string,
  timeoutMs: number,
  options?: {
    acceptAny?: boolean;
    validateResponse?: (res: Response) => Promise<boolean>;
  }
): Promise<boolean> {
  const { acceptAny = false, validateResponse } = options ?? {};
  const start = Date.now();
  let delay = 2000;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (validateResponse) {
        if (await validateResponse(res)) return true;
      } else if (acceptAny || res.ok) {
        return true;
      }
    } catch {
      // Connection refused — service not ready yet
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 8000);
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
