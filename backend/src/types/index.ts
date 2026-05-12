// 复用 RuntimeReserveData 类型定义
// 注意：这个文件需要从主项目的 src/index.ts 中导出类型
import type { BaseCampaignBreakdown, CampaignGroup } from '@internal/aave-shared-config';

type MerklMarketBreakdown = BaseCampaignBreakdown & {
  campaignId: string;
  whitelistOnly?: boolean;
  pointsPerThousandUsd?: number;
  campaignType?: string;
  totalBudget?: number;
  aprCap?: number | null;
  latestTvl?: number;
  plannedDaily?: number;
};

type BrevisMarketBreakdown = BaseCampaignBreakdown & {
  totalBudget?: number;
  latestTvl?: number;
  perUserRewardCapUsd?: number;
};

/** GET /api/markets 响应形状；收益率类数字为百分数（序列化层由比例 ×100）。 */
export interface MarketWithSpread {
  reserveId: string;
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  aaveProReserveId?: string;
  tokenPrice?: number;
  utilizationPct?: number;
  aTokenAddress?: string | null;
  vTokenAddress?: string | null;
  supplyApy?: number | null;
  supplyDisabled?: boolean;
  isFrozen?: boolean;
  isPaused?: boolean;
  borrowApy?: number | null;
  borrowDisabled?: boolean;
  // Rate-input fields for manual APR calculation (from Aave SDK)
  decimals?: number;
  availableLiquidity?: string;
  totalVariableDebt?: string; // raw token units - total borrowed
  reserveSize?: string; // raw token units - total supplied
  supplyCap?: string; // raw token units
  borrowCap?: string; // raw token units
  // Rate-model fields are percent numbers (e.g., 9 means 9%) for V3/V4 unified API.
  reserveFactor?: number;
  variableRateSlope1?: number;
  variableRateSlope2?: number;
  optimalUsageRate?: number;
  // On-chain only fields (from UiPoolDataProvider.getReservesHumanized())
  // Absent if RPC fetch failed; cached for 30 min on failure
  baseVariableBorrowRate?: number; // percent (e.g., 0 means 0%)
  deficit?: string; // raw token units - for accurate supply APY calculation
  supplyIncentives?: number[];
  borrowIncentives?: number[];
  meritSupplys?: Array<{
    apr: number;
    selfApr?: number;
    link: string;
    name?: string;
    message?: unknown;
    startDate: string;
    endDate: string;
    lastRoundRewardUsd?: number;
  }>;
  meritBorrows?: Array<{
    apr: number;
    selfApr?: number;
    link: string;
    name?: string;
    message?: unknown;
    startDate: string;
    endDate: string;
    lastRoundRewardUsd?: number;
  }>;
  merklSupplys?: CampaignGroup<MerklMarketBreakdown>[];
  merklBorrows?: CampaignGroup<MerklMarketBreakdown>[];
  merklHolds?: CampaignGroup<MerklMarketBreakdown>[];
  brevisSupplys?: CampaignGroup<BrevisMarketBreakdown>[];
  brevisBorrows?: CampaignGroup<BrevisMarketBreakdown>[];
  // V4 Hub & Spoke addresses for contract interaction (only present for V4 markets)
  hubId?: string;
  hubName?: string;
  hubAddress?: string;
  spokeId?: string;
  spokeName?: string;
  spokeAddress?: string;
}

export interface MarketsResponse {
  snapshot: {
    lastUpdated: string; // ISO timestamp
    version: 'markets-v2';
    staleTimeMs: number;
  };
  reserves: MarketWithSpread[];
}

// Note: ReserveRateInput and RateInputsResponse removed
// Rate-inputs are no longer a separate concept; only deficit is fetched from on-chain
// and merged into MarketWithSpread.deficit
