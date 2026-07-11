import {
  fetchMerklOpportunitiesSnapshot,
} from '@internal/aave-shared-config';
import { MERKL_TTL } from '../cacheTtl.js';

export interface FetchMerklOpportunitiesOptions {
  mainProtocolId?: string;
  status?: string;
  campaigns?: boolean;
  distributionTypes?: string;
  itemsPerPage?: number;
  forceRefresh?: boolean;
}

const OPPORTUNITIES_SOFT_TTL_MS = MERKL_TTL.opportunitiesSoftTtlMs;

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
    ttlMs: OPPORTUNITIES_SOFT_TTL_MS,
    forceRefresh: options.forceRefresh,
    fetchImpl: fetch,
  });
