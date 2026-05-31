import type { BaseCampaignBreakdown, CampaignGroup } from '@internal/aave-shared-config';

// ============================================================
// Incentive types
// ============================================================

export interface MeritCampaignInfo {
  action?: string;
  description?: string;
}

export interface MeritAprEntry {
  apr: number;
  selfApr?: number;
  link: string;
  startDate: string;
  endDate: string;
  startBlock?: string;
  endBlock?: string;
  name?: string;
  message?: MeritCampaignInfo[];
  requiredBorrowTokens?: string[];
  requiredSupplyTokens?: string[];
  lastRoundRewardUsd?: number;
}

export type ForecastCampaignTypeLite =
  | 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'DUTCH_AUCTION'
  | 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE';

export interface MerklCampaignBreakdown extends BaseCampaignBreakdown {
  campaignId: string;
  whitelistOnly?: boolean;
  pointsPerThousandUsd?: number;
  campaignType?: ForecastCampaignTypeLite;
  totalBudget?: number;
  aprCap?: number | null;
  latestTvl?: number;
  plannedDaily?: number;
}

export interface MerklOpportunityGroup extends CampaignGroup<MerklCampaignBreakdown> {}

export interface BrevisCampaignBreakdown extends BaseCampaignBreakdown {
  totalBudget?: number;
  latestTvl?: number;
  perUserRewardCapUsd?: number;
  campaignId?: string;
  budgetNormalizedAmount?: number;
  budgetTokenSymbol?: string;
}

export interface BrevisCampaignItem extends CampaignGroup<BrevisCampaignBreakdown> {}

export interface MerklCampaignAccess {
  campaignId: string;
  chainId: number;
  whitelist: string[];
  blacklist: string[];
}

// ============================================================
// Core data types
// ============================================================

export interface RuntimeReserveData {
  reserveId: string;
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  tokenPrice?: number;
  utilizationPct?: number;
  aTokenAddress?: string | null;
  vTokenAddress?: string | null;
  supplyApy?: number;
  supplyDisabled?: boolean;
  isFrozen?: boolean;
  isPaused?: boolean;
  isActive?: false;
  borrowApy?: number;
  borrowDisabled?: boolean;
  supplyIncentives?: number[];
  borrowIncentives?: number[];
  decimals?: number;
  supplyCap?: string;
  borrowCap?: string;
  deficit?: string;
  supplied?: string;
  borrowed?: string;
  liquidity?: string;
  protocolFee?: number;
  slopeBelowOptimal?: number;
  slopeAboveOptimal?: number;
  optimalUtilization?: number;
  baseBorrowRate?: number;
  aaveProReserveId?: string;
  meritSupplys?: MeritAprEntry[];
  meritBorrows?: MeritAprEntry[];
  merklSupplys?: MerklOpportunityGroup[];
  merklBorrows?: MerklOpportunityGroup[];
  merklHolds?: MerklOpportunityGroup[];
  brevisSupplys?: BrevisCampaignItem[];
  brevisBorrows?: BrevisCampaignItem[];
  hubId?: string;
  hubName?: string;
  hubAddress?: string;
  spokeId?: string;
  spokeName?: string;
  spokeAddress?: string;
  collateralRisk?: number;
}

// ============================================================
// API layer types (derived from runtime types)
// ============================================================

export type ApiMeritAprEntry = Pick<
  MeritAprEntry,
  'apr' | 'selfApr' | 'link' | 'name' | 'message' | 'startDate' | 'endDate' | 'lastRoundRewardUsd'
>;

export type ApiMerklBreakdown = Pick<
  MerklCampaignBreakdown,
  | 'campaignApr' | 'campaignStartedAt' | 'campaignEndedAt' | 'campaignId'
  | 'whitelistOnly' | 'pointsPerThousandUsd' | 'campaignType'
  | 'totalBudget' | 'aprCap' | 'latestTvl' | 'plannedDaily'
>;

export type ApiMerklOpportunityGroup = CampaignGroup<ApiMerklBreakdown>;

export type ApiBrevisBreakdown = Pick<
  BrevisCampaignBreakdown,
  'campaignApr' | 'campaignStartedAt' | 'campaignEndedAt' | 'campaignId'
  | 'totalBudget' | 'latestTvl' | 'perUserRewardCapUsd'
  | 'budgetNormalizedAmount' | 'budgetTokenSymbol'
>;

export type ApiBrevisCampaignItem = CampaignGroup<ApiBrevisBreakdown>;

export type FetchSource = 'sdk' | 'rpc' | 'stale' | 'none';

export interface SideFetchResult {
  success: boolean;
  source: FetchSource;
}

export interface MarketsFetchResult {
  v3: SideFetchResult;
  v4: SideFetchResult;
}

export interface MarketsPayload {
  _metadata: {
    timestamp: string;
    version: string;
    dataCount: number;
    profile: string;
    /** Per-side fetch result envelope used by backend stale fallback and source tracking. */
    fetchResult?: MarketsFetchResult;
  };
  data: RuntimeReserveData[];
  campaignAccess?: MerklCampaignAccess[];
}

// ============================================================
// Runtime validation
// ============================================================

export const EXPECTED_RUNTIME_FIELDS = [
  'reserveId',
  'marketName',
  'chainName',
  'chainId',
  'tokenName',
  'tokenSymbol',
  'tokenAddress',
  'tokenPrice',
  'utilizationPct',
  'aTokenAddress',
  'vTokenAddress',
  'supplyApy',
  'supplyDisabled',
  'isFrozen',
  'isPaused',
  'isActive',
  'borrowApy',
  'borrowDisabled',
  'supplyIncentives',
  'borrowIncentives',
  'decimals',
  'supplyCap',
  'borrowCap',
  'deficit',
  'supplied',
  'borrowed',
  'liquidity',
  'protocolFee',
  'slopeBelowOptimal',
  'slopeAboveOptimal',
  'optimalUtilization',
  'baseBorrowRate',
  'aaveProReserveId',
  'meritSupplys',
  'meritBorrows',
  'merklSupplys',
  'merklBorrows',
  'merklHolds',
  'brevisSupplys',
  'brevisBorrows',
  'hubId',
  'hubName',
  'hubAddress',
  'spokeId',
  'spokeName',
  'spokeAddress',
  'collateralRisk',
] as const;

export function validateRuntimeReserveShape(
  data: Record<string, unknown>
): string[] {
  const missing: string[] = [];
  for (const field of EXPECTED_RUNTIME_FIELDS) {
    if (!(field in data)) {
      missing.push(field);
    }
  }
  return missing;
}

type ExpectedField = typeof EXPECTED_RUNTIME_FIELDS[number];
type RuntimeKeys = keyof RuntimeReserveData;

type _AllFieldsCovered = Exclude<RuntimeKeys, ExpectedField>;
type _NoExtraFields = Exclude<ExpectedField, RuntimeKeys>;

const __allFieldsCovered: _AllFieldsCovered = null as never;
const __noExtraFields: _NoExtraFields = null as never;