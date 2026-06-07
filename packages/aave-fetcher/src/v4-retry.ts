import type { RuntimeReserveData, SpokeHubTopology } from '@internal/aave-shared-contracts';
import { V4ChainsFetchError } from './v4-errors.js';

export interface V4FetchResult {
  mapped: RuntimeReserveData[];
  raw: { reserves: any[] };
  spokeHubTopology: SpokeHubTopology;
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
 * This is the retry logic extracted from `fetchV4ReservesData` so it can be
 * unit-tested without importing `@aave/client-v4`.
 */
export async function fetchV4WithRetry(
  fetchFn: () => Promise<V4FetchResult>,
  options?: { maxRetries?: number },
): Promise<V4FetchResult> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchFn();

      if (result.mapped.length === 0) {
        throw new Error('[V4] Fetch succeeded but returned empty dataset');
      }

      return result;
    } catch (error) {
      // Fast-fail: chains() is unreachable → skip retries
      if (error instanceof V4ChainsFetchError) {
        return EMPTY_V4_RESULT;
      }

      lastError = error instanceof Error ? error : new Error(String(error));
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        break;
      }

      const delayMs = RETRY_BASE_DELAY_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return EMPTY_V4_RESULT;
}