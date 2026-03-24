import fetch from 'node-fetch';
import type { RequestInit, Response } from 'node-fetch';
import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { writeJsonAtomic } from './file-utils.js';
import { merklFetchConfig } from './config.js';
import {
  createMerklConcurrencyLimitedFetch,
  fetchMerklOpportunitiesSnapshot,
  resolveCacheTtlMs,
} from '@internal/aave-shared-config';

const merklLimitedFetch = createMerklConcurrencyLimitedFetch(
  fetch as unknown as typeof globalThis.fetch
) as unknown as typeof fetch;

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const RUNTIME_DATA_DIR = join(DATA_DIR, 'runtime');
const DEBUG_DATA_DIR = join(DATA_DIR, 'debug');
const OPPORTUNITIES_CACHE_TTL_MS = resolveCacheTtlMs(
  process.env.MERKL_OPPORTUNITIES_CACHE_TTL_MS,
  1 * 60 * 1000
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  const retryableCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETRESET', 'ECONNREFUSED']);
  // node-fetch errors surface via error.cause?.code or error.code
  const code = (error as any)?.code || (error as any)?.cause?.code;
  return Boolean(code && retryableCodes.has(String(code)));
}

async function fetchWithRetry(
  url: string,
  label: string,
  init?: RequestInit
): Promise<Response> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= merklFetchConfig.maxRetries) {
    try {
      const response = await merklLimitedFetch(url, init);
      if (response.ok) {
        return response;
      }
      // Only retry on 5xx / gateway errors
      if (response.status >= 500 && response.status < 600 && attempt < merklFetchConfig.maxRetries) {
        const delay = Math.min(
          merklFetchConfig.maxDelayMs,
          merklFetchConfig.baseDelayMs * Math.pow(2, attempt)
        ) + Math.random() * 250;
        logger.warn(`⚠️ ${label} HTTP ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${merklFetchConfig.maxRetries})`);
        await sleep(delay);
        attempt++;
        continue;
      }
      // Non-retryable HTTP error
      return response;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= merklFetchConfig.maxRetries) {
        throw error;
      }
      const delay = Math.min(
        merklFetchConfig.maxDelayMs,
        merklFetchConfig.baseDelayMs * Math.pow(2, attempt)
      ) + Math.random() * 250;
      logger.warn(`⚠️ ${label} network error (${(error as Error).message}), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${merklFetchConfig.maxRetries})`);
      await sleep(delay);
      attempt++;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface MerklCampaignBreakdown {
  campaignApr: number;
  campaignStartedAt: string;
  campaignEndedAt: string;
  campaignId: string;
  whitelistOnly?: boolean;
  distributionType?: string;
  pointsPerThousandUsd?: number; // Tydro 协议的 points/1000USD 值
  dailyPoints?: number; // Tydro 协议的每日 points
}

/**
 * Merkl Opportunity 分组数据（用于 JSON 输出，避免重复）
 * 一个 opportunity 包含一个链接和多个 breakdowns
 */
export interface MerklOpportunityGroup {
  link: string; // Opportunity 链接
  name?: string; // Opportunity 名称
  message?: string; // Opportunity 描述
  breakdowns: MerklCampaignBreakdown[]; // 该 opportunity 的所有 breakdowns
}

// API 响应的完整类型（用于类型断言）
export interface MerklOpportunity {
  id: string;
  name?: string; // opportunity name for market detection
  description?: string; // opportunity description
  action: string; // "LEND" or "BORROW" or "HOLD"
  chainId: number;
  chain?: {
    name: string; // 链名称，用于构建链接（如 "Ethereum", "Plasma"）
  };
  explorerAddress?: string; // 用于索引的地址
  identifier?: string; // 用于构建 Merkl opportunity 链接的标识符
  type?: string; // opportunity 类型，用于构建链接（如 MULTILOG_DUTCH, EULER 等）
  distributionType?: string;
  status?: string; // "LIVE" or other statuses
  tvl?: number; // TVL 值，用于计算 points/1000USD
  protocol?: {
    id: string; // 协议 ID，用于识别 tydro
  };
  tokens?: Array<{
    address: string;
    symbol: string;
    name: string;
    chainId?: number;
    price?: number;
    updatedAt?: number;
  }>; // 可选：处理逻辑中未使用
  rewardsRecord: {
    breakdowns: Array<{
      campaignId: string; // 实际使用的字段
      distributionType?: string;
      distributionMethod?: string;
      value?: number; // points 值，用于 tydro 协议
      token?: {
        address?: string;
        symbol?: string;
        chainId?: number;
        price?: number;
        updatedAt?: number;
      };
      // API 可能返回其他字段，但处理逻辑中未使用
    }>;
  };
  campaigns?: MerklEmbeddedCampaign[];
}

interface MerklEmbeddedCampaign {
  id?: string;
  campaignId?: string;
  startTimestamp?: string | number | bigint;
  endTimestamp?: string | number | bigint;
  apr?: number;
  params?: any;
}

export interface MerklCampaignDetails {
  startedAt: string;
  endedAt: string;
  id: string;
  apr: number;
  whitelistOnly: boolean;
}

const hasEntries = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return Boolean(value);
};

