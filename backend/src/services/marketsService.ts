/**
 * Markets Service - Cron-write/API-read-only pattern
 *
 * This service internalizes the data fetcher logic:
 * - Cron (every 1 minute) calls refreshMarketsSnapshot() to fetch fresh data
 * - API requests only read from the in-memory snapshot, never trigger fetches
 * - Startup warmup ensures data is available before server accepts requests
 * 
 * Architecture:
 * - Markets: cron every 1 minute (see updateScheduler) calls refreshMarketsSnapshot()
 * - On-chain data: separate cron every 1 minute at :10; per-pool cache TTL 30m (onchainTtlMs)
 * - At merge time, on-chain cache is read (never blocks markets fetch)
 * - If on-chain data missing, fallback calculation for baseVariableBorrowRate
 */

import { fetchMarketsData } from '@internal/aave-fetcher';
import type { NetPositionConstraint } from '@internal/aave-fetcher';
import type { MarketsFetchResult, MarketsPayload, RuntimeReserveData, SpokeHubTopology } from '@internal/aave-shared-contracts';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { v4FatalConfig } from '../config.js';
import { withTimeout } from '@internal/aave-rpc-infra';
import { logger } from '../logger.js';
import {
  initAddressBookRegistry,
  topologySignature,
  getCurrentTopologySignature,
} from './addressBookRegistry.js';
import {
  getOnchainDataFromCache,
  getOnchainCacheStatus,
  calculateBaseRateFallback,
  type OnchainReserveData,
} from './onchainDataService.js';
import { getV3OraclePrice, getV4OraclePrice } from './oracleService.js';
import { setCampaignAccessSnapshot } from './merklCampaignAccessService.js';

// Timeout for markets fetch (Aave API can be slow)
const MARKETS_FETCH_TIMEOUT_MS = 60_000; // 60 seconds

// Re-export types for other modules
export type { MarketsPayload, RuntimeReserveData };

export function getFetchResultOrDefault(metadata: MarketsPayload['_metadata']): MarketsFetchResult {
  return metadata.fetchResult ?? {
    v3: { success: true, source: 'sdk' },
    v4: { success: true, source: 'sdk' },
  };
}

export interface ResolveReserveDeficitResult {
  deficit: string;
  isFallback: boolean;
}

export function resolveReserveDeficit(
  sdkDeficit: string | undefined,
  onchainDeficit: string | undefined
): ResolveReserveDeficitResult {
  if (sdkDeficit !== undefined && sdkDeficit !== '') {
    return { deficit: sdkDeficit, isFallback: false };
  }
  if (onchainDeficit !== undefined) {
    return { deficit: onchainDeficit, isFallback: false };
  }
  return { deficit: '0', isFallback: true };
}

interface MarketsSnapshot {
  payload: MarketsPayload;
  fetchedAt: number;
  deficitFallbackReserveIds: string[];
  v4FallbackReserveIds: string[];
  /** Per-side V3 data from the most recent successful V3 fetch. */
  v3Data: RuntimeReserveData[];
  /** Per-side V4 data from the most recent successful V4 fetch. */
  v4Data: RuntimeReserveData[];
  /** Timestamp of the most recent successful V3 fetch, or null if never succeeded. */
  v3FetchedAt: number | null;
  /** Timestamp of the most recent successful V4 fetch, or null if never succeeded. */
  v4FetchedAt: number | null;
}

// In-memory snapshot (cron-write, API-read-only)
let snapshot: MarketsSnapshot | null = null;

// Per-side stale caches (survive across refresh cycles)
let staleV3Data: RuntimeReserveData[] = [];
let staleV4Data: RuntimeReserveData[] = [];
let v3FetchedAt: number | null = null;
let v4FetchedAt: number | null = null;

// Refresh lock to prevent concurrent refreshes
let refreshInProgress: Promise<MarketsSnapshot> | null = null;

