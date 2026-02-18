export interface FetchMerklOpportunitiesShortPageOptions {
  baseUrl?: string;
  mainProtocolId?: string;
  status?: string;
  campaigns?: boolean;
  distributionTypes?: string;
  itemsPerPage?: number;
  fetchImpl?: typeof fetch;
}

export declare const fetchMerklOpportunitiesShortPage: (
  options: FetchMerklOpportunitiesShortPageOptions
) => Promise<unknown[]>;
