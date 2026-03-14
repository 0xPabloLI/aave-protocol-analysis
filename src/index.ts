import './env.js';
import { writeFile, mkdir } from 'fs/promises';
import { chainId, AaveClient, ChainsFilter } from "@aave/client";
import { markets, chains } from "@aave/client/actions";
import * as addressBook from "@bgd-labs/aave-address-book";

// 创建 Aave 客户端实例
const client = AaveClient.create();
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { writeJsonAtomic } from './file-utils.js';
import { brevisApi } from './brevis-api.js';
import {
  MerklCampaignBreakdown,
  MerklOpportunityData,
  MerklOpportunityGroup,
  processMerklData,
  findMatchingMerklOpportunities,
  formatMerklBreakdown
} from './merkl-api.js';
import {
  MeritDataItem,
  MeritAprEntry,
  fetchMeritData,
  getMeritDataFromMarket
} from './merit-api.js';
import type { BrevisCampaignItem, BrevisDataItem } from './brevis-api.js';
import {
  checkAndReportSessionStatus,
  closeBrowserInstances
} from './cloudflare-browser.js';

interface NetworkInfo {
  name: string;
  chainId: number;
  poolAddress: string;
}

interface MarketData {
  timestamp: string;
  totalNetworks: number;
  chainIds: number[];
  networkInfo: NetworkInfo[];
  markets: any[];
  errors: string[];
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    // Common Aave client pattern: DecimalValue { value: string }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maybeValue = (value as any).value;
    if (typeof maybeValue === 'string' || typeof maybeValue === 'number' || typeof maybeValue === 'bigint') {
      return toFiniteNumber(maybeValue);
    }
  }
  return null;
}

interface FormattedReserveData {
  reserveId: string;
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string; // underlying token address
  tokenPrice?: number;
  reserveSizeUsd?: number;
  utilizationPct?: number;
  aTokenAddress: string | null; // aToken address
  vTokenAddress: string | null; // variableDebtToken address
  supplyApy: number | undefined; // APY 百分比值（如 5.2 表示 5.2%）
  supplyDisabled?: boolean; // true when isFrozen, isPaused, or supplyCap is 1
  supplyCapUsd?: number; // 供应上限（USD）
  borrowApy: number | undefined; // APY 百分比值（如 5.2 表示 5.2%）
  borrowDisabled?: boolean; // true when borrowingState is DISABLED or borrowCap is 1
  borrowCapUsd?: number; // 借款上限（USD），与 supplyCapUsd 对称
  supplyIncentives: number[]; // Protocol supply incentives 百分比值数组
  borrowIncentives: number[]; // Protocol borrow incentives 百分比值数组
  // Rate-input fields for manual APR calculation (raw strings for precision)
  decimals?: number;
  availableLiquidity?: string;
  totalScaledVariableDebt?: string;
  variableBorrowIndex?: string; // RAY (1e27) when using Aave API
  reserveFactor?: string;
  variableRateSlope1?: string;
  variableRateSlope2?: string;
  optimalUsageRate?: string;
  meritSupplys?: MeritAprEntry[];
  meritBorrows?: MeritAprEntry[];
  merklSupplys?: MerklOpportunityGroup[];
  merklBorrows?: MerklOpportunityGroup[];
  merklHolds?: MerklOpportunityGroup[];
  brevisSupplys?: BrevisCampaignItem[];
  brevisBorrows?: BrevisCampaignItem[];
}

interface RuntimeReserveData {
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
  aTokenAddress?: string;
  vTokenAddress?: string;
  supplyApy?: number;
  supplyDisabled?: boolean;
  supplyCapUsd?: number;
  borrowApy?: number;
  borrowDisabled?: boolean;
  borrowCapUsd?: number;
  supplyIncentives?: number[];
  borrowIncentives?: number[];
  // Rate-input fields for manual APR calculation
  decimals?: number;
  availableLiquidity?: string;
  totalScaledVariableDebt?: string;
  variableBorrowIndex?: string;
  reserveFactor?: string;
  variableRateSlope1?: string;
  variableRateSlope2?: string;
  optimalUsageRate?: string;
  deficit?: string; // from on-chain RPC
  meritSupplys?: MeritAprEntry[];
  meritBorrows?: MeritAprEntry[];
  merklSupplys?: MerklOpportunityGroup[];
  merklBorrows?: MerklOpportunityGroup[];
  merklHolds?: MerklOpportunityGroup[];
  brevisSupplys?: BrevisCampaignItem[];
  brevisBorrows?: BrevisCampaignItem[];
}

// Payload interface for backend to import (cron-write/API-read-only pattern)
// ts-prune-ignore-next
export interface MarketsPayload {
  _metadata: {
    timestamp: string;
    version: string;
    dataCount: number;
    profile: string;
  };
  data: RuntimeReserveData[];
}

// Re-export for backend type usage
// ts-prune-ignore-next
export type { RuntimeReserveData };

function pruneMeritEntryForRuntime(entry: MeritAprEntry): MeritAprEntry {
  return {
    apr: entry.apr,
    ...(entry.selfApr !== undefined ? { selfApr: entry.selfApr } : {}),
    link: entry.link,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.message ? { message: entry.message } : {}),
    startDate: entry.startDate,
    endDate: entry.endDate,
    ...(entry.lastRoundRewardUsd !== undefined ? { lastRoundRewardUsd: entry.lastRoundRewardUsd } : {}),
  };
}

function pruneMerklBreakdownForRuntime(breakdown: MerklCampaignBreakdown): MerklCampaignBreakdown {
  return {
    campaignApr: breakdown.campaignApr,
    campaignStartedAt: breakdown.campaignStartedAt,
    campaignEndedAt: breakdown.campaignEndedAt,
    campaignId: breakdown.campaignId,
    ...(breakdown.whitelistOnly !== undefined ? { whitelistOnly: breakdown.whitelistOnly } : {}),
    ...(breakdown.pointsPerThousandUsd !== undefined
      ? { pointsPerThousandUsd: breakdown.pointsPerThousandUsd }
      : {}),
  };
}

function pruneMerklGroupForRuntime(group: MerklOpportunityGroup): MerklOpportunityGroup {
  return {
    link: group.link,
    ...(group.name ? { name: group.name } : {}),
    ...(group.message ? { message: group.message } : {}),
    breakdowns: (group.breakdowns ?? []).map(pruneMerklBreakdownForRuntime),
  };
}

