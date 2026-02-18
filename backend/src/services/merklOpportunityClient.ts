import { fetchMerklOpportunitiesSnapshot } from '@internal/merkl-shared';

export interface FetchMerklOpportunitiesOptions {
  mainProtocolId?: string;
  status?: string;
  campaigns?: boolean;
  distributionTypes?: string;
  itemsPerPage?: number;
  forceRefresh?: boolean;
}

const OPPORTUNITIES_CACHE_TTL_MS = (() => {
  const raw = process.env.MERKL_OPPORTUNITIES_CACHE_TTL_MS;
  if (!raw) return 1 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1 * 60 * 1000;
})();

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
