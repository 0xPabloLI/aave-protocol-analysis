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

export declare const fetchMerklOpportunitiesShortPage: (
  options: FetchMerklOpportunitiesShortPageOptions
) => Promise<unknown[]>;

export declare const fetchMerklOpportunitiesSnapshot: (
  options: FetchMerklOpportunitiesSnapshotOptions
) => Promise<unknown[]>;

export declare const __resetMerklOpportunitiesSnapshotCacheForTests: () => void;