function pruneReserveForRuntime(item: FormattedReserveData): RuntimeReserveData {
  return {
    reserveId: item.reserveId,
    marketName: item.marketName,
    chainName: item.chainName,
    chainId: item.chainId,
    tokenName: item.tokenName,
    tokenSymbol: item.tokenSymbol,
    tokenAddress: item.tokenAddress,
    ...(item.tokenPrice !== undefined ? { tokenPrice: item.tokenPrice } : {}),
    ...(item.reserveSizeUsd !== undefined ? { reserveSizeUsd: item.reserveSizeUsd } : {}),
    ...(item.utilizationPct !== undefined ? { utilizationPct: item.utilizationPct } : {}),
    ...(item.aTokenAddress ? { aTokenAddress: item.aTokenAddress } : {}),
    ...(item.vTokenAddress ? { vTokenAddress: item.vTokenAddress } : {}),
    ...(item.supplyApy !== undefined ? { supplyApy: item.supplyApy } : {}),
    ...(item.supplyDisabled ? { supplyDisabled: true } : {}),
    ...(item.supplyCapUsd !== undefined ? { supplyCapUsd: item.supplyCapUsd } : {}),
    ...(item.borrowApy !== undefined ? { borrowApy: item.borrowApy } : {}),
    ...(item.borrowDisabled ? { borrowDisabled: true } : {}),
    ...(item.borrowCapUsd !== undefined ? { borrowCapUsd: item.borrowCapUsd } : {}),
    ...(item.supplyIncentives && item.supplyIncentives.length > 0 ? { supplyIncentives: item.supplyIncentives } : {}),
    ...(item.borrowIncentives && item.borrowIncentives.length > 0 ? { borrowIncentives: item.borrowIncentives } : {}),
    ...(item.meritSupplys && item.meritSupplys.length > 0
      ? { meritSupplys: item.meritSupplys.map(pruneMeritEntryForRuntime) }
      : {}),
    ...(item.meritBorrows && item.meritBorrows.length > 0
      ? { meritBorrows: item.meritBorrows.map(pruneMeritEntryForRuntime) }
      : {}),
    ...(item.merklSupplys && item.merklSupplys.length > 0
      ? { merklSupplys: item.merklSupplys.map(pruneMerklGroupForRuntime) }
      : {}),
    ...(item.merklBorrows && item.merklBorrows.length > 0
      ? { merklBorrows: item.merklBorrows.map(pruneMerklGroupForRuntime) }
      : {}),
    ...(item.merklHolds && item.merklHolds.length > 0
      ? { merklHolds: item.merklHolds.map(pruneMerklGroupForRuntime) }
      : {}),
    ...(item.brevisSupplys && item.brevisSupplys.length > 0 ? { brevisSupplys: item.brevisSupplys } : {}),
    ...(item.brevisBorrows && item.brevisBorrows.length > 0 ? { brevisBorrows: item.brevisBorrows } : {}),
    // Rate-input fields for manual APR calculation
    ...(item.decimals !== undefined ? { decimals: item.decimals } : {}),
    ...(item.availableLiquidity ? { availableLiquidity: item.availableLiquidity } : {}),
    ...(item.totalScaledVariableDebt ? { totalScaledVariableDebt: item.totalScaledVariableDebt } : {}),
    ...(item.variableBorrowIndex ? { variableBorrowIndex: item.variableBorrowIndex } : {}),
    ...(item.reserveFactor ? { reserveFactor: item.reserveFactor } : {}),
    ...(item.variableRateSlope1 ? { variableRateSlope1: item.variableRateSlope1 } : {}),
    ...(item.variableRateSlope2 ? { variableRateSlope2: item.variableRateSlope2 } : {}),
    ...(item.optimalUsageRate ? { optimalUsageRate: item.optimalUsageRate } : {}),
  };
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const RUNTIME_DATA_DIR = join(DATA_DIR, 'runtime');
const DEBUG_DATA_DIR = join(DATA_DIR, 'debug');
const EXPORT_DATA_DIR = join(DATA_DIR, 'exports');

// 从 baseDataset 构建链-代币索引：chainNameLower -> Set<tokenSymbolLower>
function buildChainTokenIndex(baseDataset: FormattedReserveData[]): Record<string, Set<string>> {
  const index: Record<string, Set<string>> = {};
  
  baseDataset.forEach(item => {
    const chainName = item.chainName.toLowerCase();
    if (!chainName) return;
    if (!index[chainName]) index[chainName] = new Set<string>();
    const tokenSymbol = item.tokenSymbol;
    // 将 tokenSymbol 转换为小写，以便与 Brevis description（已转换为小写）匹配
    if (tokenSymbol) index[chainName].add(tokenSymbol.toLowerCase());
  });
  
  logger.info(`🗂️  Built chain-token index: ${Object.keys(index).length} chains`);
  Object.entries(index).forEach(([chain, tokens]) => {
    logger.info(`   • ${chain}: ${tokens.size} tokens`);
  });
  return index;
}

function getAllAaveV3NetworksFromAddressBook(): NetworkInfo[] {
  // 获取所有 AaveV3 网络（排除测试网）
  const aaveV3Networks = Object.keys(addressBook).filter(key => 
    key.startsWith('AaveV3') && 
    !key.includes('Sepolia') && 
    !key.includes('Fuji')
  );

  const networkInfo: NetworkInfo[] = aaveV3Networks.map(networkName => {
    const network = (addressBook as any)[networkName];
    return {
      name: networkName,
      chainId: network.CHAIN_ID,
      poolAddress: network.POOL
    };
  }).filter(info => info.chainId); // 只保留有chainId的网络

  return networkInfo;
}

function extractChainsResult(result: unknown): Array<{ chainId: number; name?: string }> {
  if (result && typeof result === 'object' && 'isErr' in result && typeof (result as any).isErr === 'function') {
    if ((result as any).isErr()) {
      const errorInfo = (result as any).error;
      throw new Error(errorInfo?.message || 'Failed to fetch chains from Aave API');
    }
    return ((result as any).value || []) as Array<{ chainId: number; name?: string }>;
  }

  if (Array.isArray(result)) {
    return result as Array<{ chainId: number; name?: string }>;
  }

  if (result && typeof result === 'object' && 'value' in (result as any) && Array.isArray((result as any).value)) {
    return (result as any).value as Array<{ chainId: number; name?: string }>;
  }

  throw new Error('Unexpected chains response format from Aave API');
}

async function getAllAaveV3Networks(): Promise<NetworkInfo[]> {
  const fallback = getAllAaveV3NetworksFromAddressBook();
  const addressBookPoolByChainId = new Map<number, string>();
  fallback.forEach((entry) => {
    addressBookPoolByChainId.set(entry.chainId, entry.poolAddress);
  });

  try {
    const result = await chains(client, ChainsFilter.MAINNET_ONLY);
    const apiChains = extractChainsResult(result);

    const networkInfo: NetworkInfo[] = apiChains
      .map((chain) => {
        const id = Number(chain.chainId);
        if (!Number.isFinite(id) || id <= 0) return null;
        const chainName = typeof chain.name === 'string' && chain.name.trim() ? chain.name.trim() : `Chain${id}`;
        return {
          name: `AaveV3${chainName.replace(/\s+/g, '')}`,
          chainId: id,
          poolAddress: addressBookPoolByChainId.get(id) || '',
        } as NetworkInfo;
      })
      .filter((entry): entry is NetworkInfo => entry !== null);

    if (networkInfo.length === 0) {
      throw new Error('Aave API returned empty mainnet chain list');
    }

    logger.info(`✅ Loaded ${networkInfo.length} chains from Aave API (MAINNET_ONLY)`);
    return networkInfo;
  } catch (error) {
    logger.warn(`⚠️ Failed to fetch chains from Aave API, falling back to address-book: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}


// Brevis APR 提取：基于 Aave 市场链/代币列表匹配 campaign 数据
async function fetchBrevisAprs(
  baseDataset: FormattedReserveData[]
): Promise<BrevisDataIndex> {
  try {
    logger.info('🌐 Fetching Brevis Incentra Aave campaign data...');
    
    // 获取所有 Aave campaign 数据（包含原始响应数据）
    const brevisResult = await brevisApi.getAaveCampaignsData();
    const brevisIndex: BrevisDataIndex = brevisResult.index;
    
    // 输出原始 Brevis 数据（包括原始 API 响应），方便查看和调试
    await mkdir(DEBUG_DATA_DIR, { recursive: true });
    const totalSupply = Object.values(brevisIndex).reduce((sum, item) => sum + item.brevisSupplys.length, 0);
    const totalBorrow = Object.values(brevisIndex).reduce((sum, item) => sum + item.brevisBorrows.length, 0);
    
    const brevisRawPath = join(DEBUG_DATA_DIR, 'brevis-raw-data.json');
    await writeJsonAtomic(brevisRawPath, {
      timestamp: new Date().toISOString(),
      totalSupplyCampaigns: totalSupply,
      totalBorrowCampaigns: totalBorrow,
      indexedBy: 'chainId-tokenAddress',
      // 原始 API 响应数据（用于调试和问题排查）
      rawProtocolsList: brevisResult.rawProtocolsList,
      rawProtocolDetails: brevisResult.rawProtocolDetails,
      // 处理后的索引数据
      index: brevisIndex
    });
    logger.info(`💾 Brevis raw data saved to ${brevisRawPath}`);
    
    logger.info(`✅ Indexed Brevis campaign data for ${Object.keys(brevisIndex).length} chain-token combinations`);
    logger.info(`   Supply campaigns: ${totalSupply}, Borrow campaigns: ${totalBorrow}`);
    
    return brevisIndex;
  } catch (error) {
    logger.error('❌ Error fetching Brevis APR data:', error);
    return {};
  }
}



// 从 Aave 市场数据创建基础数据集
function createBaseDatasetFromMarkets(markets: any[]): FormattedReserveData[] {
  const baseDataset: FormattedReserveData[] = [];

  markets.forEach(market => {
    const marketName = market.name || 'Unknown';
    const chainName = market.chain?.name || 'Unknown';
    const chainId = market.chain?.chainId || 0;

    if (market.supplyReserves && Array.isArray(market.supplyReserves)) {
      market.supplyReserves.forEach((reserve: any) => {
        // 过滤掉 isFrozen=true 或 isPaused=true 的 supply reserves
        if (reserve.isFrozen === true || reserve.isPaused === true) {
          return;
        }

        const tokenSymbol = reserve.underlyingToken?.symbol || 'Unknown';
        const tokenAddress = reserve.underlyingToken?.address || '';
        const tokenAddressLower = tokenAddress.toLowerCase();
        const reserveId = `${marketName}:${chainId}:${tokenAddressLower}`;
        const tokenPrice =
          toFiniteNumber(reserve?.size?.usdPerToken) ??
          toFiniteNumber(reserve?.usdExchangeRate) ??
          undefined;
        const reserveSizeUsd = toFiniteNumber(reserve?.size?.usd) ?? undefined;
        const utilizationRaw = toFiniteNumber(reserve?.borrowInfo?.utilizationRate?.value);
        const utilizationPct =
          utilizationRaw !== null && utilizationRaw >= 0 ? utilizationRaw * 100 : undefined;
        const aTokenAddress = reserve.aToken?.address ?? null;
        const vTokenAddress = reserve.vToken?.address ?? null;
        
        // 检查 supply 是否被禁用：isFrozen、isPaused、supplyCap=1
        const isFrozen = reserve.isFrozen === true;
        const isPaused = reserve.isPaused === true;
        const supplyCapValue = reserve.supplyInfo?.supplyCap?.amount?.value;
        const supplyCapIsOne = supplyCapValue !== undefined && parseFloat(supplyCapValue) === 1;
        const isSupplyDisabled = isFrozen || isPaused || supplyCapIsOne;
        
        // 提取 supplyCapUsd（单位：USD）
        const supplyCapUsdRaw = reserve.supplyInfo?.supplyCap?.usd;
        const supplyCapUsd = supplyCapUsdRaw ? parseFloat(supplyCapUsdRaw) : undefined;
        
        // 使用 value*100 转换为百分比值，不使用 formatted（会截断精度）
        const supplyApyValue = reserve.supplyInfo?.apy?.value;
        const supplyApy = supplyCapIsOne || !supplyApyValue
          ? undefined
          : parseFloat(supplyApyValue) * 100;
        
        // 检查 borrowingState 是否为 "DISABLED"，如果是则表示该 token 不能被 borrow
        const isBorrowDisabledByState = reserve.borrowInfo?.borrowingState === "DISABLED";
        
        // 检查 borrowCap，如果为 1 也视为 disabled（因为对用户没有实际意义）
        const borrowCapValue = reserve.borrowInfo?.borrowCap?.amount?.value;
        const borrowCapIsOne = borrowCapValue !== undefined && parseFloat(borrowCapValue) === 1;
        const isBorrowDisabled = isBorrowDisabledByState || borrowCapIsOne;
        
        // 提取 borrowCapUsd（单位：USD），与 supplyCapUsd 对称
        const borrowCapUsdRaw = reserve.borrowInfo?.borrowCap?.usd;
        const borrowCapUsd = borrowCapUsdRaw ? parseFloat(borrowCapUsdRaw) : undefined;
        
        // 使用 value*100 转换为百分比值，不使用 formatted（会截断精度）
        // 即使 disabled 也传递真实的 borrowApy（前端可能需要展示参考值）
        const borrowApyValue = reserve.borrowInfo?.apy?.value;
        const borrowApy = borrowApyValue ? parseFloat(borrowApyValue) * 100 : undefined;
        
        // Rate-input fields for manual APR calculation (from Aave SDK)
        // All raw values are strings to preserve precision for on-chain math
        const decimals = reserve.underlyingToken?.decimals ?? undefined;
        const availableLiquidity = reserve.borrowInfo?.availableLiquidity?.amount?.raw ?? undefined;
        // Aave API returns actual debt (not scaled), use RAY index workaround
        const totalScaledVariableDebt = reserve.borrowInfo?.total?.amount?.raw ?? undefined;
        const variableBorrowIndex = totalScaledVariableDebt ? '1000000000000000000000000000' : undefined; // RAY (1e27)
        const reserveFactorRaw = reserve.borrowInfo?.reserveFactor?.raw ?? undefined;
        const variableRateSlope1 = reserve.borrowInfo?.variableRateSlope1?.raw ?? undefined;
        const variableRateSlope2 = reserve.borrowInfo?.variableRateSlope2?.raw ?? undefined;
        const optimalUsageRate = reserve.borrowInfo?.optimalUsageRate?.raw ?? undefined;
        // baseVariableBorrowRate is NOT available from Aave API - would need on-chain fetch
        
        // 从 reserve.incentives 中提取 protocol supply 和 borrow incentives
        // 使用 value*100 转换为百分比值数组
        const protocolSupplyIncentives: number[] = [];
        const protocolBorrowIncentives: number[] = [];
        
        if (reserve.incentives && Array.isArray(reserve.incentives)) {
          reserve.incentives.forEach((incentive: any) => {
            if (incentive.__typename === 'AaveSupplyIncentive') {
              const aprValue = incentive.extraSupplyApr?.value || incentive.supplyApr?.value;
              if (aprValue) {
                protocolSupplyIncentives.push(parseFloat(aprValue) * 100);
              }
            } else if (incentive.__typename === 'AaveBorrowIncentive') {
              // AaveBorrowIncentive 可能使用 extraBorrowApr 或其他字段名
              const aprValue = incentive.extraBorrowApr?.value || incentive.borrowApr?.value;
              if (aprValue) {
                protocolBorrowIncentives.push(parseFloat(aprValue) * 100);
              }
            }
          });
        }
        
        // 创建完整的结构化数据，包含所有激励字段
        // 空值初始化为 undefined，以便在 JSON 序列化时省略
        baseDataset.push({
          reserveId,
          marketName,
          chainName,
          chainId,
          tokenName: reserve.underlyingToken?.name || 'Unknown',
          tokenSymbol,
          tokenAddress,
          tokenPrice,
          reserveSizeUsd,
          utilizationPct,
          aTokenAddress,
          vTokenAddress,
          supplyApy,
          // 仅当 supply 被禁用时才添加此标志（节约带宽）
          ...(isSupplyDisabled ? { supplyDisabled: true } : {}),
          // supplyCapUsd 始终传递（如果有值）
          ...(supplyCapUsd !== undefined ? { supplyCapUsd } : {}),
          borrowApy,
          // 仅当 borrowing 被禁用时才添加此标志（节约带宽）
          ...(isBorrowDisabled ? { borrowDisabled: true } : {}),
          // borrowCapUsd 始终传递（如果有值），与 supplyCapUsd 对称
          ...(borrowCapUsd !== undefined ? { borrowCapUsd } : {}),
          // Protocol incentives - 从 reserve.incentives 提取
          supplyIncentives: protocolSupplyIncentives.length > 0 ? protocolSupplyIncentives : undefined as any,
          borrowIncentives: protocolBorrowIncentives.length > 0 ? protocolBorrowIncentives : undefined as any,
          // Rate-input fields for manual APR calculation (raw strings for precision)
          ...(decimals !== undefined ? { decimals } : {}),
          ...(availableLiquidity ? { availableLiquidity } : {}),
          ...(totalScaledVariableDebt ? { totalScaledVariableDebt } : {}),
          ...(variableBorrowIndex ? { variableBorrowIndex } : {}),
          ...(reserveFactorRaw ? { reserveFactor: reserveFactorRaw } : {}),
          ...(variableRateSlope1 ? { variableRateSlope1 } : {}),
          ...(variableRateSlope2 ? { variableRateSlope2 } : {}),
          ...(optimalUsageRate ? { optimalUsageRate } : {}),
        });
      });
    }
  });

  return baseDataset;
}

// 将 Merit、Merkl 和 Brevis 激励数据填充到基础数据集中
// 类型别名：用于数据索引
type MeritDataIndex = Record<string, MeritDataItem>;
type MerklDataIndex = Record<string, MerklOpportunityData[]>;
type BrevisDataIndex = Record<string, BrevisDataItem>;
type MerklProcessedData = { index: MerklDataIndex };

function enrichDatasetWithIncentiveData(
  baseDataset: FormattedReserveData[],
  meritData: MeritDataIndex,
  merklData: MerklDataIndex,
  brevisData: BrevisDataIndex
): FormattedReserveData[] {
  return baseDataset.map(item => {
    const meritItemData = getMeritDataFromMarket(item.marketName, item.chainName, item.tokenSymbol, meritData);
    
    // 如果有 Merit 数据，直接更新对应字段
    if (meritItemData) {
      // 只有当数组不为空时才赋值，否则保持 undefined
      item.meritSupplys = meritItemData.meritSupplys.length > 0 ? meritItemData.meritSupplys : undefined;
      item.meritBorrows = meritItemData.meritBorrows.length > 0 ? meritItemData.meritBorrows : undefined;
    }
    
    // 获取对应的 Merkl 数据并更新
    const matchedOpportunities = findMatchingMerklOpportunities(item, merklData);
    
    if (matchedOpportunities.length > 0) {
      // 用于 CSV 格式化的平铺 breakdowns（带 opportunityLink 以保持对应关系）
      const supplyBreakdowns: MerklCampaignBreakdown[] = [];
      const borrowBreakdowns: MerklCampaignBreakdown[] = [];
      const holdBreakdowns: MerklCampaignBreakdown[] = [];
      
      // 用于 JSON 的分组数据（按 opportunity 分组，避免重复）
      const supplyOpportunities: MerklOpportunityGroup[] = [];
      const borrowOpportunities: MerklOpportunityGroup[] = [];
      const holdOpportunities: MerklOpportunityGroup[] = [];
      
      // 收集所有 matchedOpportunities 中的 breakdowns
      for (const opp of matchedOpportunities) {
        if (opp.opportunityLink) {
          if (opp.supply.length > 0) {
            // 为 CSV 格式化：添加 opportunityLink（临时用于格式化）
            const supplyWithLinks = opp.supply.map(b => ({ ...b, opportunityLink: opp.opportunityLink }));
            supplyBreakdowns.push(...supplyWithLinks);
            // 为 JSON：按 opportunity 分组（不包含 link 在 breakdown 中）
            supplyOpportunities.push({
              link: opp.opportunityLink || '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              breakdowns: opp.supply
            });
          }
          if (opp.borrow.length > 0) {
            const borrowWithLinks = opp.borrow.map(b => ({ ...b, opportunityLink: opp.opportunityLink }));
            borrowBreakdowns.push(...borrowWithLinks);
            borrowOpportunities.push({
              link: opp.opportunityLink || '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              breakdowns: opp.borrow
            });
          }
          if (opp.hold.length > 0) {
            const holdWithLinks = opp.hold.map(b => ({ ...b, opportunityLink: opp.opportunityLink }));
            holdBreakdowns.push(...holdWithLinks);
            holdOpportunities.push({
              link: opp.opportunityLink || '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              breakdowns: opp.hold
            });
          }
        } else {
          // 如果没有链接，直接添加 breakdowns
          if (opp.supply.length > 0) {
            supplyBreakdowns.push(...opp.supply);
            supplyOpportunities.push({
              link: '', // 空链接，但保持结构一致
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              breakdowns: opp.supply
            });
          }
          if (opp.borrow.length > 0) {
            borrowBreakdowns.push(...opp.borrow);
            borrowOpportunities.push({
              link: '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              breakdowns: opp.borrow
            });
          }
          if (opp.hold.length > 0) {
            holdBreakdowns.push(...opp.hold);
            holdOpportunities.push({
              link: '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              breakdowns: opp.hold
            });
          }
        }
      }
      
      // 用于 JSON：按 opportunity 分组的数据（避免重复，结构清晰）
      if (supplyOpportunities.length > 0) {
        item.merklSupplys = supplyOpportunities;
      }
      if (borrowOpportunities.length > 0) {
        item.merklBorrows = borrowOpportunities;
      }
      if (holdOpportunities.length > 0) {
        item.merklHolds = holdOpportunities;
      }
    }
    
    // 获取对应的 Brevis 数据并更新
    // 尝试通过 chainId + tokenAddress 匹配
    let brevisInfo: BrevisDataItem | undefined;
    
    if (item.tokenAddress) {
      const tokenKey = `${item.chainId}-${item.tokenAddress.toLowerCase()}`;
      brevisInfo = brevisData[tokenKey];
    }
    
    if (brevisInfo) {
      // 只有当数组不为空时才赋值
      if (brevisInfo.brevisSupplys.length > 0) {
        item.brevisSupplys = brevisInfo.brevisSupplys;
      }
      if (brevisInfo.brevisBorrows.length > 0) {
        item.brevisBorrows = brevisInfo.brevisBorrows;
      }
    }
    
    return item;
  });
}


/* Token 别名映射表：不同渠道可能使用不同名称指向同一个 token
const tokenAliases: Record<string, string[]> = {
  //'usdt': ['usd₮', 'usdt0', 'usd₮0'],
  //'usdc': ['usdce', 'usdc.e'],
  //'btcb': ['btc.b'],
  //'wbtc': ['wbtc.e'],
  'weth': ['eth'],  // eth 统一归一化为 weth
  'gho': ['sgho']
};*/


function generateCSV(data: FormattedReserveData[]): string {
  if (data.length === 0) return '';

  // CSV 头部
  const headers = [
    'Market Name',
    'Chain Name', 
    'Chain ID',
    'Token Name',
    'Token Symbol',
    'Token Address',
    'Supply APY (%)',
    'Borrow APY (%)',
    'Supply Incentives (%)',
    'Borrow Incentives (%)',
    'Merit Supplys',
    'Merit Borrows',
    'Merkl Supplys',
    'Merkl Borrows',
    'Merkl Holds',
    'Brevis Supplys',
    'Brevis Borrows'
  ];

  // 生成 CSV 行
  const csvRows = [
    headers.join(','),
    ...data.map(row => [
      `"${row.marketName}"`,
      `"${row.chainName}"`,
      row.chainId.toString(),
      `"${row.tokenName}"`,
      `"${row.tokenSymbol}"`,
      `"${row.tokenAddress}"`,
      row.supplyApy !== undefined ? row.supplyApy.toString() : '',
      row.borrowApy !== undefined ? row.borrowApy.toString() : '',
      (row.supplyIncentives && row.supplyIncentives.length > 0) ? `"${row.supplyIncentives.join(';')}"` : '',
      (row.borrowIncentives && row.borrowIncentives.length > 0) ? `"${row.borrowIncentives.join(';')}"` : '',
      // 格式化 meritSupplys：平铺所有数据，格式为 "APR1:selfApr1:link1:startDate1:endDate1:startBlock1:endBlock1:name1:message1;APR2:..."
      // message 格式为 "action1|description1;action2|description2"（多条用分号分隔，action和description用竖线分隔）
      (row.meritSupplys && row.meritSupplys.length > 0) 
        ? `"${row.meritSupplys.map(e => {
            const parts = [e.apr.toString()];
            if (e.selfApr !== undefined) parts.push(e.selfApr.toString());
            parts.push(e.link, e.startDate, e.endDate);
            if (e.startBlock) parts.push(e.startBlock);
            if (e.endBlock) parts.push(e.endBlock);
            if (e.name) parts.push(e.name);
            if (e.message && e.message.length > 0) {
              const messageStr = e.message.map(m => `${m.action || ''}|${m.description || ''}`).join(';');
              parts.push(messageStr);
            }
            if (e.requiredBorrowTokens) parts.push(`req:${e.requiredBorrowTokens.join(',')}`);
            return parts.join(':');
          }).join(';')}"` 
        : '',
      // 格式化 meritBorrows：平铺所有数据，格式同上
      (row.meritBorrows && row.meritBorrows.length > 0) 
        ? `"${row.meritBorrows.map(e => {
            const parts = [e.apr.toString()];
            if (e.selfApr !== undefined) parts.push(e.selfApr.toString());
            parts.push(e.link, e.startDate, e.endDate);
            if (e.startBlock) parts.push(e.startBlock);
            if (e.endBlock) parts.push(e.endBlock);
            if (e.name) parts.push(e.name);
            if (e.message && e.message.length > 0) {
              const messageStr = e.message.map(m => `${m.action || ''}|${m.description || ''}`).join(';');
              parts.push(messageStr);
            }
            if (e.requiredSupplyTokens) parts.push(`req:${e.requiredSupplyTokens.join(',')}`);
            return parts.join(':');
          }).join(';')}"` 
        : '',
      // 格式化 Merkl Supplys：包含 name 和 message
      (row.merklSupplys && row.merklSupplys.length > 0)
        ? `"${row.merklSupplys.map(g => {
            const parts: string[] = [];
            // 添加 name 和 message（如果有）
            if (g.name) parts.push(`name:${g.name}`);
            if (g.message) parts.push(`msg:${g.message}`);
            // 添加 breakdowns（格式化为字符串）
            const breakdownStr = formatMerklBreakdown(
              g.breakdowns.map(b => ({ ...b, opportunityLink: g.link }))
            );
            if (breakdownStr) parts.push(`breakdowns:${breakdownStr}`);
            // 添加 link
            parts.push(`link:${g.link}`);
            return parts.join('|');
          }).join(';')}"`
        : '',
      // 格式化 Merkl Borrows：包含 name 和 message
      (row.merklBorrows && row.merklBorrows.length > 0)
        ? `"${row.merklBorrows.map(g => {
            const parts: string[] = [];
            if (g.name) parts.push(`name:${g.name}`);
            if (g.message) parts.push(`msg:${g.message}`);
            const breakdownStr = formatMerklBreakdown(
              g.breakdowns.map(b => ({ ...b, opportunityLink: g.link }))
            );
            if (breakdownStr) parts.push(`breakdowns:${breakdownStr}`);
            parts.push(`link:${g.link}`);
            return parts.join('|');
          }).join(';')}"`
        : '',
      // 格式化 Merkl Holds：包含 name 和 message
      (row.merklHolds && row.merklHolds.length > 0)
        ? `"${row.merklHolds.map(g => {
            const parts: string[] = [];
            if (g.name) parts.push(`name:${g.name}`);
            if (g.message) parts.push(`msg:${g.message}`);
            const breakdownStr = formatMerklBreakdown(
              g.breakdowns.map(b => ({ ...b, opportunityLink: g.link }))
            );
            if (breakdownStr) parts.push(`breakdowns:${breakdownStr}`);
            parts.push(`link:${g.link}`);
            return parts.join('|');
          }).join(';')}"`
        : '',
      // Brevis Supplys：格式为 "APR1:link1:startDate1:endDate1:name1;APR2:link2:startDate2:endDate2:name2"
      (row.brevisSupplys && row.brevisSupplys.length > 0) 
        ? `"${row.brevisSupplys.map(c => {
            const parts = [c.apr.toString(), c.link, c.startDate, c.endDate, c.name || ''];
            return parts.join(':');
          }).join(';')}"` 
        : '',
      // Brevis Borrows：格式同上
      (row.brevisBorrows && row.brevisBorrows.length > 0) 
        ? `"${row.brevisBorrows.map(c => {
            const parts = [c.apr.toString(), c.link, c.startDate, c.endDate, c.name || ''];
            return parts.join(':');
          }).join(';')}"` 
        : ''
    ].join(','))
  ];

  return csvRows.join('\n');
}

