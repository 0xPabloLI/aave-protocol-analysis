import { writeFile, mkdir } from 'fs/promises';
import { chainId, AaveClient, ChainsFilter } from "@aave/client";
import { markets, chains } from "@aave/client/actions";
import * as addressBook from "@aave-dao/aave-address-book";

const client = AaveClient.create();
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { writeJsonAtomic } from './file-utils.js';
import { brevisApi, pruneBrevisCampaignForRuntime } from './brevis-api.js';
import { resolveUsdPriceWithPriority } from './token-price-resolver.js';
import { toFiniteNumber, percentValueToPercent } from './utils/number.js';
import {
  MerklCampaignBreakdown,
  MerklOpportunityData,
  MerklOpportunityGroup,
  processMerklData,
  findMatchingMerklOpportunities,
  formatMerklBreakdown,
  detectNetPositionConstraint,
  type NetPositionConstraint,
} from './merkl-api.js';
import { buildLlmPrompt, callLlmWithFallback } from './merklLlmClient.js';
import type { LlmClientConfig } from './merklLlmClient.js';
import {
  MeritDataItem,
  MeritAprEntry,
  fetchMeritData,
  getMeritDataFromMarket
} from './merit-api.js';
import type { BrevisCampaignBreakdown, BrevisCampaignItem, BrevisDataItem } from './brevis-api.js';
import { pruneMeritEntry, pruneMerklGroup, pruneBrevisItem } from './incentive-prune.js';
import {
  checkAndReportSessionStatus,
  closeBrowserInstances
} from './cloudflare-browser.js';
import { fetchV4ReservesData, bigintReplacer } from './v4-fetcher.js';
import type { V4FetchResult } from './v4-fetcher.js';
import type { RuntimeReserveData, MarketsPayload } from '@internal/aave-shared-contracts';
export type { RuntimeReserveData, MarketsPayload } from '@internal/aave-shared-contracts';
export type {
  MerklCampaignBreakdown,
  MerklOpportunityGroup,
} from '@internal/aave-shared-contracts';
export type {
  BrevisCampaignBreakdown,
  BrevisCampaignItem,
} from '@internal/aave-shared-contracts';
export type { MeritAprEntry } from '@internal/aave-shared-contracts';

export function getDataDir(): string {
  return process.env.FETCHER_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
}

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

const DATA_DIR = getDataDir();
const RUNTIME_DATA_DIR = join(DATA_DIR, 'runtime');
const DEBUG_DATA_DIR = join(DATA_DIR, 'debug');
const EXPORT_DATA_DIR = join(DATA_DIR, 'exports');

function buildChainTokenIndex(baseDataset: RuntimeReserveData[]): Record<string, Set<string>> {
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
  baseDataset: RuntimeReserveData[]
): Promise<BrevisDataIndex> {
  try {
    logger.info('🌐 Fetching Brevis Incentra Aave campaign data...');
    
    // 获取所有 Aave campaign 数据（包含原始响应数据）
    const brevisResult = await brevisApi.getAaveCampaignsData();
    const brevisIndex: BrevisDataIndex = brevisResult.index;

    // 用于 reward token 价格解析：优先后端快照 tokenPrice，缺失时再走 CoinGecko fallback。
    const tokenPriceByChainAndAddress = new Map<string, number>();
    baseDataset.forEach((reserve) => {
      const price = toFiniteNumber(reserve.tokenPrice);
      if (price === null) return;
      const address = reserve.tokenAddress?.toLowerCase();
      if (!address) return;
      tokenPriceByChainAndAddress.set(`${reserve.chainId}:${address}`, price);
    });

    const brevisPriceSourceStats = {
      snapshot: 0,
      reserve: 0,
      coingecko: 0,
      missing: 0,
    };

    for (const [indexKey, campaigns] of Object.entries(brevisIndex)) {
      const dashIdx = indexKey.indexOf('-');
      if (dashIdx <= 0) continue;
      const chainId = Number(indexKey.slice(0, dashIdx));
      const rewardTokenAddress = indexKey.slice(dashIdx + 1).toLowerCase();
      if (!Number.isFinite(chainId) || !rewardTokenAddress) continue;

      const enrichCampaignUsd = async (campaign: BrevisCampaignItem): Promise<BrevisCampaignItem> => {
        const reservePriceKey = `${chainId}:${rewardTokenAddress}`;
        const reserveTokenPrice = tokenPriceByChainAndAddress.get(reservePriceKey);

        const breakdowns = await Promise.all(
          (campaign.breakdowns ?? []).map(async (breakdown) => {
            const normalizedAmount = toFiniteNumber(breakdown.budgetNormalizedAmount);
            if (normalizedAmount === null || normalizedAmount < 0) {
              return breakdown;
            }

            const resolved = await resolveUsdPriceWithPriority({
              chainId,
              tokenAddress: rewardTokenAddress,
              tokenSymbol: breakdown.budgetTokenSymbol,
              snapshotPrice: undefined,
              reservePrice: reserveTokenPrice,
            });
            brevisPriceSourceStats[resolved.source] += 1;

            if (resolved.price !== undefined) {
              return {
                ...breakdown,
                totalBudget: normalizedAmount * resolved.price,
              };
            }

            return breakdown;
          })
        );

        return pruneBrevisCampaignForRuntime({
          ...campaign,
          breakdowns,
        });
      };

      campaigns.brevisSupplys = await Promise.all(campaigns.brevisSupplys.map((c) => enrichCampaignUsd(c)));
      campaigns.brevisBorrows = await Promise.all(campaigns.brevisBorrows.map((c) => enrichCampaignUsd(c)));
    }
    
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
    logger.info(
      `   Price source usage (Brevis totalBudget): snapshot=${brevisPriceSourceStats.snapshot}, reserve=${brevisPriceSourceStats.reserve}, coingecko=${brevisPriceSourceStats.coingecko}, missing=${brevisPriceSourceStats.missing}`
    );
    
    return brevisIndex;
  } catch (error) {
    logger.error('❌ Error fetching Brevis APR data:', error);
    return {};
  }
}