export function isCampaignWhitelistOnly(campaign: any): boolean {
  const topLevelWhitelist = hasEntries(campaign?.params?.whitelist);
  if (topLevelWhitelist) return true;

  const composedCampaigns = campaign?.params?.composedCampaigns;
  if (!Array.isArray(composedCampaigns)) return false;

  return composedCampaigns.some((entry: any) => hasEntries(entry?.campaignParameters?.whitelist));
}

const toIsoFromUnixLike = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const numeric =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string'
        ? Number(value)
        : typeof value === 'number'
          ? value
          : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
};

// Merkl 数据结构：每个 opportunity 存储一次
export interface MerklOpportunityData {
  supply: MerklCampaignBreakdown[];
  borrow: MerklCampaignBreakdown[];
  hold: MerklCampaignBreakdown[];
  marketName: string;
  chainId: number;
  opportunityLink?: string; // Merkl opportunity 详情页链接（内部使用，最终会转换为 link）
  name?: string; // Opportunity 名称
  description?: string; // Opportunity 描述（内部使用，最终会转换为 message）
}

type ForecastCampaignTypeLite =
  | 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'DUTCH_AUCTION'
  | 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE';

interface CampaignSnapshotLiteForForecastFile {
  id: string;
  amount?: unknown;
  startTimestamp?: unknown;
  endTimestamp?: unknown;
  campaignStatus?: {
    computedUntil?: unknown;
  };
  rewardToken?: {
    price?: unknown;
    decimals?: unknown;
  };
  params?: {
    decimalsRewardToken?: unknown;
    distributionMethodParameters?: {
      distributionSettings?: {
        apr?: unknown;
      };
    };
  };
}

interface ForecastCampaignMetaLite {
  tvl: number;
  campaignTypeHint: ForecastCampaignTypeLite;
  distributionTypeRaw: string | null;
  campaignSnapshot: CampaignSnapshotLiteForForecastFile | null;
}

