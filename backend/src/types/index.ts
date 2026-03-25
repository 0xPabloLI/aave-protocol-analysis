// 复用现有的 FormattedReserveData 类型定义
// 注意：这个文件需要从主项目的 src/index.ts 中导出类型

export interface MarketWithSpread {
  reserveId: string;
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  tokenPrice?: number;
  reserveSizeUsd?: number;
  utilizationPct?: number;
  aTokenAddress?: string | null;
  vTokenAddress?: string | null;
  supplyApy?: number | null;
  supplyDisabled?: boolean;
  supplyCapUsd?: number;
  borrowApy?: number | null;
  borrowDisabled?: boolean;
  borrowCapUsd?: number;
  // Rate-input fields for manual APR calculation (from Aave SDK)
  decimals?: number;
  availableLiquidity?: string;
  totalVariableDebt?: string; // raw token units - total borrowed
  reserveFactor?: string;
  variableRateSlope1?: string;
  variableRateSlope2?: string;
  optimalUsageRate?: string;
  // On-chain only fields (from UiPoolDataProvider.getReservesHumanized())
  // Absent if RPC fetch failed; cached for 30 min on failure
  baseVariableBorrowRate?: string; // RAY (1e27) - for simulated borrow rate calculation
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
  merklSupplys?: Array<{
    link: string;
    name?: string;
    message?: string;
    breakdowns: Array<{
      campaignApr: number;
      campaignStartedAt: string;
      campaignEndedAt: string;
      campaignId: string;
      whitelistOnly?: boolean;
      pointsPerThousandUsd?: number;
      dailyPoints?: number;
      campaignType?: string;
      totalBudget?: number;
      aprCap?: number | null;
      latestTvl?: number;
      plannedDaily?: number;
    }>;
  }>;
  merklBorrows?: Array<{
    link: string;
    name?: string;
    message?: string;
    breakdowns: Array<{
      campaignApr: number;
      campaignStartedAt: string;
      campaignEndedAt: string;
      campaignId: string;
      whitelistOnly?: boolean;
      pointsPerThousandUsd?: number;
      dailyPoints?: number;
      campaignType?: string;
      totalBudget?: number;
      aprCap?: number | null;
      latestTvl?: number;
      plannedDaily?: number;
    }>;
  }>;
  merklHolds?: Array<{
    link: string;
    name?: string;
    message?: string;
    breakdowns: Array<{
      campaignApr: number;
      campaignStartedAt: string;
      campaignEndedAt: string;
      campaignId: string;
      whitelistOnly?: boolean;
      pointsPerThousandUsd?: number;
      dailyPoints?: number;
      campaignType?: string;
      totalBudget?: number;
      aprCap?: number | null;
      latestTvl?: number;
      plannedDaily?: number;
    }>;
  }>;
  brevisSupplys?: Array<{
    apr: number;
    link: string;
    startDate: string;
    endDate: string;
    name: string;
  }>;
  brevisBorrows?: Array<{
    apr: number;
    link: string;
    startDate: string;
    endDate: string;
    name: string;
  }>;
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
