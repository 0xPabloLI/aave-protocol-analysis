// 复用现有的 FormattedReserveData 类型定义
// 注意：这个文件需要从主项目的 src/index.ts 中导出类型

export interface MarketWithSpread {
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  aTokenAddress: string | null;
  vTokenAddress: string | null;
  supplyApy: number | null;
  borrowApy: number | null;
  supplyIncentives: number[];
  borrowIncentives: number[];
  meritSupplys?: Array<{
    apr: number;
    selfApr?: number;
    link: string;
    startDate: string;
    endDate: string;
    startBlock?: string;
    endBlock?: string;
    requiredBorrowTokens?: string[];
  }>;
  meritBorrows?: Array<{
    apr: number;
    selfApr?: number;
    link: string;
    startDate: string;
    endDate: string;
    startBlock?: string;
    endBlock?: string;
    requiredSupplyTokens?: string[];
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
      pointsPerThousandUsd?: number;
      dailyPoints?: number;
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
      pointsPerThousandUsd?: number;
      dailyPoints?: number;
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
      pointsPerThousandUsd?: number;
      dailyPoints?: number;
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

export interface TokenPriceEntry {
  chainId: number;
  address: string;
  symbol: string;
  price: number;
  updatedAt: number;
  source: string;
}

export type TokenPricesIndex = Record<string, TokenPriceEntry>;

export interface MarketsResponse {
  data: MarketWithSpread[];
  lastUpdated: string; // ISO timestamp
  isStale: boolean; // true if data is older than 1 minute
  updateInProgress: boolean; // true if update is in progress
  tokenPrices?: TokenPricesIndex;
}

export interface UpdateStatus {
  status: 'idle' | 'updating' | 'error';
  lastUpdated: string | null;
  lastSuccessfulUpdate: string | null;
  error?: string;
}