/**
 * Build the base dataset from V3 markets + V4 reserves.
 * Shared by both backend (fetchMarketsData) and root (runMarketsFetcher).
 *
 * @param v3Markets - V3 market data from fetchRawMarketData()
 * @param options.v4Fatal - If true, V4 fetch failure is fatal (throws).
 *                           Makes V3 and V4 equally important — if either fails, the entire refresh fails.
 *                           Default: false (V4 failure is non-fatal, graceful degradation).
 */
async function buildMarketsBaseDataset(v3Markets: any[], options?: {
  v4Fatal?: boolean;
}): Promise<{
  baseDataset: RuntimeReserveData[];
  v3Count: number;
  v4Count: number;
  v4Dataset: RuntimeReserveData[];
  v4Raw: V4FetchResult['raw'];
}> {
  const v3Dataset = buildV3BaseDataset(v3Markets);
  let v4Dataset: RuntimeReserveData[] = [];
  let v4Raw: V4FetchResult['raw'] = { reserves: [] };
  const v4Fatal = options?.v4Fatal ?? false;
  // V4 fetch isolation: independent timeout prevents slow V4 API from
  // consuming the outer 60s Markets fetch timeout and blocking V3 data.
  const V4_FETCH_TIMEOUT_MS = 25_000;
  try {
    // Option 1: V4 now has retry logic (3 attempts with backoff), matching V3 reliability.
    // Option 2: When v4Fatal=true, V4 failure throws (equal importance to V3).
    const v4Result = await Promise.race([
      fetchV4ReservesData({ throwOnFinalFailure: v4Fatal }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('V4 fetch timeout (non-fatal)')), V4_FETCH_TIMEOUT_MS)
      ),
    ]);
    v4Dataset = v4Result.mapped;
    v4Raw = v4Result.raw;
    if (v4Dataset.length > 0) {
      logger.info(`✅ Fetched ${v4Dataset.length} V4 reserves`);
    } else if (v4Fatal) {
      // Option 2: Empty V4 dataset is fatal when v4Fatal=true
      throw new Error('V4 data fetch returned empty dataset (v4Fatal=true)');
    } else {
      logger.warn(`⚠️ V4 data fetch returned empty dataset after retries (non-fatal)`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (v4Fatal) {
      // Option 2: V4 failure is fatal — throw to make the entire refresh fail
      logger.error(`❌ V4 data fetching failed (FATAL — v4Fatal=true): ${errorMsg}`);
      throw new Error(`V4 data fetch failed (fatal): ${errorMsg}`);
    }
    logger.error(`❌ V4 data fetching failed (non-fatal): ${errorMsg}`);
  }
  const baseDataset = [...v3Dataset, ...v4Dataset];
  logger.info(`📊 Unified dataset: ${baseDataset.length} reserves (V3: ${v3Dataset.length}, V4: ${v4Dataset.length})`);
  return { baseDataset, v3Count: v3Dataset.length, v4Count: v4Dataset.length, v4Dataset, v4Raw };
}

