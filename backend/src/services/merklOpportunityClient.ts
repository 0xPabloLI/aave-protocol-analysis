import {
  fetchMerklOpportunitiesSnapshot,
  resolveCacheTtlMs,
} from '@internal/merkl-shared';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';

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
  BACKEND_CACHE_TTL_MS.merklOpportunitiesDefault
);

export const fetchMerklOpportunities = async (
  options: FetchMerklOpportunitiesOptions = {}
): Promise<unknown[]> =>
  fetchMerklOpportunitiesSnapshot({
    baseUrl: 'https://api.merkl.xyz/v4',
    mainProtocolId: options.mainProtocolId,
    status: options.status,
    campaigns: options.campaigns,
    distributionTypes: options.distributionTypes,
    itemsPerPage: options.itemsPerPage,
    ttlMs: OPPORTUNITIES_CACHE_TTL_MS,
    forceRefresh: options.forceRefresh,
    fetchImpl: fetch,
  });
