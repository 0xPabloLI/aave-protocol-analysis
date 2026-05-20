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
  isActive?: false;
  borrowApy?: number | null;
  borrowDisabled?: boolean;
  // Rate-input fields for manual APR calculation (from Aave SDK)
  decimals?: number;
  supplyCap?: string;
  borrowCap?: string;
  // 字段重命名后仅保留新字段名
  supplied?: string;
  borrowed?: string;
  liquidity?: string;
  protocolFee?: number;
  slopeBelowOptimal?: number;
  slopeAboveOptimal?: number;
  optimalUtilization?: number;
  baseBorrowRate?: number; // percent (e.g., 0 means 0%)
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
    _isExpired?: boolean;
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
    _isExpired?: boolean;
  }>;
  merklSupplys?: CampaignGroup<MerklMarketBreakdown & { _isExpired?: boolean }>[];
  merklBorrows?: CampaignGroup<MerklMarketBreakdown & { _isExpired?: boolean }>[];
  merklHolds?: CampaignGroup<MerklMarketBreakdown & { _isExpired?: boolean }>[];
  brevisSupplys?: CampaignGroup<BrevisMarketBreakdown & { _isExpired?: boolean }>[];
  brevisBorrows?: CampaignGroup<BrevisMarketBreakdown & { _isExpired?: boolean }>[];
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
    version: 'markets-v3';
    staleTimeMs: number;
    schemaFingerprint?: string; // Hash of API response field names; changes when shape changes
  };
  reserves: MarketWithSpread[];
}

// Note: ReserveRateInput and RateInputsResponse removed
// Rate-inputs are no longer a separate concept; only deficit is fetched from on-chain
// and merged into MarketWithSpread.deficit
