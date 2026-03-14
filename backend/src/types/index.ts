// 复用现有的 FormattedReserveData 类型定义
// 注意：这个文件需要从主项目的 src/index.ts 中导出类型

/**
 * Embedded rate-inputs for a reserve (merged from /api/rate-inputs).
 * All values are raw BigNumber strings (RAY = 10^27 for rates, token decimals for amounts).
 */
export interface EmbeddedRateInputs {
  decimals: number;
  deficit: string;
  // true = deficit fetched from on-chain RPC (real value)
  // false = deficit is '0' placeholder (data from Aave API or Subgraph fallback)
  deficitAvailable: boolean;
  availableLiquidity: string;
  totalScaledVariableDebt: string;
  variableBorrowIndex: string;
  reserveFactor: string;
  variableRateSlope1: string;
  variableRateSlope2: string;
  baseVariableBorrowRate: string;
  optimalUsageRate: string;
}

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
  // Embedded rate-inputs for APR simulation (optional, may be absent if rate-inputs unavailable)
  rateInputs?: EmbeddedRateInputs;
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
    rateInputsAvailable: boolean; // true if rate-inputs were merged into reserves
  };
  reserves: MarketWithSpread[];
}

export interface ReserveRateInput {
  marketName: string;
  chainId: number;
  tokenAddress: string;
  decimals: number;
  // reserve deficit (raw token units)
  deficit: string;
  availableLiquidity: string;
  totalScaledVariableDebt: string;
  variableBorrowIndex: string;
  reserveFactor: string;
  variableRateSlope1: string;
  variableRateSlope2: string;
  baseVariableBorrowRate: string;
  optimalUsageRate: string;
}

export interface RateInputsResponse {
  data: ReserveRateInput[];
  lastUpdated: string;
  staleTimeMs: number;
}
