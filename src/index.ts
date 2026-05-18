export type {
  RuntimeReserveData,
  MarketsPayload,
  MeritAprEntry,
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