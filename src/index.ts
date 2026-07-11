export type {
  RuntimeReserveData,
  MarketsPayload,
  MerklCampaignBreakdown,
  MerklOpportunityGroup,
  BrevisCampaignBreakdown,
  BrevisCampaignItem,
} from '@internal/aave-shared-contracts';

export {
  fetchMarketsData,
  runMarketsFetcher,
  getDataDir,
} from '@internal/aave-fetcher';