const normalizeForecastCampaignTypeLite = (value: unknown): ForecastCampaignTypeLite | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized.includes('MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE')) {
    return 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  if (normalized.includes('DUTCH_AUCTION')) {
    return 'DUTCH_AUCTION';
  }
  if (normalized.includes('FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE')) {
    return 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  return null;
};

const buildCampaignSnapshotLiteForForecastFile = (campaign: any): CampaignSnapshotLiteForForecastFile | null => {
  const id = typeof campaign?.id === 'string' ? campaign.id : String(campaign?.id || '').trim();
  if (!id) return null;

  const snapshot: CampaignSnapshotLiteForForecastFile = { id };
  if (campaign?.amount !== undefined) snapshot.amount = campaign.amount;
  if (campaign?.startTimestamp !== undefined) snapshot.startTimestamp = campaign.startTimestamp;
  if (campaign?.endTimestamp !== undefined) snapshot.endTimestamp = campaign.endTimestamp;
  if (campaign?.campaignStatus?.computedUntil !== undefined) {
    snapshot.campaignStatus = { computedUntil: campaign.campaignStatus.computedUntil };
  }
  if (campaign?.rewardToken) {
    const rewardToken: CampaignSnapshotLiteForForecastFile['rewardToken'] = {};
    if (campaign.rewardToken.price !== undefined) rewardToken.price = campaign.rewardToken.price;
    if (campaign.rewardToken.decimals !== undefined) rewardToken.decimals = campaign.rewardToken.decimals;
    if (Object.keys(rewardToken).length > 0) snapshot.rewardToken = rewardToken;
  }
  if (campaign?.params) {
    const params: CampaignSnapshotLiteForForecastFile['params'] = {};
    if (campaign.params.decimalsRewardToken !== undefined) {
      params.decimalsRewardToken = campaign.params.decimalsRewardToken;
    }
    const apr = campaign.params?.distributionMethodParameters?.distributionSettings?.apr;
    if (apr !== undefined) {
      params.distributionMethodParameters = { distributionSettings: { apr } };
    }
    if (Object.keys(params).length > 0) snapshot.params = params;
  }
  return snapshot;
};

const buildForecastCampaignMetaLiteMap = (
  opportunities: MerklOpportunity[]
): Record<string, ForecastCampaignMetaLite> => {
  const result: Record<string, ForecastCampaignMetaLite> = {};

  for (const opp of opportunities) {
    const tvl = Number(opp?.tvl);
    if (!Number.isFinite(tvl) || tvl < 0) continue;

    const breakdowns = opp?.rewardsRecord?.breakdowns;
    if (!Array.isArray(breakdowns) || breakdowns.length === 0) continue;

    const campaignSnapshotById = new Map<string, CampaignSnapshotLiteForForecastFile>();
    if (Array.isArray(opp.campaigns)) {
      for (const campaign of opp.campaigns) {
        const snapshot = buildCampaignSnapshotLiteForForecastFile(campaign);
        if (snapshot) campaignSnapshotById.set(snapshot.id, snapshot);
      }
    }

    for (const breakdown of breakdowns) {
      const campaignId = String(breakdown?.campaignId || '').trim();
      if (!campaignId) continue;

      const rawType =
        (typeof breakdown?.distributionType === 'string' && breakdown.distributionType) ||
        (typeof breakdown?.distributionMethod === 'string' && breakdown.distributionMethod) ||
        (typeof opp?.distributionType === 'string' && opp.distributionType) ||
        null;

      const campaignTypeHint = normalizeForecastCampaignTypeLite(rawType);
      if (!campaignTypeHint) continue;

      const existing = result[campaignId];
      const campaignSnapshot = campaignSnapshotById.get(campaignId) ?? null;

      if (!existing) {
        result[campaignId] = {
          tvl,
          campaignTypeHint,
          distributionTypeRaw: rawType,
          campaignSnapshot,
        };
        continue;
      }

      result[campaignId] = {
        tvl: existing.tvl > 0 ? existing.tvl : tvl,
        campaignTypeHint: existing.campaignTypeHint,
        distributionTypeRaw: existing.distributionTypeRaw ?? rawType,
        campaignSnapshot: existing.campaignSnapshot ?? campaignSnapshot,
      };
    }
  }

  return result;
};

/**
 * 获取 Merkl opportunities（使用 mainProtocolId 参数，返回 Aave 和 Tydro 相关的数据）
 */
export async function fetchMerklOpportunities(): Promise<MerklOpportunity[]> {
  try {
    logger.info('🔄 Fetching Merkl opportunities for Aave + Tydro (LIVE, campaigns=true, short-page pagination)...');
    const allOpportunities = (await fetchMerklOpportunitiesSnapshot({
      baseUrl: 'https://api.merkl.xyz/v4',
      ttlMs: OPPORTUNITIES_CACHE_TTL_MS,
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    })) as MerklOpportunity[];
    logger.info(`✅ Fetched ${allOpportunities.length} live opportunities from Merkl`);
    return allOpportunities;
  } catch (error) {
    logger.error('❌ Error fetching Merkl opportunities:', error);
    return [];
  }
}

/**
 * 获取 Merkl campaign 详情
 * In https://api.merkl.xyz/v4/opportunities?mainProtocolId=aave api, onChainCampaignId = Campaign ID in webpage, campaignId = Database ID in web page. 
 * https://api.merkl.xyz/v4/campaigns/${campaignId} use the second one Database ID as input parameter, but in response, their campaignId equals to the first one onChainCampaignId
 */
export async function fetchMerklCampaignDetails(campaignId: string): Promise<MerklCampaignDetails | null> {
  try {
    const response = await fetchWithRetry(
      `https://api.merkl.xyz/v4/campaigns/${campaignId}`,
      `Merkl campaign ${campaignId}`
    );
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const campaign = await response.json() as any;
    
    // 将 timestamp 转换为日期字符串
    const startedAt = campaign.startTimestamp ? 
      new Date(campaign.startTimestamp * 1000).toISOString() : 
      '';
    const endedAt = campaign.endTimestamp ? 
      new Date(campaign.endTimestamp * 1000).toISOString() : 
      '';
    
    return {
      startedAt,
      endedAt,
      id: campaignId,
      apr: campaign.apr || 0,
      whitelistOnly: isCampaignWhitelistOnly(campaign),
    };
  } catch (error) {
    logger.error(`❌ Error fetching campaign ${campaignId}:`, error);
    return null;
  }
}

/**
 * 生成 Merkl opportunity 详情页链接
 * 格式：https://app.merkl.xyz/opportunities/{chainName}/{type}/{identifier}
 * 
 * @param opportunity Merkl opportunity 对象
 * @returns Merkl opportunity 详情页的完整 URL，如果缺少必要字段则返回 null
 */
export function generateMerklOpportunityLink(opportunity: MerklOpportunity): string | null {
  // 需要 identifier、type 和 chain.name 字段来构建链接
  if (!opportunity.identifier || !opportunity.type || !opportunity.chain?.name) {
    return null;
  }
  
  // 将链名称转换为小写（Merkl URL 使用小写链名称）
  const chainName = opportunity.chain.name.toLowerCase();
  const baseUrl = 'https://app.merkl.xyz';
  const link = `${baseUrl}/opportunities/${chainName}/${opportunity.type}/${opportunity.identifier}`;
  
  return link;
}

/**
 * 从 Merkl opportunity name 解析对应的 Aave market name
 * 规则：
 * - 如果 name 包含 "horizon" → AaveV3EthereumHorizon
 * - 如果 name 包含 "prime" → AaveV3EthereumLido
 * - 如果 name 包含 "EtherFi" → AaveV3EthereumEtherFi
 * - 如果都不包含 → AaveV3Ethereum (默认)
 */
export function parseMarketNameFromOpportunityName(opportunityName: string | undefined, chainId: number): string {
  if (!opportunityName) {
    // 如果没有 name，根据 chainId 返回默认值
    return chainId === 1 ? 'AaveV3Ethereum' : 'Unknown';
  }
  
  const nameLower = opportunityName.toLowerCase();
  
  // 只对 chainId 1 (Ethereum) 进行特殊市场解析
  if (chainId === 1) {
    if (nameLower.includes('horizon')) {
      return 'AaveV3EthereumHorizon';
    } else if (nameLower.includes('prime')) {
      return 'AaveV3EthereumLido';
    } else if (nameLower.includes('etherfi')) {
      return 'AaveV3EthereumEtherFi';
    } else {
      return 'AaveV3Ethereum';
    }
  }
  
  // 对于其他 chainId，返回默认值（可以根据需要扩展）
  return 'Unknown';
}


/**
 * 处理 Merkl 数据，构建索引并返回
 * Merkl 索引：explorerAddress -> opportunities
 * 对于 chainId === 1，使用 marketName-chainId-explorerAddress 作为 key
 * 对于其他 chainId，使用 chainId-explorerAddress 作为 key
 */
export async function processMerklData(): Promise<{ index: Record<string, MerklOpportunityData[]> }> {
  const opportunities = await fetchMerklOpportunities();
  const merklData: Record<string, MerklOpportunityData[]> = {};
  logger.info('🔍 Processing Merkl opportunities...');
  // fetchMerklOpportunities 已在 API 层过滤 status=LIVE
  const liveOpportunities = opportunities;
  const tydroCount = liveOpportunities.filter(opp => opp.protocol?.id === 'tydro').length;
  const aaveCount = liveOpportunities.length - tydroCount;
  logger.info(`Processing ${liveOpportunities.length} live opportunities (${aaveCount} Aave, ${tydroCount} Tydro)`);
  
  const campaignDetailsCache = new Map<string, MerklCampaignDetails | null>();
  for (const opp of liveOpportunities) {
    if (!Array.isArray(opp.campaigns)) continue;
    opp.campaigns.forEach((campaign) => {
      const id = String(campaign.id || '').trim();
      if (!id) return;
      if (campaignDetailsCache.has(id)) return;
      campaignDetailsCache.set(id, {
        startedAt: toIsoFromUnixLike(campaign.startTimestamp),
        endedAt: toIsoFromUnixLike(campaign.endTimestamp),
        id,
        apr: Number(campaign.apr || 0),
        whitelistOnly: isCampaignWhitelistOnly(campaign),
      });
    });
  }

  // 补拉少量未在 opportunities.campaigns 出现的 campaign（兼容上游数据缺口）
  const missingCampaignIds = new Set<string>();
  for (const opp of liveOpportunities) {
    if (!opp.rewardsRecord?.breakdowns) continue;
    for (const breakdown of opp.rewardsRecord.breakdowns) {
      const id = String(breakdown.campaignId || '').trim();
      if (!id) continue;
      if (!campaignDetailsCache.has(id)) {
        missingCampaignIds.add(id);
      }
    }
  }

  if (missingCampaignIds.size > 0) {
    logger.info(`📦 Fetching ${missingCampaignIds.size} missing campaign details (fallback)...`);
    const campaignPromises = Array.from(missingCampaignIds).map(async (campaignId) => {
      const details = await fetchMerklCampaignDetails(campaignId);
      campaignDetailsCache.set(campaignId, details);
      return { campaignId, details };
    });
    await Promise.all(campaignPromises);
  }
  logger.info(`✅ Campaign details cache ready: ${campaignDetailsCache.size} items`);
  
  // 处理所有 live opportunities（现在可以快速从缓存中获取数据）
  for (const opp of liveOpportunities) {
    if (!opp.explorerAddress) {
      logger.warn(`   ⚠️ No explorerAddress found for opportunity ${opp.id}`);
      continue;
    }
    
    // 检查是否是 tydro 协议
    const isTydro = opp.protocol?.id === 'tydro';
    
    // 只有在 chainId === 1 时才需要解析 marketName
    const marketName = opp.chainId === 1 
      ? parseMarketNameFromOpportunityName(opp.name, opp.chainId)
      : 'Unknown';
    const explorerAddress = opp.explorerAddress.toLowerCase();
    
    // 生成 Merkl opportunity 链接（在 if-else 之前生成，以便在外部使用）
    const opportunityLink = generateMerklOpportunityLink(opp);
    
    if (!opportunityLink) {
      logger.warn(`   ⚠️ Could not generate link for opportunity ${opp.id}: missing identifier, type, or chain.name`);
    }
    
    // 处理 campaign breakdowns（从缓存中快速获取）
    const breakdowns: MerklCampaignBreakdown[] = [];
    
    if (isTydro) {
      // Tydro 协议特殊处理：逐条 breakdown 记录 points 信息（APR 由前端计算）
      const tvl = Number(opp.tvl) || 0;

      for (const rewardsBreakdown of opp.rewardsRecord.breakdowns) {
        if (rewardsBreakdown.value === undefined) {
          continue;
        }

        const dailyPoints = Number(rewardsBreakdown.value);
        const pointsPerThousandUsd = tvl > 0 ? (dailyPoints / tvl) * 1000 : 0;

        // 对于 tydro，我们需要从 campaign details 获取时间信息，如果没有则使用默认值
        const campaignDetails = rewardsBreakdown.campaignId
          ? campaignDetailsCache.get(rewardsBreakdown.campaignId)
          : null;

        breakdowns.push({
          campaignApr: 0,
          campaignStartedAt: campaignDetails?.startedAt || '',
          campaignEndedAt: campaignDetails?.endedAt || '',
          campaignId: rewardsBreakdown.campaignId || opp.id,
          whitelistOnly: campaignDetails?.whitelistOnly || false,
          distributionType:
            rewardsBreakdown.distributionType || rewardsBreakdown.distributionMethod || opp.distributionType,
          pointsPerThousandUsd: pointsPerThousandUsd,
          dailyPoints: dailyPoints
        });
      }

      if (breakdowns.length > 0) {
        const totalDailyPoints = breakdowns.reduce((sum, b) => sum + (b.dailyPoints || 0), 0);
        logger.info(`   📊 Tydro opportunity ${opp.id}: ${breakdowns.length} breakdown(s), total daily points: ${totalDailyPoints}, TVL: ${tvl}`);
      }
    } else {
      // Aave 协议：使用原有的处理逻辑
      for (const rewardBreakdown of opp.rewardsRecord.breakdowns) {
        const campaignDetails = campaignDetailsCache.get(rewardBreakdown.campaignId);
        if (campaignDetails) {
          breakdowns.push({
            campaignApr: campaignDetails.apr,
            campaignStartedAt: campaignDetails.startedAt,
            campaignEndedAt: campaignDetails.endedAt,
            campaignId: rewardBreakdown.campaignId,
            whitelistOnly: campaignDetails.whitelistOnly,
            distributionType:
              rewardBreakdown.distributionType || rewardBreakdown.distributionMethod || opp.distributionType
          });
        }
      }
    }

    // 过滤掉已过期的 campaign，只保留当前进行中和未来的 campaign
    const filteredBreakdowns = filterExpiredCampaigns(breakdowns);

    // 记录过滤情况
    if (breakdowns.length > filteredBreakdowns.length) {
      const expiredCount = breakdowns.length - filteredBreakdowns.length;
      logger.info(`   🗑️ Filtered out ${expiredCount} expired campaign(s) for opportunity ${opp.id}`);
    }

    // 如果过滤后没有有效的 campaign，跳过这个 opportunity
    if (filteredBreakdowns.length === 0) {
      logger.info(`   ⏭️ Skipping opportunity ${opp.id}: all campaigns expired`);
      continue;
    }

    // 创建 opportunity 数据对象，根据 action 直接设置对应数组
    const opportunityData: MerklOpportunityData = {
      supply: opp.action === 'LEND' ? filteredBreakdowns : [],
      borrow: opp.action === 'BORROW' ? filteredBreakdowns : [],
      hold: opp.action === 'HOLD' ? filteredBreakdowns : [],
      marketName,
      chainId: opp.chainId,
      ...(opportunityLink && { opportunityLink }),
      ...(opp.name && { name: opp.name }),
      ...(opp.description && { description: opp.description })
    };
    
    // 创建索引键并添加到索引
    // 只有 chainId === 1 时才在索引键中包含 marketName
    const indexKey = opp.chainId === 1
      ? `${marketName}-${opp.chainId}-${explorerAddress}`
      : `${opp.chainId}-${explorerAddress}`;
    
    if (!merklData[indexKey]) {
      merklData[indexKey] = [];
    }
    merklData[indexKey]!.push(opportunityData);
  }
  
  // 从索引中提取所有 opportunities 用于保存
  const processedData = Object.values(merklData).flat();
  const forecastCampaignMetaLite = buildForecastCampaignMetaLiteMap(liveOpportunities);
  
  logger.info(`✅ Processed ${processedData.length} Merkl opportunities`);
  logger.info(`📊 Created index with ${Object.keys(merklData).length} token keys`);
  
  // 保存 Merkl 原始数据
  await mkdir(DEBUG_DATA_DIR, { recursive: true });
  const merklRawDataPath = join(DEBUG_DATA_DIR, 'merkl-raw-data.json');
  await writeJsonAtomic(merklRawDataPath, {
    timestamp: new Date().toISOString(),
    rawOpportunities: opportunities, // 保存所有原始数据（包括非 live 的）
    liveOpportunities: liveOpportunities, // 保存过滤后的 live opportunities
    processedData,
    index: merklData
  });
  logger.info(`💾 Merkl raw data saved to ${merklRawDataPath}`);

  const merklForecastLitePath = join(RUNTIME_DATA_DIR, 'merkl-opportunity-meta-lite.json');
  await writeJsonAtomic(merklForecastLitePath, {
    timestamp: new Date().toISOString(),
    campaigns: forecastCampaignMetaLite,
  }, { space: 0 });
  logger.info(`💾 Merkl forecast lite data saved to ${merklForecastLitePath}`);
  
  return { index: merklData };
}

/**
 * 过滤掉已过期的 campaign，保留当前进行中和未来的 campaign
 * - 过滤掉：campaignEndedAt < 当前时间（已过期）
 * - 保留：campaignEndedAt >= 当前时间（进行中或未来）
 */
export function filterExpiredCampaigns(breakdowns: MerklCampaignBreakdown[]): MerklCampaignBreakdown[] {
  const now = new Date();
  return breakdowns.filter(breakdown => {
    // 如果没有结束时间，保留（可能是无限期的 campaign）
    if (!breakdown.campaignEndedAt) {
      return true;
    }
    const endTime = new Date(breakdown.campaignEndedAt);
    // 只保留尚未过期的 campaign（endTime >= now）
    return endTime >= now;
  });
}

/**
 * 根据 token 地址查找匹配的 Merkl opportunities
 */
export function findMatchingMerklOpportunities(
  item: { chainId: number; marketName: string; tokenAddress: string; aTokenAddress: string | null; vTokenAddress: string | null },
  merklData: Record<string, MerklOpportunityData[]>
): MerklOpportunityData[] {
  const matchedOpportunities: MerklOpportunityData[] = [];
  const seenOpportunities = new Set<MerklOpportunityData>();
  
  // 构建要检查的 token 地址列表（按优先级：underlying → aToken → vToken）
  const tokenAddressesToCheck: string[] = [
    item.tokenAddress.toLowerCase(),
    item.aTokenAddress?.toLowerCase(),
    item.vTokenAddress?.toLowerCase()
  ].filter((addr): addr is string => addr !== null && addr !== undefined);
  
  // 检查每个地址是否在索引中
  for (const tokenAddr of tokenAddressesToCheck) {
    const indexKey = item.chainId === 1
      ? `${item.marketName}-${item.chainId}-${tokenAddr}`
      : `${item.chainId}-${tokenAddr}`;
    
    const matchingOpportunities = merklData[indexKey];
    if (matchingOpportunities?.length > 0) {
      for (const opp of matchingOpportunities) {
        if (!seenOpportunities.has(opp)) {
          seenOpportunities.add(opp);
          matchedOpportunities.push(opp);
        }
      }
    }
  }
  
  return matchedOpportunities;
}

/**
 * 格式化 Merkl campaign breakdown 为字符串（用于 CSV）
 * 字段顺序：campaignApr, campaignStartedAt, campaignEndedAt, campaignId
 * 
 * 按 opportunity 分组显示，每个 opportunity 的 breakdowns 后跟其对应的链接
 * 格式：breakdown1; breakdown2, link1; breakdown3; breakdown4, link2
 * 
 * @param breakdowns Merkl campaign breakdowns 数组（用于 CSV 时，每个 breakdown 可能包含 opportunityLink 属性）
 */
export function formatMerklBreakdown(breakdowns: Array<MerklCampaignBreakdown & { opportunityLink?: string }>): string {
  if (breakdowns.length === 0) {
    return '';
  }
  
  // 按 opportunityLink 分组
  const groupedByLink = new Map<string, Array<MerklCampaignBreakdown & { opportunityLink?: string }>>();
  const noLinkBreakdowns: Array<MerklCampaignBreakdown & { opportunityLink?: string }> = [];
  
  for (const b of breakdowns) {
    if (b.opportunityLink) {
      if (!groupedByLink.has(b.opportunityLink)) {
        groupedByLink.set(b.opportunityLink, []);
      }
      groupedByLink.get(b.opportunityLink)!.push(b);
    } else {
      noLinkBreakdowns.push(b);
    }
  }
  
  // 格式化每个分组的 breakdowns
  const formatBreakdown = (b: MerklCampaignBreakdown): string => {
    let startDate = 'N/A';
    if (b.campaignStartedAt) {
      const date = new Date(b.campaignStartedAt);
      startDate = date.toLocaleString('en-US', { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
      });
    }
    let endDate = 'N/A';
    if (b.campaignEndedAt) {
      const date = new Date(b.campaignEndedAt);
      endDate = date.toLocaleString('en-US', { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
      });
    }
    return `${b.campaignApr}% (${startDate} - ${endDate}, ${b.campaignId})`;
  };
  
  // 构建分组后的字符串
  const parts: string[] = [];
  
  // 处理有链接的分组：每个分组的 breakdowns 后跟其链接
  for (const [link, groupBreakdowns] of groupedByLink.entries()) {
    const breakdownsStr = groupBreakdowns.map(formatBreakdown).join('; ');
    parts.push(`${breakdownsStr}, ${link}`);
  }
  
  // 处理没有链接的 breakdowns
  if (noLinkBreakdowns.length > 0) {
    parts.push(noLinkBreakdowns.map(formatBreakdown).join('; '));
  }
  
  return parts.join('; ');
}