/**
 * Pure function: merge fresh fetcher data with per-side stale fallback.
 *
 * Split fresh data by protocol version (V3: no hubId, V4: has hubId).
 * For each side that failed, use stale data if within hardTtlMs.
 * Returns merged dataset and updated stale state.
 */
export interface PartialStaleMergeInput {
  freshData: RuntimeReserveData[];
  v3Succeeded: boolean;
  v4Succeeded: boolean;
  staleV3Data: RuntimeReserveData[];
  staleV4Data: RuntimeReserveData[];
  v3FetchedAt: number | null;
  v4FetchedAt: number | null;
  hardTtlMs: number;
  now: number;
}

export interface PartialStaleMergeResult {
  mergedData: RuntimeReserveData[];
  newStaleV3Data: RuntimeReserveData[];
  newStaleV4Data: RuntimeReserveData[];
  newV3FetchedAt: number | null;
  newV4FetchedAt: number | null;
  v3Fresh: boolean;
  v4Fresh: boolean;
}

export function mergeWithPartialStale(input: PartialStaleMergeInput): PartialStaleMergeResult {
  const { freshData, v3Succeeded, v4Succeeded, staleV3Data, staleV4Data, v3FetchedAt, v4FetchedAt, hardTtlMs, now } = input;

  // Split fresh data by protocol version.
  // hubId is only present on V4 RuntimeReserveData, not part of the union type —
  // using (r as any) is safe because the runtime convention is reliable (V3 reserves never have hubId).
  const freshV3 = freshData.filter(r => !(r as any).hubId);
  const freshV4 = freshData.filter(r => !!(r as any).hubId);

  // Update stale caches for successful sides
  let newStaleV3Data = staleV3Data;
  let newStaleV4Data = staleV4Data;
  let newV3FetchedAt = v3FetchedAt;
  let newV4FetchedAt = v4FetchedAt;

  if (v3Succeeded && freshV3.length > 0) {
    newStaleV3Data = freshV3;
    newV3FetchedAt = now;
  }
  if (v4Succeeded && freshV4.length > 0) {
    newStaleV4Data = freshV4;
    newV4FetchedAt = now;
  }

  // Build merged dataset: start with fresh data, add stale fallbacks
  let mergedData: RuntimeReserveData[] = [...freshV3, ...freshV4];

  if (!v3Succeeded) {
    if (newV3FetchedAt !== null && (now - newV3FetchedAt) <= hardTtlMs) {
      mergedData = [...staleV3Data, ...mergedData];
    }
    // else: V3 stale expired, keep V3 = [] in merged data
  }

  if (!v4Succeeded) {
    if (newV4FetchedAt !== null && (now - newV4FetchedAt) <= hardTtlMs) {
      mergedData = [...mergedData, ...staleV4Data];
    }
    // else: V4 stale expired, keep V4 = [] in merged data
  }

  return {
    mergedData,
    newStaleV3Data,
    newStaleV4Data,
    newV3FetchedAt,
    newV4FetchedAt,
    v3Fresh: v3Succeeded,
    v4Fresh: v4Succeeded,
  };
}

/**
 * Refresh the markets snapshot with per-side partial stale merge.
 *
 * V3 and V4 fetch concurrently with independent 35s timeouts.
 * If one side fails, its stale data (from the last successful fetch)
 * is used as fallback within marketsHardTtlMs. If stale data has expired,
 * that side is dropped. Only when BOTH sides fail and BOTH stale caches
 * are expired do we throw (snapshot not updated).
 * 
 * Called by cron and startup warmup.
 * Uses a lock to prevent concurrent refreshes.
 */
