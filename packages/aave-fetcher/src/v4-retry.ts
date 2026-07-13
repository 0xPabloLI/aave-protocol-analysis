import type { RuntimeReserveData, SpokeHubTopology } from '@internal/aave-shared-contracts';
import { V4ChainsFetchError } from './v4-errors.js';

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown>) => void;

export interface V4FetchResult {
  mapped: RuntimeReserveData[];
  raw: { reserves: any[] };
  spokeHubTopology: SpokeHubTopology;
}

export interface V4RetryResult extends V4FetchResult {
  lastError?: Error;
}

const EMPTY_V4_RESULT: V4FetchResult = {
  mapped: [],
  raw: { reserves: [] },
  spokeHubTopology: [],
};

const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

/**
 * Retry wrapper for V4 data fetching.
 *
 * - On `V4ChainsFetchError`: **no retries** — the SDK's GraphQL endpoint is unreachable,
 *   so retrying won't help. Returns `emptyResult` immediately.
 * - On other errors: retries up to `maxRetries` times with exponential backoff.
 * - On success but empty result: treats as failure (retries).
 *
 * Returns `{ ...result, lastError }` so callers can re-throw the original error
 * with its stack trace intact.
 */
export async function fetchV4WithRetry(
  fetchFn: () => Promise<V4FetchResult>,
  options?: { maxRetries?: number; logFn?: LogFn },
): Promise<V4RetryResult> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const logFn = options?.logFn;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchFn();

      if (result.mapped.length === 0) {
        throw new Error('[V4] Fetch succeeded but returned empty dataset');
      }

      if (attempt > 1) {
        logFn?.('info', `[V4] Retry attempt ${attempt}/${maxRetries} succeeded with ${result.mapped.length} reserves`, {});
      }

      return result;
    } catch (error) {
      // Fast-fail: chains() is unreachable → skip retries
      if (error instanceof V4ChainsFetchError) {
        logFn?.('warn', `[V4] chains() unreachable — fast-fail, skipping retries`, { error: error.message });
        return { ...EMPTY_V4_RESULT, lastError: error };
      }

      lastError = error instanceof Error ? error : new Error(String(error));
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        logFn?.('error', `[V4] All ${maxRetries} attempts failed. Last error: ${lastError.message}`, {});
        break;
      }

      const delayMs = RETRY_BASE_DELAY_MS * attempt;
      logFn?.('warn', `[V4] Attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms... (error: ${lastError.message})`, {});
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { ...EMPTY_V4_RESULT, lastError: lastError ?? undefined };
}