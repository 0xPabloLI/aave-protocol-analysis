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

export declare const AAVE_RPC_URLS_BY_CHAIN_KEY: Readonly<Record<string, readonly string[]>>;
export declare const AAVE_CHAIN_KEY_ALIASES: Readonly<Record<string, string>>;
export declare const AAVE_CHAIN_ID_TO_RPC_KEY: Readonly<Record<number, string>>;
export declare const resolveAaveRpcChainKey: (chainNameOrKey: unknown) => string;
export declare const getAaveRpcUrlsByChainName: (chainNameOrKey: unknown) => string[];
export declare const getAaveRpcUrlsByChainId: (chainId: unknown) => string[];

export declare const DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY: DefaultAaveTydroOpportunitiesQuery;

export declare const resolveCacheTtlMs: (raw: unknown, fallbackMs?: number) => number;

/**
 * Wraps any fetch-like function (global `fetch`, node-fetch, etc.) with a shared
 * process-wide concurrency pool. Callers that use node-fetch should cast:
 * `createMerklConcurrencyLimitedFetch(fetch as typeof globalThis.fetch) as typeof fetch`.
 */
export declare function createMerklConcurrencyLimitedFetch(
  fetchImpl?: typeof globalThis.fetch
): typeof globalThis.fetch;

export declare const fetchMerklOpportunitiesShortPage: (
  options: FetchMerklOpportunitiesShortPageOptions
) => Promise<unknown[]>;

export declare const fetchMerklOpportunitiesSnapshot: (
  options: FetchMerklOpportunitiesSnapshotOptions
) => Promise<unknown[]>;

export declare const __resetMerklOpportunitiesSnapshotCacheForTests: () => void;
