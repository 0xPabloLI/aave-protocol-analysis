import { writeFile, mkdir } from 'fs/promises';
import { chainId, AaveClient, ChainsFilter } from "@aave/client";
import { markets, chains } from "@aave/client/actions";
import * as addressBook from "@aave-dao/aave-address-book";
import {
  installV3RateLimitedFetch,
  restoreOriginalFetch,
  resetV3RateLimitState,
  getV3RateLimitStats,
  readNumberEnv,
} from '@internal/aave-shared-config';

// V3 AaveClient does not inherit GqlClient — no queryRegistry leak risk, safe as singleton
const client = AaveClient.create();
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { writeJsonAtomic } from './file-utils.js';
import { brevisApi, pruneBrevisCampaignForRuntime } from './brevis-api.js';
import { fetchBrevisDistributedSoFar } from './brevis-distributed-so-far.js';
import { providerPool } from '@internal/aave-rpc-infra';
import { resolveUsdPriceWithPriority } from './token-price-resolver.js';
import { toFiniteNumber, percentValueToPercent } from './utils/number.js';
import {
  MerklCampaignBreakdown,
  MerklOpportunityData,
  MerklOpportunityGroup,
  processMerklData,
  findMatchingMerklOpportunities,
  deduplicateHubSpokeBreakdowns,
  formatMerklBreakdown,
  detectNetPositionConstraint,
} from './merkl-api.js';
import type { OffsetLevel } from './merkl-api.js';
import type { NetPositionConstraint } from '@internal/aave-shared-contracts';
import { buildLlmPrompt, callLlmWithFallback } from './merklLlmClient.js';
import type { LlmClientConfig } from './merklLlmClient.js';
import {
  MeritDataItem,
  fetchMeritData,
  getMeritDataFromMarket
} from './merit-api.js';
import type { BrevisCampaignBreakdown, BrevisCampaignItem, BrevisDataItem } from './brevis-api.js';
import { pruneMeritCampaignGroup, pruneMerklGroup, pruneBrevisItem } from './incentive-prune.js';
import {
  checkAndReportSessionStatus,
  closeBrowserInstances
} from './cloudflare-browser.js';
import { fetchV4ReservesData, bigintReplacer } from './v4-fetcher.js';
import { closeBrowser } from './merit-api.js';
import type { V4FetchResult } from './v4-retry.js';
import type { RuntimeReserveData, MarketsPayload, SpokeHubTopology } from '@internal/aave-shared-contracts';
import { chainTokenKey, chainSymbolKey } from '@internal/aave-shared-contracts';
import { buildMarketsBaseDataset as _buildMarketsBaseDataset, buildV3BaseDataset as _buildV3BaseDataset, fetchV4ReservesWithTimeout as _fetchV4ReservesWithTimeout, fetchV3MarketsWithTimeout as _fetchV3MarketsWithTimeout, FETCH_TIMEOUT_MS } from './concurrent-fetch.js';
import { fetchV4ReservesViaRpc, getDefaultV4SpokeEntries } from '@internal/aave-rpc-infra';
export type { RuntimeReserveData, MarketsPayload, SpokeHubTopology } from '@internal/aave-shared-contracts';
export type {
  MerklCampaignBreakdown,
  MerklOpportunityGroup,
} from '@internal/aave-shared-contracts';
export type {
  BrevisCampaignBreakdown,
  BrevisCampaignItem,
} from '@internal/aave-shared-contracts';


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
): Promise<BrevisProcessedData> {
  try {
    logger.info('🌐 Fetching Brevis Incentra Aave campaign data...');
    
    // 获取所有 Aave campaign 数据（包含原始响应数据）
    const brevisResult = await brevisApi.getAaveCampaignsData();
    const brevisIndex: BrevisDataIndex = brevisResult.index;
    let brevisDistributedSoFar = new Map<string, number | undefined>();

    // 用于 reward token 价格解析：优先后端快照 tokenPrice，缺失时再走 CoinGecko fallback。
    const tokenPriceByChainAndAddress = new Map<string, number>();
    baseDataset.forEach((reserve) => {
      const price = toFiniteNumber(reserve.tokenPrice);
      if (price === null) return;
      const address = reserve.tokenAddress?.toLowerCase();
      if (!address) return;
      tokenPriceByChainAndAddress.set(chainTokenKey(reserve.chainId, address), price);
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
        const reservePriceKey = chainTokenKey(chainId, rewardTokenAddress);
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
              tokenSymbol: breakdown.rewardTokenSymbol,
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

    if (brevisResult.submitContracts.size > 0) {
      try {
        const chainCampaigns = Array.from(brevisResult.submitContracts.entries())
          .map(([campaignId, info]) => ({ campaignId, ...info }));
        brevisDistributedSoFar = await fetchBrevisDistributedSoFar(
          chainCampaigns,
          tokenPriceByChainAndAddress,
          { providerPool },
        );
      } catch (error: any) {
        logger.warn(`⚠️ Brevis distributedSoFar chain read failed: ${error.message}`);
      }
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
    logger.debug(`💾 Brevis raw data saved to ${brevisRawPath}`);
    
    logger.info(`✅ Indexed Brevis campaign data for ${Object.keys(brevisIndex).length} chain-token combinations`);
    logger.info(`   Supply campaigns: ${totalSupply}, Borrow campaigns: ${totalBorrow}`);
    logger.info(
      `   Price source usage (Brevis totalBudget): snapshot=${brevisPriceSourceStats.snapshot}, reserve=${brevisPriceSourceStats.reserve}, coingecko=${brevisPriceSourceStats.coingecko}, missing=${brevisPriceSourceStats.missing}`
    );
    
    return { index: brevisIndex, brevisDistributedSoFar };
  } catch (error) {
    logger.error('❌ Error fetching Brevis APR data:', error);
    return { index: {}, brevisDistributedSoFar: new Map() };
  }
}



export { FETCH_TIMEOUT_MS } from './concurrent-fetch.js';
export { closeBrowser, getMeritCacheStats } from './merit-api.js';
export { getTokenPriceCacheStats } from './token-price-resolver.js';
export { getBrevisCacheStats } from './brevis-distributed-so-far.js';

export function buildMarketsBaseDataset(v3Markets: any[], v4Result: V4FetchResult): ReturnType<typeof _buildMarketsBaseDataset> {
  return _buildMarketsBaseDataset(v3Markets, v4Result);
}

function buildV3BaseDataset(markets: any[]): RuntimeReserveData[] {
  return _buildV3BaseDataset(markets);
}

export async function fetchV3MarketsWithTimeout(options?: {
  _fetchV3Fn?: () => Promise<MarketData>;
}): Promise<MarketData> {
  return _fetchV3MarketsWithTimeout({ _fetchV3Fn: options?._fetchV3Fn ?? fetchRawMarketData });
}

export async function fetchV4ReservesWithTimeout(options?: {
  _fetchV4Fn?: () => Promise<V4FetchResult>;
  _fetchRpcFn?: () => Promise<{ reserves: RuntimeReserveData[]; errors: string[] }>;
}): Promise<V4FetchResult & { source: 'sdk' | 'rpc' | 'none' }> {
  const fetchFn = options?._fetchV4Fn ?? (() => fetchV4ReservesData({ throwOnFinalFailure: false }));
  // Production default: RPC direct-chain fallback via aave-rpc-infra (15s timeout enforced inside)
  const rpcFn = options?._fetchRpcFn ?? (() => fetchV4ReservesViaRpc({ entries: getDefaultV4SpokeEntries(), timeoutMs: 15_000 }));
  return _fetchV4ReservesWithTimeout({ _fetchV4Fn: fetchFn, _fetchRpcFn: rpcFn });
}

// 将 Merit、Merkl 和 Brevis 激励数据填充到基础数据集中
// 类型别名：用于数据索引
type MeritDataIndex = Record<string, MeritDataItem>;
type MerklDataIndex = Record<string, MerklOpportunityData[]>;
type BrevisDataIndex = Record<string, BrevisDataItem>;
type MerklProcessedData = { index: MerklDataIndex; campaignAccess?: import('@internal/aave-shared-contracts').MerklCampaignAccess[] };
type BrevisProcessedData = { index: BrevisDataIndex; brevisDistributedSoFar: Map<string, number | undefined> };

function buildReserveTokenPriceMap(baseDataset: RuntimeReserveData[]): Map<string, number> {
  const map = new Map<string, number>();
  baseDataset.forEach((reserve) => {
    const price = toFiniteNumber(reserve.tokenPrice);
    if (price === null || price <= 0) return;
    const address = reserve.tokenAddress?.toLowerCase();
    if (!address) return;
    map.set(chainTokenKey(reserve.chainId, address), price);
  });
  return map;
}

async function enrichDatasetWithIncentiveData(
  baseDataset: RuntimeReserveData[],
  meritData: MeritDataIndex,
  merklData: MerklDataIndex,
  brevisData: BrevisDataIndex,
  cachedConstraints?: Map<string, NetPositionConstraint | null>,
): Promise<RuntimeReserveData[]> {
  const reserveIdSet = new Set<string>();
  const symbolLookup = new Map<string, string>();
  for (const r of baseDataset) {
    reserveIdSet.add(r.reserveId);
    const symKey = chainSymbolKey(r.chainId, r.tokenSymbol);
    if (!symbolLookup.has(symKey)) {
      symbolLookup.set(symKey, r.tokenAddress.toLowerCase());
    }
  }

  const llmApiKey = process.env.LLM_API_KEY;
  const llmBaseUrl = process.env.LLM_BASE_URL;
  const llmConfig: LlmClientConfig | undefined = llmApiKey && llmBaseUrl ? { apiKey: llmApiKey, baseUrl: llmBaseUrl } : undefined;
  // Concurrent writes from Promise.all — order unpredictable; for aggregate stats only
  const _llmCalls: { reserveId: string; elapsed: number; outcome: string }[] = [];
  // Best-effort circuit breaker: not a strict mutex (JS is single-threaded but
  // multiple llmFn closures may already be awaiting callLlmWithFallback when
  // the first 'unavailable' lands). Scope is per-enrichDatasetWithIncentiveData
  // invocation — next cron cycle starts fresh.
  let llmCircuitOpen = false;

  const enrichedItems = await Promise.all(baseDataset.map(async item => {
    const isV4Reserve = item.marketName.startsWith('AaveV4');
    const meritItemData = getMeritDataFromMarket(item.marketName, item.chainName, item.tokenSymbol, meritData);
    
    if (meritItemData) {
      if (meritItemData.meritSupplys.length > 0 || meritItemData.meritBorrows.length > 0) {
        item.meritSupplys = meritItemData.meritSupplys.length > 0 ? meritItemData.meritSupplys : undefined;
        item.meritBorrows = meritItemData.meritBorrows.length > 0 ? meritItemData.meritBorrows : undefined;
        if (isV4Reserve) {
          logger.warn('V4 reserve matched Merit incentive (expected V3-only)', {
            chainId: item.chainId, tokenSymbol: item.tokenSymbol, marketName: item.marketName, source: 'merit',
          });
        }
      }
    }
    
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
        const llmFn = llmConfig ? () => {
          const _llmStart = Date.now();
          if (llmCircuitOpen) {
            _llmCalls.push({ reserveId: item.reserveId, elapsed: 0, outcome: 'circuit-open' });
            return Promise.resolve({ tag: 'unavailable' as const });
          }
          const prompt = buildLlmPrompt({ type: opp.opportunityType ?? 'unknown', action: opp.name ?? opp.opportunityType ?? 'unknown', description: opp.description ?? '', tokenSymbols: [item.tokenSymbol] });
          return callLlmWithFallback(prompt, llmConfig).then(outcome => {
            _llmCalls.push({ reserveId: item.reserveId, elapsed: Date.now() - _llmStart, outcome: outcome.tag });
            if (outcome.tag === 'unavailable') {
              llmCircuitOpen = true;
              logger.info(`[enrich-llm] circuit opened after unavailable (${Date.now() - _llmStart}ms)`);
            }
            return outcome;
          });
        } : undefined;
        const cachedConstraint = opp.opportunityId ? cachedConstraints?.get(opp.opportunityId) : undefined;
        const oppOffsetLevel: OffsetLevel =
          opp.opportunityType?.includes('SPOKE_SUPPLY') ? 'reserve'
          : opp.opportunityType?.includes('HUB_SUPPLY') ? 'hub-cross-spoke'
          : opp.opportunityType?.includes('V4_NET_APR') ? 'hub-cross-spoke'
          : 'reserve';
        const oppOffsetTokenAddresses = opp.offsetTokenAddresses;
        const netPositionConstraint = await detectNetPositionConstraint(opp, item.tokenAddress, item.reserveId, reserveIdSet, symbolLookup, cachedConstraint, llmFn, oppOffsetLevel, oppOffsetTokenAddresses);
        if (opp.opportunityId && cachedConstraints && cachedConstraint === undefined) {
          cachedConstraints.set(opp.opportunityId, netPositionConstraint ?? null);
        }
        const oppBase = {
          link: opp.opportunityId ? `https://app.merkl.xyz/opportunities/${opp.opportunityId}` : '',
          ...(opp.opportunityId && { opportunityId: opp.opportunityId }),
          ...(opp.name && { name: opp.name }),
          ...(opp.description && { message: opp.description }),
          ...(opp.opportunityId && netPositionConstraint !== undefined ? { netPositionConstraint } : {}),
          ...(opp.borrowBlacklist && { borrowBlacklist: true }),
        };
        if (opp.supply.length > 0) {
          supplyBreakdowns.push(...opp.supply);
          supplyOpportunities.push({
            ...oppBase,
            breakdowns: opp.supply
          });
        }
        if (opp.borrow.length > 0) {
          borrowBreakdowns.push(...opp.borrow);
          borrowOpportunities.push({
            ...oppBase,
            breakdowns: opp.borrow
          });
        }
        if (opp.hold.length > 0) {
          holdBreakdowns.push(...opp.hold);
          holdOpportunities.push({
            ...oppBase,
            breakdowns: opp.hold
          });
        }
      }
      
      // 用于 JSON：按 opportunity 分组的数据（避免重复，结构清晰）
      // ADR-0030 revised: V4 Hub/Spoke breakdown-level dedup — remove parent Hub
      // breakdowns when a matching child Spoke exists (Spoke campaignApr = incentiveAPR)
      const dedupedSupply = deduplicateHubSpokeBreakdowns(supplyOpportunities);
      const dedupedBorrow = deduplicateHubSpokeBreakdowns(borrowOpportunities);
      const dedupedHold = deduplicateHubSpokeBreakdowns(holdOpportunities);
      if (dedupedSupply.length > 0) {
        item.merklSupplys = dedupedSupply;
      }
      if (dedupedBorrow.length > 0) {
        item.merklBorrows = dedupedBorrow;
      }
      if (dedupedHold.length > 0) {
        item.merklHolds = dedupedHold;
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
      if (brevisInfo.brevisSupplys.length > 0 || brevisInfo.brevisBorrows.length > 0) {
        item.brevisSupplys = brevisInfo.brevisSupplys.length > 0 ? brevisInfo.brevisSupplys : undefined;
        item.brevisBorrows = brevisInfo.brevisBorrows.length > 0 ? brevisInfo.brevisBorrows : undefined;
        if (isV4Reserve) {
          logger.warn('V4 reserve matched Brevis incentive (expected V3-only)', {
            chainId: item.chainId, tokenSymbol: item.tokenSymbol, marketName: item.marketName, source: 'brevis',
          });
        }
      }
    }
    
    if (item.aTokenAddress === null) item.aTokenAddress = undefined;
    if (item.vTokenAddress === null) item.vTokenAddress = undefined;
    if (item.meritSupplys) item.meritSupplys = item.meritSupplys.map(pruneMeritCampaignGroup);
    if (item.meritBorrows) item.meritBorrows = item.meritBorrows.map(pruneMeritCampaignGroup);
    if (item.merklSupplys) item.merklSupplys = item.merklSupplys.map(pruneMerklGroup);
    if (item.merklBorrows) item.merklBorrows = item.merklBorrows.map(pruneMerklGroup);
    if (item.merklHolds) item.merklHolds = item.merklHolds.map(pruneMerklGroup);
    if (item.brevisSupplys) item.brevisSupplys = item.brevisSupplys.map(pruneBrevisItem);
    if (item.brevisBorrows) item.brevisBorrows = item.brevisBorrows.map(pruneBrevisItem);
    return item;
  }));

  if (_llmCalls.length > 0) {
    const _llmTotal = _llmCalls.reduce((s, c) => s + c.elapsed, 0);
    const _llmMax = _llmCalls.reduce((m, c) => Math.max(m, c.elapsed), 0);
    const _llmCircuitOpen = _llmCalls.filter(c => c.outcome === 'circuit-open').length;
    const _llmUnavailable = _llmCalls.filter(c => c.outcome === 'unavailable').length;
    const _llmResult = _llmCalls.filter(c => c.outcome === 'result').length;
    logger.info(`[enrich-llm] calls=${_llmCalls.length} total=${_llmTotal}ms max=${_llmMax}ms unavailable=${_llmUnavailable} circuit-open=${_llmCircuitOpen} result=${_llmResult}`);
  }

  return enrichedItems;
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
      (row.meritSupplys && row.meritSupplys.length > 0) 
        ? `"${row.meritSupplys.map(g => {
            const parts: string[] = [];
            if (g.name) parts.push(`name:${g.name}`);
            if (g.message) parts.push(`msg:${g.message}`);
            const breakdownStr = (g.breakdowns ?? []).map(b => {
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
      (row.meritBorrows && row.meritBorrows.length > 0) 
        ? `"${row.meritBorrows.map(g => {
            const parts: string[] = [];
            if (g.name) parts.push(`name:${g.name}`);
            if (g.message) parts.push(`msg:${g.message}`);
            const breakdownStr = (g.breakdowns ?? []).map(b => {
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
      // 格式化 Merkl Supplys：包含 name 和 message
      (row.merklSupplys && row.merklSupplys.length > 0)
        ? `"${row.merklSupplys.map(g => {
            const parts: string[] = [];
            // 添加 name 和 message（如果有）
            if (g.name) parts.push(`name:${g.name}`);
            if (g.message) parts.push(`msg:${g.message}`);
            // 添加 breakdowns（格式化为字符串）
            const breakdownStr = formatMerklBreakdown(
              g.breakdowns.map(b => ({ ...b, opportunityId: g.opportunityId }))
            );
            if (breakdownStr) parts.push(`breakdowns:${breakdownStr}`);
            if (g.opportunityId) parts.push(`oppId:${g.opportunityId}`);
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
              g.breakdowns.map(b => ({ ...b, opportunityId: g.opportunityId }))
            );
            if (breakdownStr) parts.push(`breakdowns:${breakdownStr}`);
            if (g.opportunityId) parts.push(`oppId:${g.opportunityId}`);
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
              g.breakdowns.map(b => ({ ...b, opportunityId: g.opportunityId }))
            );
            if (breakdownStr) parts.push(`breakdowns:${breakdownStr}`);
            if (g.opportunityId) parts.push(`oppId:${g.opportunityId}`);
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
  
  const networkInfo = await getAllAaveV3Networks();
  const chainIds = [...new Set(networkInfo.map(info => info.chainId))];
  
  logger.info(`🌐 Found ${networkInfo.length} AaveV3 networks across ${chainIds.length} unique chains`);
  logger.info('📋 Networks:');
  networkInfo.forEach(info => {
    logger.info(`   • ${info.name} (Chain ID: ${info.chainId})`);
  });
  
  logger.info('\n🚀 Fetching markets data (inner-layer QPS control + 429 retry)...');

  const maxChainConcurrency = readNumberEnv('V3_CHAIN_CONCURRENCY', { defaultValue: 2, min: 1 });

  let activeCount = 0;
  const waitQueue: (() => void)[] = [];
  const acquireSlot = () => {
    if (activeCount < maxChainConcurrency) {
      activeCount++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waitQueue.push(resolve));
  };
  const releaseSlot = () => {
    const next = waitQueue.shift();
    if (next) { next(); } else { activeCount--; }
  };

  const fetchSingleChain = async (chainIdValue: number): Promise<{ markets: any[]; chainId: number; error?: string }> => {
    await acquireSlot();
    try {
      try {
        const result = await markets(client, {
          chainIds: [chainId(chainIdValue)],
        });
        
        if (result && typeof result === 'object' && 'isErr' in result && typeof result.isErr === 'function') {
          if (result.isErr()) {
            const errorInfo = result.error;
            const errorMsg = `${errorInfo.name || 'UnknownError'}${errorInfo.message ? ` - ${errorInfo.message}` : ''}`;
            return { markets: [], chainId: chainIdValue, error: `Chain ${chainIdValue}: ${errorMsg}` };
          }
          if (result.value && Array.isArray(result.value) && result.value.length > 0) {
            logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.value.length} markets`);
            return { markets: result.value, chainId: chainIdValue };
          }
          logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found (result.value is empty)`);
          return { markets: [], chainId: chainIdValue };
        } else if (result && typeof result === 'object' && 'value' in result) {
          if (result.value && Array.isArray(result.value) && result.value.length > 0) {
            logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.value.length} markets`);
            return { markets: result.value, chainId: chainIdValue };
          }
          logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found (result.value is empty)`);
          return { markets: [], chainId: chainIdValue };
        } else if (result && Array.isArray(result) && result.length > 0) {
          logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.length} markets`);
          return { markets: result, chainId: chainIdValue };
        }
        logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found (unexpected format)`);
        return { markets: [], chainId: chainIdValue };
      } catch (error) {
        const errorMsg = `Chain ${chainIdValue}: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(`   ❌ ${errorMsg}`);
        return { markets: [], chainId: chainIdValue, error: errorMsg };
      }
    } finally {
      releaseSlot();
    }
  };

  resetV3RateLimitState();
  installV3RateLimitedFetch();
  try {
    const results = await Promise.allSettled(
      chainIds.map(chainIdValue => fetchSingleChain(chainIdValue))
    );

    const marketList: any[] = [];
    const supportedChainIds: number[] = [];
    const errors: string[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { markets: chainMarkets, chainId: cid, error } = result.value;
        if (chainMarkets.length > 0) {
          marketList.push(...chainMarkets);
          supportedChainIds.push(cid);
        }
        if (error) {
          errors.push(error);
        }
      } else {
        errors.push(`Unexpected rejection: ${result.reason}`);
      }
    }
    
    const rateLimitStats = getV3RateLimitStats();
    
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
    if (rateLimitStats.total429s > 0) {
      logger.warn(`📊 V3 rate limit: ${rateLimitStats.total429s} total 429s during this cycle`);
    }
    if (rateLimitStats.requestCount > 0) {
      logger.info(
        `📊 V3 requests: ${rateLimitStats.requestCount} total ` +
        `(${rateLimitStats.status200} ok, ${rateLimitStats.status429} 429) ` +
        `byAttempt=${JSON.stringify(rateLimitStats.byAttempt)} ` +
        `avgQPS=${rateLimitStats.qps}`
      );
      if (rateLimitStats.status429 > 0 && rateLimitStats.requests) {
        const req429 = rateLimitStats.requests.filter(r => r.status === 429);
        const ts0 = rateLimitStats.requests[0]?.ts ?? 0;
        const buckets: Record<string, number> = {};
        for (const r of req429) {
          const sec = Math.floor((r.ts - ts0) / 1000);
          buckets[sec] = (buckets[sec] || 0) + 1;
        }
        logger.info(`📊 V3 429 timeline (seconds from start): ${JSON.stringify(buckets)}`);
      }
    }

    await mkdir(DEBUG_DATA_DIR, { recursive: true });
    
    const outputPath = join(DEBUG_DATA_DIR, 'v3-raw-sdk-response.json');
    await writeJsonAtomic(outputPath, marketData);
    
    return marketData;
  } finally {
    restoreOriginalFetch();
  }
}

