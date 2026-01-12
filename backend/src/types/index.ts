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
  totalIncentiveSupplyApr: number; // 所有激励 APR 的总和（未转换为 APY）
  totalIncentiveSupplyApy: number;
  totalIncentiveBorrowApr: number; // 所有激励 APR 的总和（未转换为 APY）
  totalIncentiveBorrowApy: number;
}

export interface MarketsResponse {
  data: MarketWithSpread[];
  lastUpdated: string; // ISO timestamp
  isStale: boolean; // true if data is older than 1 minute
  updateInProgress: boolean; // true if update is in progress
}

export interface UpdateStatus {
  status: 'idle' | 'updating' | 'error';
  lastUpdated: string | null;
  lastSuccessfulUpdate: string | null;
  error?: string;
}