export async function refreshMarketsSnapshot(): Promise<MarketsSnapshot> {
  // If refresh is already in progress, wait for it
  if (refreshInProgress) {
    return refreshInProgress;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      logger.info(`Starting markets refresh (v4Fatal=${v4FatalConfig.v4Fatal})...`);

      const cachedConstraints = snapshot ? extractConstraintMap(snapshot.payload.data) : undefined;

      let payload: MarketsPayload;
      let v3Succeeded: boolean;
      let v4Succeeded: boolean;
      let fetchResult: ReturnType<typeof getFetchResultOrDefault>;

      try {
        payload = await withTimeout(
          fetchMarketsData({ v4Fatal: v4FatalConfig.v4Fatal, cachedConstraints }),
          MARKETS_FETCH_TIMEOUT_MS,
          'Markets fetch timeout'
        );
        fetchResult = getFetchResultOrDefault(payload._metadata);
        v3Succeeded = fetchResult.v3.success;
        v4Succeeded = fetchResult.v4.success;
      } catch (fetchError) {
        logger.warn(`Markets fetch failed (${fetchError instanceof Error ? fetchError.message : String(fetchError)}), attempting stale fallback`);
        const now = Date.now();
        const hardTtl = BACKEND_CACHE_TTL_MS.marketsHardTtlMs;
        const staleV3Usable = v3FetchedAt !== null && (now - v3FetchedAt) <= hardTtl && staleV3Data.length > 0;
        const staleV4Usable = v4FetchedAt !== null && (now - v4FetchedAt) <= hardTtl && staleV4Data.length > 0;

        if (!staleV3Usable && !staleV4Usable) {
          throw fetchError;
        }

        const fallbackData = [...(staleV3Usable ? staleV3Data : []), ...(staleV4Usable ? staleV4Data : [])];
        if (fallbackData.length === 0) {
          throw fetchError;
        }

        logger.info(`Markets stale fallback: V3=${staleV3Usable ? staleV3Data.length : 0}, V4=${staleV4Usable ? staleV4Data.length : 0} reserves`);
        payload = {
          data: fallbackData,
          _metadata: {
            timestamp: new Date(now - (now - (snapshot?.fetchedAt ?? now))).toISOString(),
            fetchResult: {
              v3: { success: false, source: 'sdk' },
              v4: { success: false, source: 'sdk' },
            },
          },
        } as MarketsPayload;
        fetchResult = { v3: { success: false, source: 'sdk' }, v4: { success: false, source: 'sdk' } };
        v3Succeeded = false;
        v4Succeeded = false;
      }

      const now = Date.now();
      const hardTtl = BACKEND_CACHE_TTL_MS.marketsHardTtlMs;

      // Merge fresh data with per-side stale fallback (pure function)
      const mergeResult = mergeWithPartialStale({
        freshData: payload.data,
        v3Succeeded,
        v4Succeeded,
        staleV3Data,
        staleV4Data,
        v3FetchedAt,
        v4FetchedAt,
        hardTtlMs: hardTtl,
        now,
      });

      // Update module-level stale caches
      staleV3Data = mergeResult.newStaleV3Data;
      staleV4Data = mergeResult.newStaleV4Data;
      v3FetchedAt = mergeResult.newV3FetchedAt;
      v4FetchedAt = mergeResult.newV4FetchedAt;

      // If all data is empty after merge → both sides failed + stale expired
      if (mergeResult.mergedData.length === 0) {
        throw new Error(
          'Both V3 and V4 fetch failed and no stale data within TTL is available'
        );
      }

      // Update payload.data with the merged dataset (may include stale data)
      (payload as any).data = mergeResult.mergedData;

      // Read on-chain data from cache (async, non-blocking)
      // Cache is maintained by separate cron job
      const onchainMap = getOnchainDataFromCache();
      const cacheStatus = getOnchainCacheStatus();

      let mergedCount = 0;
      let fallbackCount = 0;
      const deficitFallbackReserveIds: string[] = [];
      const v4FallbackReserveIds = fetchResult.v4.source === 'rpc'
        ? mergeResult.mergedData
          .filter((reserve) => !!reserve.hubId)
          .map((reserve) => reserve.reserveId)
        : [];

      let v4NotInOnchainCount = 0;

      // Merge on-chain data by reserveId (direct lookup, no remapping needed)
      for (const reserve of mergeResult.mergedData) {
        const onchainData = onchainMap.get(reserve.reserveId);

        // deficit: SDK value > on-chain RPC > default '0'
        const sdkDeficit = (reserve as any).deficit as string | undefined;
        const onchainDeficit = onchainData?.deficit;
        // V4 reserve not in Hub asset registry = no deficit mechanism = not a fallback.
        // Only true fallback is when V3 reserve has no SDK and no onchain deficit source.
        const isV4Reserve = (reserve as any).hubId !== undefined;
        const v4NotInOnchainMap = isV4Reserve && !onchainData && sdkDeficit === undefined;
        if (v4NotInOnchainMap) v4NotInOnchainCount++;
        const { deficit, isFallback } = v4NotInOnchainMap
          ? { deficit: '0', isFallback: false }
          : resolveReserveDeficit(sdkDeficit, onchainDeficit);
        (reserve as any).deficit = deficit;
        if (isFallback) {
          deficitFallbackReserveIds.push(reserve.reserveId);
          fallbackCount++;
          logger.debug(`deficit fallback: ${reserve.reserveId} (sdk=${sdkDeficit ?? 'b'}, onchain=${onchainDeficit ?? 'b'})`);
        }

        // baseBorrowRate: SDK value > on-chain RPC > fallback calculation
        if ((reserve as any).baseBorrowRate !== undefined) {
          // SDK already provided baseBorrowRate — keep it
        } else if (onchainData?.baseVariableBorrowRate !== undefined) {
          (reserve as any).baseBorrowRate = onchainData.baseVariableBorrowRate;
          mergedCount++;
        } else {
          // No SDK value and no on-chain RPC data — use fallback calculation
          const fallbackBaseRate = calculateBaseRateFallback(
            reserve.borrowApy,
            reserve.utilizationPct,
            reserve.optimalUtilization,
            reserve.slopeBelowOptimal,
            reserve.slopeAboveOptimal
          );
          if (fallbackBaseRate !== null) {
            (reserve as any).baseBorrowRate = fallbackBaseRate;
            fallbackCount++;
          }
        }
      }

      // Oracle price override: if oracle diff > 1%, use oracle price
      let oracleOverrideCount = 0;
      for (const reserve of mergeResult.mergedData) {
        let oraclePrice: number | undefined;

        if (reserve.spokeAddress) {
          oraclePrice = getV4OraclePrice(reserve.chainId, reserve.spokeAddress, reserve.tokenAddress);
        } else {
          oraclePrice = getV3OraclePrice(reserve.chainId, reserve.tokenAddress);
        }

        if (oraclePrice === undefined) continue;

        const sdkPrice = reserve.tokenPrice;
        if (sdkPrice === undefined || sdkPrice === 0) {
          reserve.tokenPrice = oraclePrice;
          oracleOverrideCount++;
          continue;
        }

        const diff = Math.abs(oraclePrice - sdkPrice) / sdkPrice;
        if (diff > 0.01) {
          reserve.tokenPrice = oraclePrice;
          oracleOverrideCount++;
        }
      }

      const newSnapshot: MarketsSnapshot = {
        payload,
        fetchedAt: now,
        deficitFallbackReserveIds,
        v4FallbackReserveIds,
        v3Data: staleV3Data,
        v4Data: staleV4Data,
        v3FetchedAt,
        v4FetchedAt,
      };

      snapshot = newSnapshot;

      const newTopology: SpokeHubTopology | undefined = payload.spokeHubTopology;
      if (newTopology && newTopology.length > 0) {
        const newSig = topologySignature(newTopology);
        const currentSig = getCurrentTopologySignature();
        if (newSig !== currentSig) {
          initAddressBookRegistry(newTopology);
          logger.info(`🔄 SpokeHub topology changed (rebuild V4_SPOKE_ENTRIES): ${newTopology.length} entries`);
        }
      }

      if (payload.campaignAccess?.length) {
        setCampaignAccessSnapshot(payload.campaignAccess);
      }

      const v3FreshLabel = mergeResult.v3Fresh ? 'fresh' : 'stale';
      const v4FreshLabel = mergeResult.v4Fresh ? 'fresh' : 'stale';
      const elapsed = now - startTime;
      logger.info(
        `✅ Markets refresh: ${mergeResult.mergedData.length} reserves ` +
        `(V3:${mergeResult.newStaleV3Data.length}/${v3FreshLabel}, V4:${mergeResult.newStaleV4Data.length}/${v4FreshLabel}) ` +
        `in ${elapsed}ms ` +
        `(on-chain: ${mergedCount} merged, ${fallbackCount} fallback, ` +
        `V4-no-hub: ${v4NotInOnchainCount}, ` +
        `oracle: ${oracleOverrideCount} overridden, ` +
        `cache: ${cacheStatus.freshPools}/${cacheStatus.poolCount} fresh)`
      );

      return newSnapshot;
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

/**
 * Get the current markets snapshot.
 * API-read-only: never triggers a refresh.
 * Returns null if snapshot not yet populated (cold start before warmup).
 */
export function getMarketsSnapshot(): MarketsSnapshot | null {
  return snapshot;
}

/**
 * Get markets data for API response.
 * Returns the payload with staleness info.
 */
export function getMarketsData(): {
  payload: MarketsPayload | null;
  staleTimeMs: number;
  hardTtlMs: number;
  ageMs: number | null;
  isTooStale: boolean;
  deficitFallbackReserveIds: string[];
  v4FallbackReserveIds: string[];
} {
  if (!snapshot) {
    logger.warn('Markets snapshot not yet populated; returning null');
    return {
      payload: null,
      staleTimeMs: BACKEND_CACHE_TTL_MS.marketsSoftTtlMs,
      hardTtlMs: BACKEND_CACHE_TTL_MS.marketsHardTtlMs,
      ageMs: null,
      isTooStale: false,
      deficitFallbackReserveIds: [],
      v4FallbackReserveIds: [],
    };
  }

  const ageMs = Date.now() - snapshot.fetchedAt;
    const isTooStale = ageMs > BACKEND_CACHE_TTL_MS.marketsHardTtlMs;
  if (isTooStale) {
    logger.warn(
      `Markets snapshot too stale to serve (age=${Math.round(ageMs / 1000)}s, max=${Math.round(
                BACKEND_CACHE_TTL_MS.marketsHardTtlMs / 1000
      )}s)`
    );
  }

  return {
    payload: snapshot.payload,
    staleTimeMs: BACKEND_CACHE_TTL_MS.marketsSoftTtlMs,
    hardTtlMs: BACKEND_CACHE_TTL_MS.marketsHardTtlMs,
    ageMs,
    isTooStale,
    deficitFallbackReserveIds: snapshot.deficitFallbackReserveIds,
    v4FallbackReserveIds: snapshot.v4FallbackReserveIds,
  };
}

/**
 * Warmup function for startup.
 * Ensures markets data is available before server accepts requests.
 */
export async function warmMarketsCache(): Promise<void> {
  await refreshMarketsSnapshot();
}

export function extractConstraintMap(reserves: RuntimeReserveData[]): Map<string, NetPositionConstraint> {
  const map = new Map<string, NetPositionConstraint>();
  for (const r of reserves) {
    for (const group of [...(r.merklSupplys ?? []), ...(r.merklBorrows ?? []), ...(r.merklHolds ?? [])]) {
      if (group.netPositionConstraint && group.link) {
        map.set(group.link, group.netPositionConstraint);
      }
    }
  }
  return map;
}