const _MB = 1024 * 1024;
const _memoryDiagEnabled = process.env.MEMORY_DIAG === '1';
function rssDelta(label: string, beforeRss: number): number {
  if (!_memoryDiagEnabled) return process.memoryUsage().rss;
  const after = process.memoryUsage().rss;
  const delta = (after - beforeRss) / _MB;
  if (Math.abs(delta) > 0.5) {
    logger.info(`🔍 rss-diff [${label}] rss=${delta >= 0 ? '+' : ''}${delta.toFixed(1)}MB → absRss=${(after / _MB).toFixed(0)}MB`);
  }
  return after;
}

export async function runMarketsFetcher(): Promise<void> {
  let rssMark = process.memoryUsage().rss;

  logger.info('🔧 Pre-flight check: Cloudflare browser session status...');
  await checkAndReportSessionStatus();
  rssMark = rssDelta('pre-flight', rssMark);

  if (process.env.CLOSE_BROWSERS_ON_START === 'true') {
    logger.info('🔌 CLOSE_BROWSERS_ON_START=true, closing existing browser instances...');
    await closeBrowserInstances();
    logger.info('⏳ Waiting 30s after closing browsers for Cloudflare to release resources...');
    await new Promise(resolve => setTimeout(resolve, 30000));
  }

  try {
    // V3/V4 并发 fetch + per-side 独立超时
    logger.info('🚀 Starting V3/V4 concurrent fetch...');
    const [v3Settled, v4Settled] = await Promise.allSettled([
      fetchV3MarketsWithTimeout({ _fetchV3Fn: fetchRawMarketData }),
      fetchV4ReservesWithTimeout({ _fetchV4Fn: () => fetchV4ReservesData({ throwOnFinalFailure: false }) }),
    ]);
    rssMark = rssDelta('v3v4-fetch', rssMark);

    const v3Success = v3Settled.status === 'fulfilled';
    const v4SettledValue = v4Settled.status === 'fulfilled' ? v4Settled.value : { mapped: [], raw: { reserves: [] }, spokeHubTopology: [], source: 'none' as const };
    const v4Success = v4SettledValue.mapped.length > 0;

    if (!v3Success) {
      const reason = v3Settled.status === 'rejected' ? v3Settled.reason : 'unknown';
      logger.error(`❌ V3 fetch failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    if (!v4Success) {
      logger.warn(`⚠️ V4 fetch produced no data (source=${v4SettledValue.source})`);
    }

    const emptyMarketData: MarketData = { timestamp: new Date().toISOString(), totalNetworks: 0, chainIds: [], networkInfo: [], markets: [], errors: ['V3 fetch failed'] };
    const marketData = v3Success ? v3Settled.value : emptyMarketData;
    const v4Result = v4SettledValue;

    if (!v3Success && !v4Success) {
      throw new Error('Both V3 and V4 fetch failed');
    }

    // 格式化数据并保存到新文件
    logger.info('\n📊 Formatting market data...');
    
    // 第一步：从 Aave V3 + V4 创建统一基础数据集
    logger.info('📊 Creating unified base dataset (V3 + V4)...');
    const { baseDataset, v3Count, v4Count } = buildMarketsBaseDataset(marketData.markets, v4Result);
    const reserveTokenPriceByChainAndAddress = buildReserveTokenPriceMap(baseDataset);
    rssMark = rssDelta('base-dataset', rssMark);

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
          checkCompleted(brevisPromise, { index: {} as BrevisDataIndex, brevisDistributedSoFar: new Map<string, number | undefined>() } as BrevisProcessedData),
        ]);
        
        const meritData: MeritDataIndex = meritCheck.completed ? meritCheck.value : {};
        const merklData: MerklDataIndex = merklCheck.completed ? merklCheck.value.index : {};
        const brevisData: BrevisDataIndex = brevisCheck.completed ? brevisCheck.value.index : {};
        
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
    rssMark = rssDelta('incentive-fetch', rssMark);
    
    logger.info('✅ Using available incentive data (some tasks may still be running in background)');
    
    // 第二步：将 Merit、Merkl 和 Brevis 激励数据填充到基础数据集中
    logger.info('💾 Enriching dataset with incentive data (Merit, Merkl & Brevis)...');
    const enrichedData = await enrichDatasetWithIncentiveData(baseDataset, meritData, merklData, brevisData, undefined);
    rssMark = rssDelta('enrich', rssMark);

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
    logger.debug(`💾 V3 raw SDK data saved to ${outputPath}`);
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
      logger.debug(`💾 Error data saved to ${errorPath}`);
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
  brevisResult: BrevisProcessedData;
}

async function awaitIncentiveResults(
  meritPromise: Promise<MeritDataIndex>,
  merklPromise: Promise<MerklProcessedData>,
  brevisPromise: Promise<BrevisProcessedData>,
): Promise<IncentiveResults> {
  const results = await Promise.allSettled([meritPromise, merklPromise, brevisPromise]);
  const merit: MeritDataIndex = results[0].status === 'fulfilled' ? results[0].value : {};
  const merklResult: MerklProcessedData =
    results[1].status === 'fulfilled'
      ? (results[1].value as MerklProcessedData)
      : { index: {} as MerklDataIndex };
  const merkl: MerklDataIndex = merklResult.index;
  const brevisResult: BrevisProcessedData =
    results[2].status === 'fulfilled'
      ? results[2].value
      : { index: {} as BrevisDataIndex, brevisDistributedSoFar: new Map<string, number | undefined>() };
  const brevis: BrevisDataIndex = brevisResult.index;
  return { merit, merkl, brevis, merklResult, brevisResult };
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
    return { index: {} as BrevisDataIndex, brevisDistributedSoFar: new Map<string, number | undefined>() } as BrevisProcessedData;
  });
  return { meritPromise, merklPromise, brevisPromise };
}

// 导出数据获取函数供 backend 内化使用（cron-write/API-read-only 模式）
// 返回内存中的 payload，不写文件
// ts-prune-ignore-next
export async function fetchMarketsData(options?: {
  cachedConstraints?: Map<string, NetPositionConstraint | null>;
}): Promise<MarketsPayload> {
  const _t0 = Date.now();
  const _elapsed = () => `${Date.now() - _t0}ms`;
  let rssMark = process.memoryUsage().rss;

  // 🧹 启动时检查并清理 Cloudflare browser sessions
  logger.info(`🔧 Pre-flight check: Cloudflare browser session status... [${_elapsed()}]`);
  await checkAndReportSessionStatus();
  rssMark = rssDelta('pre-flight', rssMark);

  // V3/V4 并发 fetch + per-side 独立超时
  logger.info(`🚀 Starting V3/V4 concurrent fetch... [${_elapsed()}]`);
  const [v3Settled, v4Settled] = await Promise.allSettled([
    fetchV3MarketsWithTimeout({ _fetchV3Fn: fetchRawMarketData }),
    fetchV4ReservesWithTimeout({ _fetchV4Fn: () => fetchV4ReservesData({ throwOnFinalFailure: false }) }),
  ]);
  logger.info(`V3/V4 concurrent fetch done [${_elapsed()}]`);
  rssMark = rssDelta('v3v4-fetch', rssMark);

  const v3Success = v3Settled.status === 'fulfilled';
  // fetchV4ReservesWithTimeout never rejects (Layer 2 handles all SDK failures).
  // Success = data was produced (mapped.length > 0), regardless of which layer provided it.
  const v4SettledValue = v4Settled.status === 'fulfilled' ? v4Settled.value : { mapped: [], raw: { reserves: [] }, spokeHubTopology: [], source: 'none' as const };
  const v4Success = v4SettledValue.mapped.length > 0;
  const v4Source = v4SettledValue.source;

  if (!v3Success) {
    const reason = v3Settled.status === 'rejected' ? v3Settled.reason : 'unknown';
    logger.error(`❌ V3 fetch failed: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
  if (!v4Success) {
    logger.warn(`⚠️ V4 fetch produced no data (source=${v4Source})`);
  }

  const emptyMarketData: MarketData = { timestamp: new Date().toISOString(), totalNetworks: 0, chainIds: [], networkInfo: [], markets: [], errors: ['V3 fetch failed'] };
  const marketData = v3Success ? v3Settled.value : emptyMarketData;
  const v4Result = v4SettledValue;

  if (!v3Success && !v4Success) {
    throw new Error('Both V3 and V4 fetch failed');
  }

  logger.info(`📊 Formatting market data... [${_elapsed()}]`);
  const { baseDataset, v3Count, v4Count, v4Raw, spokeHubTopology } = buildMarketsBaseDataset(marketData.markets, v4Result);
  const reserveTokenPriceByChainAndAddress = buildReserveTokenPriceMap(baseDataset);
  logger.info(`Formatting done: ${baseDataset.length} reserves (V3=${v3Count}, V4=${v4Count}) [${_elapsed()}]`);
  rssMark = rssDelta('base-dataset', rssMark);

  // 并发获取 Merit、Merkl 和 Brevis 数据
  logger.info(`🚀 Starting incentive data fetching concurrently... [${_elapsed()}]`);
  
  const { meritPromise, merklPromise, brevisPromise } = launchIncentiveFetches(reserveTokenPriceByChainAndAddress, baseDataset);

  // Wrap each promise with rss-diff (baseline is pre-incentive; all three share the same baseline
  // since they run concurrently, so each rss-diff shows the absolute delta from that shared baseline).
  const meritDone = meritPromise.then(v => { rssDelta('merit-done', rssMark); return v; });
  const merklDone = merklPromise.then(v => { rssDelta('merkl-done', rssMark); return v; });
  const brevisDone = brevisPromise.then(v => { rssDelta('brevis-done', rssMark); return v; });

  const { merit: meritData, merkl: merklData, brevis: brevisData, merklResult, brevisResult } = await awaitIncentiveResults(meritDone, merklDone, brevisDone);
  rssMark = rssDelta('incentive-fetch', rssMark);

  logger.info(`Incentive data fetched (Merit keys=${Object.keys(meritData).length}, Merkl keys=${Object.keys(merklData).length}, Brevis keys=${Object.keys(brevisData).length}) [${_elapsed()}]`);

  // Enrich with incentive data
  const _enrichStart = Date.now();
  logger.info(`💾 Enriching dataset with incentive data (Merit, Merkl & Brevis)... [${_elapsed()}]`);
  const runtimeData = await enrichDatasetWithIncentiveData(baseDataset, meritData, merklData, brevisData, options?.cachedConstraints);
  logger.info(`Enriching done: ${runtimeData.length} reserves [enrich=${Date.now() - _enrichStart}ms, total=${_elapsed()}]`);
  rssMark = rssDelta('enrich', rssMark);

  logger.info(`🎯 Final dataset contains ${runtimeData.length} reserves [${_elapsed()}]`);

  const payload: MarketsPayload = {
    _metadata: {
      timestamp: marketData.timestamp,
      version: '2.0-runtime-minimal',
      dataCount: runtimeData.length,
      profile: 'runtime-minimal',
      fetchResult: {
        v3: { success: v3Success, source: v3Success ? 'sdk' : 'none' },
        // v4Source carries 'sdk' | 'rpc' | 'none' from the fetch layer (AAV-583)
        v4: { success: v4Success, source: v4Success ? v4Source : 'none' },
      },
    },
    data: runtimeData,
    ...(merklResult.campaignAccess?.length ? { campaignAccess: merklResult.campaignAccess } : {}),
    ...(spokeHubTopology.length ? { spokeHubTopology } : {}),
    ...(brevisResult.brevisDistributedSoFar.size > 0 ? { brevisDistributedSoFar: brevisResult.brevisDistributedSoFar } : {}),
  };

  // Write debug files (non-blocking, never fail the cron)
  writeDebugSnapshot(payload, runtimeData, v3Count, v4Count, v4Raw).catch((err) => {
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

  logger.debug(
    `💾 Debug snapshots written (enriched: ${enrichedData.length}, V3: ${v3Count}, V4: ${v4Count})`,
  );
}

export type { NetPositionConstraint } from '@internal/aave-shared-contracts';
