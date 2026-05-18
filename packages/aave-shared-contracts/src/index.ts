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

type ForecastCampaignTypeLite =
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
  aTokenAddress?: string;
  vTokenAddress?: string;
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
}

export interface MarketsPayload {
  _metadata: {
    timestamp: string;
    version: string;
    dataCount: number;
    profile: string;
  };
  data: RuntimeReserveData[];
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

type ValidateAllFieldsCovered = {
  [K in RuntimeKeys]: K extends ExpectedField ? true : never;
}[RuntimeKeys];

type ValidateNoExtraFields = {
  [K in ExpectedField]: K extends RuntimeKeys ? true : never;
}[ExpectedField];