// 从所有链获取 Aave 市场数据
async function fetchAaveMarketData(): Promise<MarketData> {
  logger.info('🔄 Fetching Aave markets data from all networks...');
  
  // 获取所有 AaveV3 网络信息
  const networkInfo = await getAllAaveV3Networks();
  const chainIds = [...new Set(networkInfo.map(info => info.chainId))]; // 去重
  
  logger.info(`🌐 Found ${networkInfo.length} AaveV3 networks across ${chainIds.length} unique chains`);
  logger.info('📋 Networks:');
  networkInfo.forEach(info => {
    logger.info(`   • ${info.name} (Chain ID: ${info.chainId})`);
  });
  
  logger.info('\n🚀 Fetching markets data...');
  
  let marketList: any[] = [];
  let supportedChainIds: number[] = [];
  let errors: string[] = [];
  
  // 逐个尝试每个链ID，获取marketList和supportedChainIds
  for (const chainIdValue of chainIds) {
    let retries = 3;
    let lastError: any = null;
    
    while (retries > 0) {
      try {
        logger.debug(`   Trying Chain ID: ${chainIdValue} (${4 - retries}/3 attempts)`);
        const result = await markets(client, {
          chainIds: [chainId(chainIdValue)],
        });
      
      // @aave/client 使用 Result<T, E> 模式，需要检查 isOk() 或 isErr()
      if (result && typeof result === 'object' && 'isErr' in result && typeof result.isErr === 'function') {
        if (result.isErr()) {
          const errorInfo = result.error;
          const errorMsg = `Chain ${chainIdValue}: ${errorInfo.name || 'UnknownError'}${errorInfo.message ? ` - ${errorInfo.message}` : ''}`;
          lastError = new Error(errorMsg);
          retries--;
          
          if (retries > 0) {
            const delayMs = 2000 * (4 - retries); // 递增延迟：2s, 4s, 6s
            logger.warn(`   ⚠️ Chain ${chainIdValue}: API error, retrying in ${delayMs}ms... (${errorMsg})`);
            if (errorInfo.stack) {
              logger.debug(`   Chain ${chainIdValue} error stack: ${errorInfo.stack}`);
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
            continue; // 继续重试
          } else {
            errors.push(errorMsg);
            logger.error(`   ❌ ${errorMsg}`);
            if (errorInfo.stack) {
              logger.debug(`   Chain ${chainIdValue} error stack: ${errorInfo.stack}`);
            }
            break; // 重试次数用完，跳出循环
          }
        }
        
        // 成功的情况，使用 result.value
        if (result.value && Array.isArray(result.value) && result.value.length > 0) {
          marketList.push(...result.value);
          supportedChainIds.push(chainIdValue);
          logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.value.length} markets`);
          break; // 成功获取数据，跳出重试循环
        } else {
          logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found (result.value is empty or undefined)`);
          break; // 虽然没有数据，但不是错误，不需要重试
        }
      } else if (result && typeof result === 'object' && 'value' in result) {
        // 兼容旧的返回格式
        if (result.value && Array.isArray(result.value) && result.value.length > 0) {
          marketList.push(...result.value);
          supportedChainIds.push(chainIdValue);
          logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.value.length} markets`);
          break; // 成功获取数据，跳出重试循环
        } else {
          logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found (result.value is empty array or undefined)`);
          break; // 虽然没有数据，但不是错误，不需要重试
        }
      } else if (result && Array.isArray(result) && result.length > 0) {
        // 直接返回数组的情况
        marketList.push(...result);
        supportedChainIds.push(chainIdValue);
        logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.length} markets`);
        break; // 成功获取数据，跳出重试循环
      } else {
        logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found (unexpected result format: ${JSON.stringify(result).substring(0, 200)})`);
        break; // 虽然没有数据，但不是错误，不需要重试
      }
      } catch (error) {
        lastError = error;
        retries--;
        
        if (retries > 0) {
          const delayMs = 2000 * (4 - retries); // 递增延迟：2s, 4s, 6s
          logger.warn(`   ⚠️ Chain ${chainIdValue}: Attempt failed, retrying in ${delayMs}ms... (${error instanceof Error ? error.message : String(error)})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          const errorMsg = `Chain ${chainIdValue}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(errorMsg);
          logger.error(`   ❌ Chain ${chainIdValue}: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof Error && error.stack) {
            logger.debug(`   Chain ${chainIdValue} error stack: ${error.stack}`);
          }
        }
      }
    }
  }
  
  const marketData: MarketData = {
    timestamp: new Date().toISOString(),
    totalNetworks: networkInfo.length,
    chainIds: supportedChainIds,
    networkInfo: networkInfo.filter(info => supportedChainIds.includes(info.chainId)),
    markets: marketList,
    errors: errors,
  };

  logger.info(`\n✅ Successfully fetched markets data`);
  logger.info(`📊 Found ${marketList.length} markets total from ${supportedChainIds.length} chains`);
  
  if (errors.length > 0) {
    logger.warn(`⚠️ ${errors.length} chains had errors or no data`);
  }

  // 确保 data 文件夹存在
  await mkdir(DEBUG_DATA_DIR, { recursive: true });
  
  // 保存原始数据到JSON文件
  const outputPath = join(DEBUG_DATA_DIR, 'aave-all-markets-data.json');
  await writeJsonAtomic(outputPath, marketData);
  
  return marketData;
}

async function fetchAaveMarkets(): Promise<void> {
  // 🧹 启动时检查并清理 Cloudflare browser sessions
  // 这是为了避免之前程序异常退出后残留的 session 占用配额
  logger.info('🔧 Pre-flight check: Cloudflare browser session status...');
  await checkAndReportSessionStatus();

  // 如果环境变量 CLOSE_BROWSERS_ON_START 设置为 true，则关闭所有现有浏览器实例
  // 注意：这会关闭浏览器实例释放配额，不是清理 session。Session 应该尽量复用。
  if (process.env.CLOSE_BROWSERS_ON_START === 'true') {
    logger.info('🔌 CLOSE_BROWSERS_ON_START=true, closing existing browser instances...');
    await closeBrowserInstances();
    // 关闭后等待一段时间，让 Cloudflare 有时间释放资源
    logger.info('⏳ Waiting 30s after closing browsers for Cloudflare to release resources...');
    await new Promise(resolve => setTimeout(resolve, 30000));
  }

  try {
    // 从所有链获取市场数据（已包含保存原始数据到文件）
    const marketData = await fetchAaveMarketData();
    
    // 格式化数据并保存到新文件
    logger.info('\n📊 Formatting market data...');
    
    // 第一步：从 Aave 市场数据创建基础数据集
    logger.info('📊 Creating base dataset from Aave markets...');
    const baseDataset = createBaseDatasetFromMarkets(marketData.markets);
    logger.info(`✅ Created base dataset with ${baseDataset.length} token combinations`);

    // 并发获取 Merit、Merkl 和 Brevis 数据（它们之间没有依赖关系）
    // 注意：程序是定期触发的，设置超时避免某个任务卡住导致所有数据被卡住
    // 超时时间设置较长（10分钟），因为大多数时候数据有缓存，等一等没关系
    logger.info('🚀 Starting incentive data fetching concurrently (Merit, Merkl, Brevis running simultaneously)...');
    
    // 同时启动三个任务（并发执行）
    const meritPromise = fetchMeritData().catch((error) => {
      logger.error(`❌ Merit data fetching failed: ${error instanceof Error ? error.message : String(error)}`);
      return {} as MeritDataIndex;
    });
    const merklPromise = processMerklData().catch((error) => {
      logger.error(`❌ Merkl data fetching failed: ${error instanceof Error ? error.message : String(error)}`);
      return { index: {} as MerklDataIndex } as MerklProcessedData;
    });
    const brevisPromise = fetchBrevisAprs(baseDataset).catch((error) => {
      logger.error(`❌ Brevis data fetching failed: ${error instanceof Error ? error.message : String(error)}`);
      return {} as BrevisDataIndex;
    });
    
    // 设置超时时间（10分钟），避免某个任务卡住导致所有数据被卡住
    // 超时时间较长，因为大多数时候数据有缓存，网络问题等一等没关系
    const INCENTIVE_DATA_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
    
    // 创建一个包装函数，用于在超时后提取已完成的结果
    const getCompletedResults = async (): Promise<{ merit: MeritDataIndex; merkl: MerklDataIndex; brevis: BrevisDataIndex }> => {
      // 等待所有任务完成或超时
      const results = await Promise.allSettled([meritPromise, merklPromise, brevisPromise]);
      
      const meritData: MeritDataIndex = results[0].status === 'fulfilled' ? results[0].value : {};
      const merklResult: MerklProcessedData =
        results[1].status === 'fulfilled'
          ? (results[1].value as MerklProcessedData)
          : { index: {} as MerklDataIndex };
      const merklData: MerklDataIndex = merklResult.index;
      const brevisData: BrevisDataIndex = results[2].status === 'fulfilled' ? results[2].value : {};
      
      if (results[0].status === 'rejected') {
        logger.warn(`⚠️ Merit data fetching was rejected, using empty data`);
      }
      if (results[1].status === 'rejected') {
        logger.warn(`⚠️ Merkl data fetching was rejected, using empty data`);
      }
      if (results[2].status === 'rejected') {
        logger.warn(`⚠️ Brevis data fetching was rejected, using empty data`);
      }
      
      return { merit: meritData, merkl: merklData, brevis: brevisData };
    };
    
    // 创建超时 Promise（带取消功能）
    let timeoutId: NodeJS.Timeout | null = null;
    let mainTaskCompleted = false;
    
    const timeoutPromise = new Promise<{ merit: MeritDataIndex; merkl: MerklDataIndex; brevis: BrevisDataIndex }>((resolve) => {
      timeoutId = setTimeout(async () => {
        // 如果主任务已完成，不输出警告
        if (mainTaskCompleted) return;
        
        logger.warn(`⏱️ Incentive data fetching timeout after ${INCENTIVE_DATA_TIMEOUT_MS / 1000}s, extracting completed results...`);
        
        // 使用一个很短的超时（100ms）来检查每个 Promise 是否已完成
        const checkCompleted = async <T>(promise: Promise<T>, defaultValue: T): Promise<{ completed: boolean; value: T }> => {
          try {
            const result = await Promise.race([
              promise.then(value => ({ completed: true, value })),
              new Promise<{ completed: false; value: T }>(resolve => 
                setTimeout(() => resolve({ completed: false, value: defaultValue }), 100)
              ),
            ]);
            return result;
          } catch {
            return { completed: false, value: defaultValue };
          }
        };
        
        const [meritCheck, merklCheck, brevisCheck] = await Promise.all([
          checkCompleted(meritPromise, {} as MeritDataIndex),
          checkCompleted(merklPromise, { index: {} as MerklDataIndex } as MerklProcessedData),
          checkCompleted(brevisPromise, {} as BrevisDataIndex),
        ]);
        
        const meritData: MeritDataIndex = meritCheck.completed ? meritCheck.value : {};
        const merklData: MerklDataIndex = merklCheck.completed ? merklCheck.value.index : {};
        const brevisData: BrevisDataIndex = brevisCheck.completed ? brevisCheck.value : {};
        
        logger.warn(`   • Merit: ${meritCheck.completed ? 'completed' : 'timeout/empty'}`);
        logger.warn(`   • Merkl: ${merklCheck.completed ? 'completed' : 'timeout/empty'}`);
        logger.warn(`   • Brevis: ${brevisCheck.completed ? 'completed' : 'timeout/empty'}`);
        logger.warn(`   • Using available results, unfinished tasks continue in background`);
        
        resolve({ merit: meritData, merkl: merklData, brevis: brevisData });
      }, INCENTIVE_DATA_TIMEOUT_MS);
    });
    
    // 使用 Promise.race，取先完成的（任务完成或超时）
    const { merit: meritData, merkl: merklData, brevis: brevisData } = await Promise.race([
      getCompletedResults().then(result => {
        mainTaskCompleted = true;
        if (timeoutId) clearTimeout(timeoutId);
        return result;
      }),
      timeoutPromise,
    ]);
    
    logger.info('✅ Using available incentive data (some tasks may still be running in background)');
    
    // 第二步：将 Merit、Merkl 和 Brevis 激励数据填充到基础数据集中
    logger.info('💾 Enriching dataset with incentive data (Merit, Merkl & Brevis)...');
    const enrichedData = enrichDatasetWithIncentiveData(baseDataset, meritData, merklData, brevisData);
    
    logger.info(`🎯 Final dataset contains ${enrichedData.length} token combinations`);
    
    // 保存格式化 JSON 数据（runtime 最小可用 + debug 全量）
    const formattedJsonPath = join(RUNTIME_DATA_DIR, 'aave-formatted-data.json');
    const debugFormattedJsonPath = join(DEBUG_DATA_DIR, 'aave-formatted-data.full.json');
    const runtimeData = enrichedData.map(pruneReserveForRuntime);
    const runtimePayload = {
      _metadata: {
        timestamp: marketData.timestamp,
        version: '2.0-runtime-minimal',
        dataCount: runtimeData.length,
        profile: 'runtime-minimal',
      },
      data: runtimeData,
    };
    const debugPayload = {
      _metadata: {
        timestamp: marketData.timestamp,
        version: '2.0-debug-full',
        dataCount: enrichedData.length,
        profile: 'debug-full',
      },
      data: enrichedData,
    };
    // Runtime: minimal JSON (no pretty-print) and omit null/undefined for smaller file.
    await writeJsonAtomic(formattedJsonPath, runtimePayload, {
      replacer: (key: string, value: unknown) =>
        value === null ? undefined : (value === undefined ? undefined : value),
      space: 0,
    });
    await writeJsonAtomic(debugFormattedJsonPath, debugPayload);

    // 生成CSV格式
    const csvData = generateCSV(enrichedData);
    await mkdir(EXPORT_DATA_DIR, { recursive: true });
    const csvPath = join(EXPORT_DATA_DIR, 'aave-formatted-data.csv');
    await writeFile(csvPath, csvData, 'utf-8');
    
    const outputPath = join(DEBUG_DATA_DIR, 'aave-all-markets-data.json');
    logger.info(`💾 Original data saved to ${outputPath}`);
    logger.info(`📊 Runtime minimal JSON saved to ${formattedJsonPath}`);
    logger.info(`🧪 Debug full JSON saved to ${debugFormattedJsonPath}`);
    logger.info(`📈 CSV data saved to ${csvPath}`);
    logger.info(`📁 Runtime data dir: ${RUNTIME_DATA_DIR}`);
    logger.info(`📁 Debug data dir: ${DEBUG_DATA_DIR}`);
    logger.info(`📁 Export data dir: ${EXPORT_DATA_DIR}`);
    logger.info(`📈 Total markets: ${marketData.markets.length}`);
    logger.info(`🪙 Total reserves: ${enrichedData.length}`);
    logger.info(`🌐 Networks discovered: ${marketData.totalNetworks}`);
    logger.info(`✅ Supported networks: ${marketData.networkInfo.length}`);
    logger.info(`⛓️ Supported chains: ${marketData.chainIds.length}`);
    if (marketData.errors.length > 0) {
      logger.warn(`❌ Failed chains: ${marketData.errors.length}`);
    }
  } catch (error) {
    logger.error('💥 Unexpected error:', error);
    
    const networkInfo = await getAllAaveV3Networks();
    const chainIds = [...new Set(networkInfo.map(info => info.chainId))];
    
    // 即使出错也保存错误信息到文件
    const errorData: MarketData = {
      timestamp: new Date().toISOString(),
      totalNetworks: networkInfo.length,
      chainIds: chainIds,
      networkInfo: networkInfo,
      markets: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
    
    try {
      // 确保 data 文件夹存在
      await mkdir(DEBUG_DATA_DIR, { recursive: true });
      const errorPath = join(DEBUG_DATA_DIR, 'aave-all-markets-error.json');
      await writeJsonAtomic(errorPath, errorData);
      logger.info(`💾 Error data saved to ${errorPath}`);
    } catch (writeError) {
      logger.error('❌ Failed to save error data:', writeError);
    }
  }
}

// 导出数据获取函数供 backend 内化使用（cron-write/API-read-only 模式）
// 返回内存中的 payload，不写文件
// ts-prune-ignore-next
export async function fetchMarketsPayload(): Promise<MarketsPayload> {
  // 🧹 启动时检查并清理 Cloudflare browser sessions
  logger.info('🔧 Pre-flight check: Cloudflare browser session status...');
  await checkAndReportSessionStatus();

  // 从所有链获取市场数据
  const marketData = await fetchAaveMarketData();
  
  // 格式化数据
  logger.info('\n📊 Formatting market data...');
  const baseDataset = createBaseDatasetFromMarkets(marketData.markets);
  logger.info(`✅ Created base dataset with ${baseDataset.length} token combinations`);

  // 并发获取 Merit、Merkl 和 Brevis 数据
  logger.info('🚀 Starting incentive data fetching concurrently...');
  
  const meritPromise = fetchMeritData().catch((error) => {
    logger.error(`❌ Merit data fetching failed: ${error instanceof Error ? error.message : String(error)}`);
    return {} as MeritDataIndex;
  });
  const merklPromise = processMerklData().catch((error) => {
    logger.error(`❌ Merkl data fetching failed: ${error instanceof Error ? error.message : String(error)}`);
    return { index: {} as MerklDataIndex } as MerklProcessedData;
  });
  const brevisPromise = fetchBrevisAprs(baseDataset).catch((error) => {
    logger.error(`❌ Brevis data fetching failed: ${error instanceof Error ? error.message : String(error)}`);
    return {} as BrevisDataIndex;
  });

  const results = await Promise.allSettled([meritPromise, merklPromise, brevisPromise]);
  
  const meritData: MeritDataIndex = results[0].status === 'fulfilled' ? results[0].value : {};
  const merklResult: MerklProcessedData =
    results[1].status === 'fulfilled'
      ? (results[1].value as MerklProcessedData)
      : { index: {} as MerklDataIndex };
  const merklData: MerklDataIndex = merklResult.index;
  const brevisData: BrevisDataIndex = results[2].status === 'fulfilled' ? results[2].value : {};

  // Enrich with incentive data
  logger.info('💾 Enriching dataset with incentive data (Merit, Merkl & Brevis)...');
  const enrichedData = enrichDatasetWithIncentiveData(baseDataset, meritData, merklData, brevisData);
  const runtimeData = enrichedData.map(pruneReserveForRuntime);

  logger.info(`🎯 Final dataset contains ${runtimeData.length} reserves`);

  return {
    _metadata: {
      timestamp: marketData.timestamp,
      version: '2.0-runtime-minimal',
      dataCount: runtimeData.length,
      profile: 'runtime-minimal',
    },
    data: runtimeData,
  };
}

// 导出主函数,以便其他模块可以调用（backend 通过 dist 引用）
// ts-prune-ignore-next
export async function fetchAaveMarketsData(): Promise<void> {
  return fetchAaveMarkets();
}

// 只有当这个文件作为主模块直接运行时，才执行以下代码
// 这样可以避免在作为模块被导入时执行 process.exit()
// 检查逻辑：
// 1. 如果 process.argv[1] 包含 'server'，说明是从 backend server 运行的，不应该执行
// 2. 如果当前文件路径在 dist 目录下，说明是被编译后导入的，不应该执行
// 3. 否则，说明是直接运行这个文件（npm run dev 在根目录），应该执行
const mainScript = process.argv[1] || '';
const currentFile = fileURLToPath(import.meta.url);
const isMainModule = !mainScript.includes('server') && 
                     !currentFile.includes('/dist/') &&
                     !currentFile.includes('\\dist\\');

if (isMainModule) {
  // 执行主函数（仅当作为独立脚本运行时）
  fetchAaveMarkets().catch(error => {
  logger.error('❌ Failed to fetch Aave markets:', error);
  process.exit(1);
}).then(async () => {
  // 关闭 Puppeteer 浏览器实例并 flush aliases
  const { closeBrowser, flushMeritKeyAliases } = await import('./merit-api.js');
  await flushMeritKeyAliases().catch(() => {});
  await closeBrowser().catch((err) => {
    logger.warn('⚠️ Error when closing browser:', err);
  });
  process.exit(0);
}).catch(async (error) => {
  const { closeBrowser, flushMeritKeyAliases } = await import('./merit-api.js');
  await flushMeritKeyAliases().catch(() => {});
  await closeBrowser().catch(() => {});
  process.exit(1);
  });
}
