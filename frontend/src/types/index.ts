export interface MarketWithSpread {
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  aTokenAddress: string | null;
  vTokenAddress: string | null;
  supplyApy: string;
  borrowApy: string | null;
  supplyIncentives: string[];
  borrowIncentives: string[];
  meritSupplyApr: string[];
  meritBorrowApr: string[];
  meritSelfSupply: string[];
  meritSelfBorrow: string[];
  meritSupplyWithBorrowRequirement?: Array<{
    apr: string;
    requiredBorrowTokens: string[];
    isSelf?: boolean;
  }>;
  meritBorrowWithSupplyRequirement?: Array<{
    apr: string;
    requiredSupplyTokens: string[];
    isSelf?: boolean;
  }>;
  merklSupplyApr: number;
  merklBorrowApr: number;
  merklHoldApr: number;
  merklSupplyAprBreakdowns: any[];
  merklBorrowAprBreakdowns: any[];
  merklHoldAprBreakdowns: any[];
  brevisSupplyApr: number | null;
  brevisBorrowApr: number | null;
  totalIncentiveSupplyApy: number;
  totalSupplyApy: number;
  totalIncentiveBorrowApy: number;
  totalBorrowApy: number | null;
  apySpread: number | null;
}

export interface MarketsResponse {
  data: MarketWithSpread[];
  lastUpdated: string;
  isStale: boolean;
  updateInProgress: boolean;
}

export interface MarketsStats {
  totalMarkets: number;
  totalChains: number;
  totalTokens: number;
  chains: string[];
}

export type SortField = 'totalSupplyApy' | 'totalBorrowApy' | 'apySpread' | null;
export type SortOrder = 'asc' | 'desc';

export type TokenCategory = 'stablecoin' | 'eth-related' | 'btc-related' | 'pendle';

export interface FilterOptions {
  market?: string[];
  token?: string;
  tokenCategory?: TokenCategory[];
  minSupplyApy?: number;
  maxBorrowApy?: number;
}

