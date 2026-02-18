import { fetchMerklOpportunitiesShortPage } from '@aave/merkl-shared';

export interface FetchMerklOpportunitiesOptions {
  mainProtocolId?: string;
  status?: string;
  campaigns?: boolean;
  distributionTypes?: string;
  itemsPerPage?: number;
}

export const fetchMerklOpportunities = async (
  options: FetchMerklOpportunitiesOptions = {}
): Promise<unknown[]> =>
  fetchMerklOpportunitiesShortPage({
    baseUrl: 'https://api.merkl.xyz/v4',
    mainProtocolId: options.mainProtocolId,
    status: options.status,
    campaigns: options.campaigns,
    distributionTypes: options.distributionTypes,
    itemsPerPage: options.itemsPerPage,
    fetchImpl: fetch,
  });
