export interface FetchMerklOpportunitiesShortPageOptions {
  baseUrl?: string;
  mainProtocolId?: string;
  status?: string;
  campaigns?: boolean;
  distributionTypes?: string;
  itemsPerPage?: number;
  fetchImpl?: typeof fetch;
}

export interface FetchMerklOpportunitiesSnapshotOptions extends FetchMerklOpportunitiesShortPageOptions {
  ttlMs?: number;
  forceRefresh?: boolean;
}

export interface DefaultAaveTydroOpportunitiesQuery {
  mainProtocolId: string;
  status: string;
  campaigns: boolean;
  itemsPerPage: number;
}

export interface BaseCampaignBreakdown {
  campaignApr: number;
  campaignStartedAt: string;
  campaignEndedAt: string;
  campaignId?: string;
}

export interface CampaignGroup<TBreakdown extends BaseCampaignBreakdown = BaseCampaignBreakdown> {
  link: string;
  name?: string;
  message?: string;
  breakdowns: TBreakdown[];
  opportunityType?: string;
  netPositionConstraint?: {
    sourceSide: 'supply' | 'borrow';
    offsetReserveIds: string[];
  } | null;
  borrowBlacklist?: boolean;
}

export const DEFAULT_SPOKE_HUB_TOPOLOGY: { chainId: number; spokeAddress: string; hubAddress: string; }[];

export declare const AAVE_RPC_URLS_BY_CHAIN_KEY: Readonly<Record<string, readonly string[]>>;
export declare const AAVE_CHAIN_KEY_ALIASES: Readonly<Record<string, string>>;
export declare const AAVE_CHAIN_ID_TO_RPC_KEY: Readonly<Record<number, string>>;
export declare const resolveAaveRpcChainKey: (chainNameOrKey: unknown) => string;
export declare const getAaveRpcUrlsByChainName: (chainNameOrKey: unknown) => string[];
export declare const getAaveRpcUrlsByChainId: (chainId: unknown) => string[];

export declare const DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY: DefaultAaveTydroOpportunitiesQuery;

export declare const resolveCacheTtlMs: (raw: unknown, fallbackMs?: number) => number;
export declare const normalizeMerklCampaignTotalBudget: (campaign: unknown) => number | null;

/**
 * Wraps any fetch-like function (global `fetch`, node-fetch, etc.) with a shared
 * process-wide concurrency pool. Callers that use node-fetch should cast:
 * `createMerklConcurrencyLimitedFetch(fetch as typeof globalThis.fetch) as typeof fetch`.
 */
export declare function createMerklConcurrencyLimitedFetch(
  fetchImpl?: typeof globalThis.fetch
): typeof globalThis.fetch;

export interface SlidingWindowRateLimiter {
  wait(): Promise<void>;
  getTimestamps(): number[];
  reset(): void;
}

export declare function createSlidingWindowRateLimiter(maxRequestsPerSecond: number): SlidingWindowRateLimiter;

export declare function createAaveV3RateLimitedFetch(
  fetchImpl?: typeof globalThis.fetch
): typeof globalThis.fetch;

export interface V3RateLimitStats {
  total429s: number;
  activeConcurrent: number;
}

export declare function getV3RateLimitStats(): V3RateLimitStats;
export declare function resetV3RateLimitState(): void;

export declare const fetchMerklOpportunitiesShortPage: (
  options: FetchMerklOpportunitiesShortPageOptions
) => Promise<unknown[]>;

export declare const fetchMerklOpportunitiesSnapshot: (
  options: FetchMerklOpportunitiesSnapshotOptions
) => Promise<unknown[]>;

export declare const __resetMerklOpportunitiesSnapshotCacheForTests: () => void;

// ============================================================
// Shared env-var helpers
// ============================================================

export interface NumberEnvOptions {
  defaultValue: number;
  min?: number;
}

export declare function readNumberEnv(key: string, options: NumberEnvOptions): number;

// ============================================================
// Shared env-file / Doppler helpers
// ============================================================

export declare function parseEnvLinesToObject(envText: string): Record<string, string>;
export declare function injectEnv(envVars: Record<string, string>): void;
export declare function tryLoadFromDoppler(): boolean;