// 从 Aave V3 市场数据创建基础数据集
function buildV3BaseDataset(markets: any[]): RuntimeReserveData[] {
  const baseDataset: RuntimeReserveData[] = [];

  markets.forEach(market => {
    const poolAddress = (market.address || '').toLowerCase();
    const marketName = market.name || 'Unknown';
    const chainName = market.chain?.name || 'Unknown';
    const chainId = market.chain?.chainId || 0;

    if (market.supplyReserves && Array.isArray(market.supplyReserves)) {
      market.supplyReserves.forEach((reserve: any) => {
        const tokenSymbol = reserve.underlyingToken?.symbol || 'Unknown';
        const tokenAddress = reserve.underlyingToken?.address || '';
        const tokenAddressLower = tokenAddress.toLowerCase();
        const reserveId = `${chainId}:${poolAddress}:${tokenAddressLower}`;
        const tokenPrice =
          toFiniteNumber(reserve?.size?.usdPerToken) ??
          toFiniteNumber(reserve?.usdExchangeRate) ??
          undefined;
        const utilizationRaw = toFiniteNumber(reserve?.borrowInfo?.utilizationRate?.value);
        const utilizationPct =
          utilizationRaw !== null && utilizationRaw >= 0 ? utilizationRaw * 100 : undefined;
        const aTokenAddress = reserve.aToken?.address ?? null;
        const vTokenAddress = reserve.vToken?.address ?? null;
        
        // 检查 supply 是否被禁用：supplyCap=1
        const isFrozen = reserve.isFrozen === true;
        const isPaused = reserve.isPaused === true;
        const hasProtocolReason = isPaused || isFrozen;
        const supplyCapValue = reserve.supplyInfo?.supplyCap?.amount?.value;
        const supplyCapIsOne = supplyCapValue !== undefined && toFiniteNumber(supplyCapValue) === 1;
        const isSupplyDisabled = hasProtocolReason ? false : supplyCapIsOne;
        
        const supplyApyValue = reserve.supplyInfo?.apy?.value;
        const supplyApy = supplyCapIsOne || !supplyApyValue
          ? undefined
          : toFiniteNumber(supplyApyValue) ?? undefined;
        
        // 检查 borrowingState 是否为 "DISABLED"，如果是则表示该 token 不能被 borrow
        // 注意：部分市场（如 AaveV3Ethereum）在 borrowingState=DISABLED 时 SDK 直接返回 borrowInfo: null，
        // 而不是返回 { borrowingState: "DISABLED" }，因此 borrowInfo 为 null 也视为 borrow disabled
        const isBorrowDisabledByState = reserve.borrowInfo?.borrowingState === "DISABLED" || reserve.borrowInfo === null;
        
        // 检查 borrowCap，如果为 1 也视为 disabled（因为对用户没有实际意义）
        const borrowCapValue = reserve.borrowInfo?.borrowCap?.amount?.value;
        const borrowCapIsOne = borrowCapValue !== undefined && toFiniteNumber(borrowCapValue) === 1;
        const isBorrowDisabled = hasProtocolReason ? false : (isBorrowDisabledByState || borrowCapIsOne);
        
        const borrowApyValue = reserve.borrowInfo?.apy?.value;
        const borrowApy = toFiniteNumber(borrowApyValue) ?? undefined;
        
        // Rate-input fields for manual APR calculation (from Aave SDK)
        // All raw values are strings to preserve precision for on-chain math
        const decimals = reserve.underlyingToken?.decimals ?? undefined;
        const liquidity = reserve.borrowInfo?.availableLiquidity?.amount?.raw ?? undefined;
        const borrowed = reserve.borrowInfo?.total?.amount?.raw ?? undefined; // Total borrowed
        const supplied = reserve.size?.amount?.raw ?? undefined;
        const supplyCap = reserve.supplyInfo?.supplyCap?.amount?.raw ?? undefined;
        const borrowCap = reserve.borrowInfo?.borrowCap?.amount?.raw ?? undefined;
        // Note: baseBorrowRate is NOT available from Aave API (filled by on-chain RPC or fallback)
        const protocolFee = percentValueToPercent(reserve.borrowInfo?.reserveFactor);
        const slopeBelowOptimal = percentValueToPercent(reserve.borrowInfo?.variableRateSlope1);
        const slopeAboveOptimal = percentValueToPercent(reserve.borrowInfo?.variableRateSlope2);
        const optimalUtilization = percentValueToPercent(reserve.borrowInfo?.optimalUsageRate);
        
        const protocolSupplyIncentives: number[] = [];
        const protocolBorrowIncentives: number[] = [];

        if (reserve.incentives && Array.isArray(reserve.incentives)) {
          reserve.incentives.forEach((incentive: any) => {
            if (incentive.__typename === 'AaveSupplyIncentive') {
              const aprValue = incentive.extraSupplyApr?.value || incentive.supplyApr?.value;
              const aprNum = toFiniteNumber(aprValue);
              if (aprNum !== null) {
                protocolSupplyIncentives.push(aprNum);
              }
            } else if (incentive.__typename === 'AaveBorrowIncentive') {
              const aprValue = incentive.extraBorrowApr?.value || incentive.borrowApr?.value;
              const aprNum = toFiniteNumber(aprValue);
              if (aprNum !== null) {
                protocolBorrowIncentives.push(aprNum);
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
          utilizationPct,
          aTokenAddress,
          vTokenAddress,
          supplyApy,
          // 仅当 supply 被禁用时才添加此标志（节约带宽）
          ...(isSupplyDisabled ? { supplyDisabled: true } : {}),
          ...(isFrozen ? { isFrozen: true } : {}),
          ...(isPaused ? { isPaused: true } : {}),
          borrowApy,
          // 仅当 borrowing 被禁用时才添加此标志（节约带宽）
          ...(isBorrowDisabled ? { borrowDisabled: true } : {}),
          // Protocol incentives - 从 reserve.incentives 提取
          supplyIncentives: protocolSupplyIncentives.length > 0 ? protocolSupplyIncentives : undefined as any,
          borrowIncentives: protocolBorrowIncentives.length > 0 ? protocolBorrowIncentives : undefined as any,
          // Rate-input fields for manual APR calculation (raw strings for precision)
          ...(decimals !== undefined && decimals !== 18 ? { decimals } : {}),
          ...(liquidity ? { liquidity } : {}),
          ...(borrowed ? { borrowed } : {}),
          ...(supplied ? { supplied } : {}),
          ...(supplyCap ? { supplyCap } : {}),
          ...(borrowCap ? { borrowCap } : {}),
          ...(protocolFee !== undefined ? { protocolFee } : {}),
          ...(slopeBelowOptimal !== undefined ? { slopeBelowOptimal } : {}),
          ...(slopeAboveOptimal !== undefined ? { slopeAboveOptimal } : {}),
          ...(optimalUtilization !== undefined ? { optimalUtilization } : {}),
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
type MerklProcessedData = { index: MerklDataIndex; campaignAccess?: import('@internal/aave-shared-contracts').MerklCampaignAccess[] };

function buildReserveTokenPriceMap(baseDataset: RuntimeReserveData[]): Map<string, number> {
  const map = new Map<string, number>();
  baseDataset.forEach((reserve) => {
    const price = toFiniteNumber(reserve.tokenPrice);
    if (price === null || price <= 0) return;
    const address = reserve.tokenAddress?.toLowerCase();
    if (!address) return;
    map.set(`${reserve.chainId}:${address}`, price);
  });
  return map;
}

async function enrichDatasetWithIncentiveData(
  baseDataset: RuntimeReserveData[],
  meritData: MeritDataIndex,
  merklData: MerklDataIndex,
  brevisData: BrevisDataIndex,
  cachedConstraints?: Map<string, NetPositionConstraint>,
): Promise<RuntimeReserveData[]> {
  const reserveIdSet = new Set<string>();
  const symbolLookup = new Map<string, string>();
  for (const r of baseDataset) {
    reserveIdSet.add(r.reserveId);
    const symKey = `${r.chainId}:${r.tokenSymbol}`;
    if (!symbolLookup.has(symKey)) {
      symbolLookup.set(symKey, r.tokenAddress.toLowerCase());
    }
  }

  const llmApiKey = process.env.LLM_API_KEY;
  const llmBaseUrl = process.env.LLM_BASE_URL;
  const llmConfig: LlmClientConfig | undefined = llmApiKey && llmBaseUrl ? { apiKey: llmApiKey, baseUrl: llmBaseUrl } : undefined;

  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  const openrouterConfig: LlmClientConfig | undefined = openrouterApiKey ? { apiKey: openrouterApiKey, baseUrl: 'https://openrouter.ai/api/v1' } : undefined;

  return Promise.all(baseDataset.map(async item => {
    const meritItemData = getMeritDataFromMarket(item.marketName, item.chainName, item.tokenSymbol, meritData);
    
    // 如果有 Merit 数据，直接更新对应字段
    if (meritItemData) {
      // 只有当数组不为空时才赋值，否则保持 undefined
      item.meritSupplys = meritItemData.meritSupplys.length > 0 ? meritItemData.meritSupplys : undefined;
      item.meritBorrows = meritItemData.meritBorrows.length > 0 ? meritItemData.meritBorrows : undefined;
    }
    
    // 获取对应的 Merkl 数据并更新
    const reserveProtocolVersion: 'v3' | 'v4' = item.marketName.startsWith('AaveV4') ? 'v4' : 'v3';
    const matchedOpportunities = findMatchingMerklOpportunities(item, merklData, reserveProtocolVersion);
    
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
        const llmFn = (llmConfig || openrouterConfig) ? () => {
          const prompt = buildLlmPrompt({ type: opp.opportunityType ?? 'unknown', action: opp.name ?? opp.opportunityType ?? 'unknown', description: opp.description ?? '', tokenSymbols: [item.tokenSymbol] });
          return callLlmWithFallback(prompt, llmConfig, openrouterConfig);
        } : undefined;
        const cachedConstraint = opp.opportunityLink ? cachedConstraints?.get(opp.opportunityLink) : undefined;
        const netPositionConstraint = await detectNetPositionConstraint(opp, item.tokenAddress, item.reserveId, reserveIdSet, symbolLookup, cachedConstraint, llmFn);
        if (opp.opportunityLink) {
          if (opp.supply.length > 0) {
            const supplyWithLinks = opp.supply.map(b => ({ ...b, opportunityLink: opp.opportunityLink }));
            supplyBreakdowns.push(...supplyWithLinks);
            supplyOpportunities.push({
              link: opp.opportunityLink || '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              ...(opp.opportunityType && { opportunityType: opp.opportunityType }),
              ...(netPositionConstraint && { netPositionConstraint }),
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
              ...(opp.opportunityType && { opportunityType: opp.opportunityType }),
              ...(netPositionConstraint && { netPositionConstraint }),
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
              ...(opp.opportunityType && { opportunityType: opp.opportunityType }),
              ...(netPositionConstraint && { netPositionConstraint }),
              breakdowns: opp.hold
            });
          }
        } else {
          if (opp.supply.length > 0) {
            supplyBreakdowns.push(...opp.supply);
            supplyOpportunities.push({
              link: '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              ...(opp.opportunityType && { opportunityType: opp.opportunityType }),
              ...(netPositionConstraint && { netPositionConstraint }),
              breakdowns: opp.supply
            });
          }
          if (opp.borrow.length > 0) {
            borrowBreakdowns.push(...opp.borrow);
            borrowOpportunities.push({
              link: '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              ...(opp.opportunityType && { opportunityType: opp.opportunityType }),
              ...(netPositionConstraint && { netPositionConstraint }),
              breakdowns: opp.borrow
            });
          }
          if (opp.hold.length > 0) {
            holdBreakdowns.push(...opp.hold);
            holdOpportunities.push({
              link: '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { message: opp.description }),
              ...(opp.opportunityType && { opportunityType: opp.opportunityType }),
              ...(netPositionConstraint && { netPositionConstraint }),
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
    
    if (item.aTokenAddress === null) item.aTokenAddress = undefined;
    if (item.vTokenAddress === null) item.vTokenAddress = undefined;
    if (item.meritSupplys) item.meritSupplys = item.meritSupplys.map(pruneMeritEntry);
    if (item.meritBorrows) item.meritBorrows = item.meritBorrows.map(pruneMeritEntry);
    if (item.merklSupplys) item.merklSupplys = item.merklSupplys.map(pruneMerklGroup);
    if (item.merklBorrows) item.merklBorrows = item.merklBorrows.map(pruneMerklGroup);
    if (item.merklHolds) item.merklHolds = item.merklHolds.map(pruneMerklGroup);
    if (item.brevisSupplys) item.brevisSupplys = item.brevisSupplys.map(pruneBrevisItem);
    if (item.brevisBorrows) item.brevisBorrows = item.brevisBorrows.map(pruneBrevisItem);
    return item;
  }));
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


function ratioToPercentString(value: number): string {
  return String(value * 100);
}

function generateCSV(data: RuntimeReserveData[]): string {
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
      row.supplyApy !== undefined ? ratioToPercentString(row.supplyApy) : '',
      row.borrowApy !== undefined ? ratioToPercentString(row.borrowApy) : '',
      (row.supplyIncentives && row.supplyIncentives.length > 0)
        ? `"${row.supplyIncentives.map(ratioToPercentString).join(';')}"`
        : '',
      (row.borrowIncentives && row.borrowIncentives.length > 0)
        ? `"${row.borrowIncentives.map(ratioToPercentString).join(';')}"`
        : '',
      // 格式化 meritSupplys：平铺所有数据，格式为 "APR1:selfApr1:link1:startDate1:endDate1:startBlock1:endBlock1:name1:message1;APR2:..."
      // message 格式为 "action1|description1;action2|description2"（多条用分号分隔，action和description用竖线分隔）
      (row.meritSupplys && row.meritSupplys.length > 0) 
        ? `"${row.meritSupplys.map(e => {
            const parts = [ratioToPercentString(e.apr)];
            if (e.selfApr !== undefined) parts.push(ratioToPercentString(e.selfApr));
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
            const parts = [ratioToPercentString(e.apr)];
            if (e.selfApr !== undefined) parts.push(ratioToPercentString(e.selfApr));
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
      // Brevis Supplys：与 Merkl 对齐，包含 group-level name/message + breakdowns
      (row.brevisSupplys && row.brevisSupplys.length > 0) 
        ? `"${row.brevisSupplys.map(g => {
            const parts: string[] = [];
            if (g.name) parts.push(`name:${g.name}`);
            if (g.message) parts.push(`msg:${g.message}`);
            const breakdownStr = (g.breakdowns ?? []).map((b) => {
              const fields = [
                ratioToPercentString(b.campaignApr),
                b.campaignStartedAt,
                b.campaignEndedAt,
                b.campaignId || '',
              ];
              return fields.join(':');
            }).join(';');
            if (breakdownStr) parts.push(`breakdowns:${breakdownStr}`);
            parts.push(`link:${g.link}`);
            return parts.join('|');
          }).join(';')}"` 
        : '',
      // Brevis Borrows：格式同上
      (row.brevisBorrows && row.brevisBorrows.length > 0) 
        ? `"${row.brevisBorrows.map(g => {
            const parts: string[] = [];
            if (g.name) parts.push(`name:${g.name}`);
            if (g.message) parts.push(`msg:${g.message}`);
            const breakdownStr = (g.breakdowns ?? []).map((b) => {
              const fields = [
                ratioToPercentString(b.campaignApr),
                b.campaignStartedAt,
                b.campaignEndedAt,
                b.campaignId || '',
              ];
              return fields.join(':');
            }).join(';');
            if (breakdownStr) parts.push(`breakdowns:${breakdownStr}`);
            parts.push(`link:${g.link}`);
            return parts.join('|');
          }).join(';')}"` 
        : ''
    ].join(','))
  ];

  return csvRows.join('\n');
}

// 从所有链获取 Aave 市场数据
async function fetchRawMarketData(): Promise<MarketData> {
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
  
  // 保存 V3 原始 SDK 响应数据
  const outputPath = join(DEBUG_DATA_DIR, 'v3-raw-sdk-response.json');
  await writeJsonAtomic(outputPath, marketData);
  
  return marketData;
}

export async function runMarketsFetcher(): Promise<void> {
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
    const marketData = await fetchRawMarketData();
    
    // 格式化数据并保存到新文件
    logger.info('\n📊 Formatting market data...');
    
    // 第一步：从 Aave V3 + V4 创建统一基础数据集
    logger.info('📊 Creating unified base dataset (V3 + V4)...');
    const { baseDataset, v3Count, v4Count } = await buildMarketsBaseDataset(marketData.markets);
    const reserveTokenPriceByChainAndAddress = buildReserveTokenPriceMap(baseDataset);

    // 并发获取 Merit、Merkl 和 Brevis 数据（它们之间没有依赖关系）
    // 注意：程序是定期触发的，设置超时避免某个任务卡住导致所有数据被卡住
    // 超时时间设置较长（10分钟），因为大多数时候数据有缓存，等一等没关系
    logger.info('🚀 Starting incentive data fetching concurrently (Merit, Merkl, Brevis running simultaneously)...');
    
    const { meritPromise, merklPromise, brevisPromise } = launchIncentiveFetches(reserveTokenPriceByChainAndAddress, baseDataset);
    
    const INCENTIVE_DATA_TIMEOUT_MS = 10 * 60 * 1000;
    
    const getCompletedResults = async (): Promise<{ merit: MeritDataIndex; merkl: MerklDataIndex; brevis: BrevisDataIndex }> => {
      const { merit, merkl, brevis } = await awaitIncentiveResults(meritPromise, merklPromise, brevisPromise);
      return { merit, merkl, brevis };
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
    const enrichedData = await enrichDatasetWithIncentiveData(baseDataset, meritData, merklData, brevisData, undefined);

    logger.info(`🎯 Final dataset contains ${enrichedData.length} token combinations`);
    
    // 保存格式化 JSON 数据（完整 debug 全量）
    const debugFormattedJsonFullPath = join(DEBUG_DATA_DIR, 'v3v4-enriched-full.json');
    const debugPayload = {
      _metadata: {
        timestamp: marketData.timestamp,
        version: '2.0-debug-full',
        dataCount: enrichedData.length,
        profile: 'debug-full',
        v3Count,
        v4Count,
      },
      data: enrichedData,
    };
    await writeJsonAtomic(debugFormattedJsonFullPath, debugPayload);

    // 生成CSV格式
    const csvData = generateCSV(enrichedData);
    await mkdir(EXPORT_DATA_DIR, { recursive: true });
    const csvPath = join(EXPORT_DATA_DIR, 'aave-formatted-data.csv');
    await writeFile(csvPath, csvData, 'utf-8');
    
    const outputPath = join(DEBUG_DATA_DIR, 'v3-raw-sdk-response.json');
    logger.info(`💾 V3 raw SDK data saved to ${outputPath}`);
    logger.info(`🧪 V3+V4 enriched JSON saved to ${debugFormattedJsonFullPath}`);
    logger.info(`📈 CSV data saved to ${csvPath}`);
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

interface IncentiveResults {
  merit: MeritDataIndex;
  merkl: MerklDataIndex;
  brevis: BrevisDataIndex;
  merklResult: MerklProcessedData;
}

async function awaitIncentiveResults(
  meritPromise: Promise<MeritDataIndex>,
  merklPromise: Promise<MerklProcessedData>,
  brevisPromise: Promise<BrevisDataIndex>,
): Promise<IncentiveResults> {
  const results = await Promise.allSettled([meritPromise, merklPromise, brevisPromise]);
  const merit: MeritDataIndex = results[0].status === 'fulfilled' ? results[0].value : {};
  const merklResult: MerklProcessedData =
    results[1].status === 'fulfilled'
      ? (results[1].value as MerklProcessedData)
      : { index: {} as MerklDataIndex };
  const merkl: MerklDataIndex = merklResult.index;
  const brevis: BrevisDataIndex = results[2].status === 'fulfilled' ? results[2].value : {};
  return { merit, merkl, brevis, merklResult };
}

function launchIncentiveFetches(reserveTokenPriceByChainAndAddress: Map<string, number>, baseDataset: RuntimeReserveData[]) {
  const meritPromise = fetchMeritData().catch((error) => {
    logger.error(`❌ Merit data fetching failed: ${error instanceof Error ? error.message : String(error)}`);
    return {} as MeritDataIndex;
  });
  const reserveIdSet = new Set<string>();
  for (const r of baseDataset) { reserveIdSet.add(r.reserveId); }
  const merklPromise = processMerklData({
    reserveTokenPriceByChainAndAddress,
    reserveIdSet,
    baseDataset,
  }).catch((error) => {
    logger.error(`❌ Merkl data fetching failed: ${error instanceof Error ? error.message : String(error)}`);
    return { index: {} as MerklDataIndex } as MerklProcessedData;
  });
  const brevisPromise = fetchBrevisAprs(baseDataset).catch((error) => {
    logger.error(`❌ Brevis data fetching failed: ${error instanceof Error ? error.message : String(error)}`);
    return {} as BrevisDataIndex;
  });
  return { meritPromise, merklPromise, brevisPromise };
}

// 导出数据获取函数供 backend 内化使用（cron-write/API-read-only 模式）
// 返回内存中的 payload，不写文件
// ts-prune-ignore-next
export async function fetchMarketsData(options?: {
  v4Fatal?: boolean;
  cachedConstraints?: Map<string, NetPositionConstraint>;
}): Promise<MarketsPayload> {
  // 🧹 启动时检查并清理 Cloudflare browser sessions
  logger.info('🔧 Pre-flight check: Cloudflare browser session status...');
  await checkAndReportSessionStatus();

  // 从所有链获取市场数据
  const marketData = await fetchRawMarketData();
  
  // 格式化数据（V3 + V4 unified）
  logger.info('\n📊 Formatting market data...');
  const { baseDataset, v3Count, v4Count, v4Raw } = await buildMarketsBaseDataset(marketData.markets, {
    v4Fatal: options?.v4Fatal,
  });
  const reserveTokenPriceByChainAndAddress = buildReserveTokenPriceMap(baseDataset);

  // 并发获取 Merit、Merkl 和 Brevis 数据
  logger.info('🚀 Starting incentive data fetching concurrently...');
  
  const { meritPromise, merklPromise, brevisPromise } = launchIncentiveFetches(reserveTokenPriceByChainAndAddress, baseDataset);
  const { merit: meritData, merkl: merklData, brevis: brevisData, merklResult } = await awaitIncentiveResults(meritPromise, merklPromise, brevisPromise);

  // Enrich with incentive data
  logger.info('💾 Enriching dataset with incentive data (Merit, Merkl & Brevis)...');
  const enrichedData = await enrichDatasetWithIncentiveData(baseDataset, meritData, merklData, brevisData, options?.cachedConstraints);
  const runtimeData = enrichedData;

  logger.info(`🎯 Final dataset contains ${runtimeData.length} reserves`);

  const payload: MarketsPayload = {
    _metadata: {
      timestamp: marketData.timestamp,
      version: '2.0-runtime-minimal',
      dataCount: runtimeData.length,
      profile: 'runtime-minimal',
    },
    data: runtimeData,
    ...(merklResult.campaignAccess?.length ? { campaignAccess: merklResult.campaignAccess } : {}),
  };

  // Write debug files (non-blocking, never fail the cron)
  writeDebugSnapshot(payload, enrichedData, v3Count, v4Count, v4Raw).catch((err) => {
    logger.warn(`⚠️ Debug file write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  });

  return payload;
}

/**
 * Write debug snapshots to disk so the backend has observable artifacts.
 * Non-critical: failures are logged but never break the cron.
 *
 * Files written:
 * - v3v4-enriched-full.json  — V3+V4 enriched data (pre-prune, with incentives)
 * - v4-raw-sdk-response.json — Raw V4 SDK response (reserves, for V4 debugging)
 */
async function writeDebugSnapshot(
  payload: MarketsPayload,
  enrichedData: RuntimeReserveData[],
  v3Count: number,
  v4Count: number,
  v4Raw: V4FetchResult['raw'],
): Promise<void> {
  await mkdir(DEBUG_DATA_DIR, { recursive: true });

  // V3+V4 enriched full (with incentives, pre-prune)
  await writeJsonAtomic(
    join(DEBUG_DATA_DIR, 'v3v4-enriched-full.json'),
    {
      _metadata: {
        ...payload._metadata,
        version: '2.0-debug-full',
        profile: 'debug-full',
        v3Count,
        v4Count,
      },
      data: enrichedData,
    },
  );

  // V4 raw SDK response (original BigDecimal/BigInt fields stringified)
  if (v4Raw.reserves.length > 0) {
    const rawJson = JSON.stringify(
      {
        _metadata: {
          timestamp: payload._metadata.timestamp,
          reserveCount: v4Raw.reserves.length,
          profile: 'v4-raw-sdk',
        },
        reserves: v4Raw.reserves,
      },
      bigintReplacer as any,
      2,
    );
    await writeFile(join(DEBUG_DATA_DIR, 'v4-raw-sdk-response.json'), rawJson, 'utf-8');
  }

  logger.info(
    `💾 Debug snapshots written (enriched: ${enrichedData.length}, V3: ${v3Count}, V4: ${v4Count})`,
  );
}

export type { NetPositionConstraint } from './merkl-api.js';
