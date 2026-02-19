import {
  DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY,
  fetchMerklOpportunitiesSnapshot,
  resolveCacheTtlMs,
} from '@internal/merkl-shared';

export interface FetchMerklOpportunitiesOptions {
  mainProtocolId?: string;
  status?: string;
  campaigns?: boolean;
  distributionTypes?: string;
  itemsPerPage?: number;
  forceRefresh?: boolean;
}

const OPPORTUNITIES_CACHE_TTL_MS = resolveCacheTtlMs(
  process.env.MERKL_OPPORTUNITIES_CACHE_TTL_MS,
  1 * 60 * 1000
);

export const fetchMerklOpportunities = async (
  options: FetchMerklOpportunitiesOptions = {}
): Promise<unknown[]> =>
  fetchMerklOpportunitiesSnapshot({
    baseUrl: 'https://api.merkl.xyz/v4',
    mainProtocolId:
      options.mainProtocolId ?? DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY.mainProtocolId,
    status: options.status ?? DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY.status,
    campaigns: options.campaigns ?? DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY.campaigns,
    distributionTypes: options.distributionTypes,
    itemsPerPage: options.itemsPerPage ?? DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY.itemsPerPage,
    ttlMs: OPPORTUNITIES_CACHE_TTL_MS,
    forceRefresh: options.forceRefresh,
    fetchImpl: fetch,
  });
