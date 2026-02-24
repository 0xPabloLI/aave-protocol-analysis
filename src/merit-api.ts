import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { mkdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { writeJsonAtomic } from './file-utils.js';
import {
  extractCampaignInfoWithWorker,
  extractMeritDynamicInfoWithWorker,
  extractSelfAuthenticationDescriptionWithCloudflare,
  type MeritDynamicInfo,
} from './cloudflare-browser.js';
import { meritKeyAliases } from './config.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const MERKL_BASE_URL = 'https://api.merkl.xyz/v4';
const MERIT_ROUND_ESTIMATE_MAX_PAGES = 12;
const MERIT_ROUND_POST_END_REFRESH_MS = 24 * 60 * 60 * 1000;
const MERIT_TIMERANGES_CACHE_PATH = join(DATA_DIR, 'merit-timeranges-cache.json');

export interface MeritAPRResponse {
  previousAPR: any;
  currentAPR: {
    actionsAPR: Record<string, number | null>;
  };
}

// Campaign info 消息项（从 Campaign info 弹窗表格中提取）
export interface MeritCampaignInfo {
  action?: string; // Action 描述（如 "Supply USDC"）
  description?: string; // Description 文本（如 "Rewards are distributed using the following formula: ..."）
}

// Merit APR 条目（扁平化结构，timeRange 直接作为字段）
export interface MeritAprEntry {
  apr: number; // APR 百分比值（如 5.2 表示 5.2%）
  selfApr?: number; // Self APR 百分比值（如果有对应的 self- 前缀的 key）
  link: string;
  startDate: string;
  endDate: string;
  startBlock?: string; // 开始区块号（用于判断 campaign 是否结束）
  endBlock?: string; // 结束区块号（用于判断 campaign 是否结束）
  name?: string; // Campaign 名称（如 "Supply (Celo or ETH) and borrow USDT"）
  message?: MeritCampaignInfo[]; // Campaign 信息数组（从 Campaign info 弹窗表格中提取，可能有多条 action 和 description）
  requiredBorrowTokens?: string[]; // 需要 borrow 的 token 列表（用于 supply with borrow requirement）
  requiredSupplyTokens?: string[]; // 需要 supply 的 token 列表（用于 borrow with supply requirement）
  lastRoundRewardUsd?: number; // 最近一轮 Merkl JSON_AIRDROP 总奖励（USD）
}

// Merit 数据项结构（简化：只保留 supply 和 borrow）
export interface MeritDataItem {
  meritSupplys: MeritAprEntry[];
  meritBorrows: MeritAprEntry[];
}

type MeritAction = 'supply' | 'borrow';

interface MeritRoundEstimateBase {
  latestAmountUsd: number;
  latestCampaignId: string;
}

interface MeritRoundEstimateTarget {
  cycleEndTsMs: number | null;
}

interface MeritRoundEstimateCacheEntry {
  estimate: MeritRoundEstimateBase | null;
  lastCheckedAtMs: number;
}

interface MeritRoundEstimateFetchMeta {
  requestTemplateUrl: string;
  firstPageUrl: string;
  pagesScanned: number;
  hitCacheOnly: boolean;
}

let meritRoundEstimateCache:
  | Map<string, MeritRoundEstimateCacheEntry>
  | null = null;
let meritRoundEstimateLastFetchMeta: MeritRoundEstimateFetchMeta | null = null;

const toIsoOrNull = (value: number | null | undefined): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
};

const CHAIN_KEY_TO_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  'ethereum-prime': 1,
  'ethereum-horizon': 1,
  'ethereum-etherfi': 1,
  optimism: 10,
  polygon: 137,
  arbitrum: 42161,
  base: 8453,
  avalanche: 43114,
  gnosis: 100,
  bnb: 56,
  scroll: 534352,
  zksync: 324,
  linea: 59144,
  sonic: 146,
  celo: 42220,
};

const normalizeTokenSymbolForMatching = (token: string): string => {
  const raw = token
    .toLowerCase()
    .replace(/₮/g, 't')
    .replace(/[^a-z0-9]/g, '');
  if (!raw) return raw;

  const aliasMap: Record<string, string> = {
    usdte: 'usdt',
    usdt0: 'usdt',
    usdc0: 'usdc',
  };
  return aliasMap[raw] ?? raw;
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const parseMeritEndDateToMs = (value: string | undefined): number | null => {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isFinite(ts)) return ts;
  return null;
};

const buildMeritRoundKey = (chainId: number, action: MeritAction, token: string): string =>
  `${chainId}:${action}:${normalizeTokenSymbolForMatching(token)}`;

const extractActionTokenPairs = (text: string): Array<{ action: MeritAction; token: string }> => {
  const pairs: Array<{ action: MeritAction; token: string }> = [];
  const seen = new Set<string>();
  const normalizedText = text.toLowerCase();
  const patterns = [
    /(supply|borrow)\s+([a-z0-9₮.$-]+)/gi,
    /(supply|borrow)-([a-z0-9₮.$-]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of normalizedText.matchAll(pattern)) {
      const action = match[1] as MeritAction;
      const tokenRaw = match[2];
      if (!tokenRaw || tokenRaw === 'multiple') continue;
      const token = normalizeTokenSymbolForMatching(tokenRaw);
      if (!token) continue;
      const key = `${action}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ action, token });
    }
  }

  return pairs;
};

const extractAirdropAmountUsd = (campaign: any): number | null => {
  const rawAmount = campaign?.amount;
  const amount = toFiniteNumber(rawAmount);
  if (amount === null || amount <= 0) return null;

  const decimals =
    toFiniteNumber(campaign?.rewardToken?.decimals) ??
    toFiniteNumber(campaign?.params?.decimalsRewardToken) ??
    0;
  const price = toFiniteNumber(campaign?.rewardToken?.price);
  if (price === null || price <= 0) return null;

  let normalizedAmount = amount;
  if (typeof rawAmount === 'string' && !rawAmount.includes('.')) {
    normalizedAmount = amount / Math.pow(10, Math.max(decimals, 0));
  }
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) return null;

  const amountUsd = normalizedAmount * price;
  return Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : null;
};

const shouldRefreshMeritRoundEstimate = (
  _target: MeritRoundEstimateTarget,
  cacheEntry: MeritRoundEstimateCacheEntry | undefined,
  nowMs: number
): boolean => {
  if (!cacheEntry) return true;

  return nowMs - cacheEntry.lastCheckedAtMs >= MERIT_ROUND_POST_END_REFRESH_MS;
};

const fetchMeritRoundEstimates = async (
  targets?: Map<string, MeritRoundEstimateTarget>
): Promise<Map<string, MeritRoundEstimateBase>> => {
  const nowMs = Date.now();
  const paramsTemplate = new URLSearchParams({
    status: 'PAST',
    type: 'JSON_AIRDROP',
    campaigns: 'true',
    order: 'desc',
    items: '100',
    page: '{page}',
  });
  const requestTemplateUrl = `${MERKL_BASE_URL}/opportunities?${paramsTemplate.toString()}`;
  const firstPageUrl = requestTemplateUrl.replace('page=%7Bpage%7D', 'page=0');
  let pagesScanned = 0;
  const cache = meritRoundEstimateCache ?? new Map<string, MeritRoundEstimateCacheEntry>();
  if (!meritRoundEstimateCache) {
    meritRoundEstimateCache = cache;
  }

  const targetEntries = targets && targets.size > 0 ? Array.from(targets.entries()) : [];
  const keysToFetch = new Set<string>(
    targetEntries
      .filter(([key, target]) => shouldRefreshMeritRoundEstimate(target, cache.get(key), nowMs))
      .map(([key]) => key)
  );

  // If every target key is still in freeze / pre-end window, return cached estimates directly.
  if (targetEntries.length > 0 && keysToFetch.size === 0) {
    meritRoundEstimateLastFetchMeta = {
      requestTemplateUrl,
      firstPageUrl,
      pagesScanned: 0,
      hitCacheOnly: true,
    };
    const cachedResult = new Map<string, MeritRoundEstimateBase>();
    targetEntries.forEach(([key]) => {
      const cached = cache.get(key);
      if (cached?.estimate) cachedResult.set(key, cached.estimate);
    });
    return cachedResult;
  }

  const fetchedEstimates = new Map<string, MeritRoundEstimateBase>();
  const unresolvedTargets = keysToFetch.size > 0 ? new Set(keysToFetch) : null;

  for (let page = 0; page < MERIT_ROUND_ESTIMATE_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      status: 'PAST',
      type: 'JSON_AIRDROP',
      campaigns: 'true',
      order: 'desc',
      items: '100',
      page: String(page),
    });
    const response = await fetch(`${MERKL_BASE_URL}/opportunities?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Merkl opportunities failed (${response.status})`);
    }
    const payload = (await response.json()) as any;
    if (!Array.isArray(payload)) break;
    pagesScanned += 1;

    for (const opportunity of payload) {
      const opportunityId = String(opportunity?.id ?? '');
      if (!opportunityId) continue;

      const chainId = toFiniteNumber(opportunity?.chainId);
      if (chainId === null || chainId <= 0) continue;

      const campaigns = Array.isArray(opportunity?.campaigns) ? opportunity.campaigns : [];
      if (campaigns.length === 0) continue;

      for (const campaign of campaigns) {
        const creatorId = campaign?.creator?.creatorId;
        const creatorTags = Array.isArray(campaign?.creator?.tags) ? campaign.creator.tags : [];
        if (creatorId !== 'aave' && !creatorTags.includes('aave')) continue;

        const amountUsd = extractAirdropAmountUsd(campaign);
        if (amountUsd === null) continue;

        const startTimestamp = toFiniteNumber(campaign?.startTimestamp);
        const endTimestamp = toFiniteNumber(campaign?.endTimestamp);
        if (startTimestamp === null || endTimestamp === null || endTimestamp <= startTimestamp) continue;

        const campaignId = String(campaign?.id ?? '');
        if (!campaignId) continue;

        const textSources = Array.from(
          new Set(
            [
          opportunity?.name,
          campaign?.params?.url,
            ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          )
        );

        const pairs = textSources.flatMap((text) => extractActionTokenPairs(text));
        if (pairs.length === 0) continue;

        pairs.forEach(({ action, token }) => {
          const key = buildMeritRoundKey(chainId, action, token);
          if (targets && !targets.has(key)) return;
          if (keysToFetch.size > 0 && !keysToFetch.has(key)) return;
          if (fetchedEstimates.has(key)) return;

          fetchedEstimates.set(key, {
            latestAmountUsd: amountUsd,
            latestCampaignId: campaignId,
          });

          if (unresolvedTargets?.has(key)) {
            unresolvedTargets.delete(key);
          }
        });
      }
    }

    if (payload.length < 100) break;
    if (unresolvedTargets && unresolvedTargets.size === 0) break;
  }

  // Update per-key cache entries (including negative-cache timestamps for misses).
  targetEntries.forEach(([key]) => {
    const previous = cache.get(key);
    const fetched = fetchedEstimates.get(key);

    if (!fetched) {
      if (keysToFetch.has(key)) {
        cache.set(key, {
          estimate: previous?.estimate ?? null,
          lastCheckedAtMs: nowMs,
        });
      }
      return;
    }

    cache.set(key, {
      estimate: fetched,
      lastCheckedAtMs: nowMs,
    });
  });

  const result = new Map<string, MeritRoundEstimateBase>();
  meritRoundEstimateLastFetchMeta = {
    requestTemplateUrl,
    firstPageUrl,
    pagesScanned,
    hitCacheOnly: false,
  };
  if (targetEntries.length > 0) {
    targetEntries.forEach(([key]) => {
      const cached = cache.get(key);
      if (cached?.estimate) result.set(key, cached.estimate);
    });
    return result;
  }

  // fallback: no targets provided, return freshly fetched set
  return fetchedEstimates;
};

const getMeritEstimateForEntry = (
  estimates: Map<string, MeritRoundEstimateBase>,
  chainKey: string,
  action: MeritAction,
  token: string
): Partial<MeritAprEntry> | undefined => {
  const chainId = CHAIN_KEY_TO_CHAIN_ID[chainKey.toLowerCase()];
  if (!chainId) return undefined;

  const estimate = estimates.get(buildMeritRoundKey(chainId, action, token));
  if (!estimate) return undefined;

  return {
    lastRoundRewardUsd: estimate.latestAmountUsd,
  };
};

const serializeMeritRoundEstimateTargets = (
  targets: Map<string, MeritRoundEstimateTarget>
): Record<string, { cycleEndTsMs: number | null; cycleEndIso: string | null }> => {
  const serialized: Record<string, { cycleEndTsMs: number | null; cycleEndIso: string | null }> = {};
  for (const [key, target] of targets.entries()) {
    serialized[key] = {
      cycleEndTsMs: target.cycleEndTsMs,
      cycleEndIso: toIsoOrNull(target.cycleEndTsMs),
    };
  }
  return serialized;
};

const serializeMeritRoundEstimates = (
  estimates: Map<string, MeritRoundEstimateBase>
): Record<string, { lastRoundRewardUsd: number; lastRoundCampaignId: string }> => {
  const serialized: Record<string, { lastRoundRewardUsd: number; lastRoundCampaignId: string }> = {};
  for (const [key, estimate] of estimates.entries()) {
    serialized[key] = {
      lastRoundRewardUsd: estimate.latestAmountUsd,
      lastRoundCampaignId: estimate.latestCampaignId,
    };
  }
  return serialized;
};

const serializeMeritRoundEstimateCache = () => {
  if (!meritRoundEstimateCache) return {};

  const serialized: Record<
    string,
    {
      lastRoundRewardUsd: number | null;
      lastRoundCampaignId: string | null;
      lastCheckedAtMs: number;
      lastCheckedAtIso: string | null;
      miss: boolean;
    }
  > = {};

  for (const [key, entry] of meritRoundEstimateCache.entries()) {
    serialized[key] = {
      lastRoundRewardUsd: entry.estimate?.latestAmountUsd ?? null,
      lastRoundCampaignId: entry.estimate?.latestCampaignId ?? null,
      lastCheckedAtMs: entry.lastCheckedAtMs,
      lastCheckedAtIso: toIsoOrNull(entry.lastCheckedAtMs),
      miss: entry.estimate === null,
    };
  }

  return serialized;
};

/**
 * 解析链名，处理特殊情况如 ethereum-prime
 */
export function parseChainKey(parts: string[]): string {
  // 注意：传入的 parts 已经移除了 self- 前缀
  if (parts.length >= 2 && parts[0] === 'ethereum' && parts[1] !== 'supply' && parts[1] !== 'borrow') {
    // ethereum-xxx 格式：ethereum-xxx-action-token (xxx 不是 supply 或 borrow)
    return `ethereum-${parts[1]}`;
  } else {
    // 标准格式：chain-action-token
    return parts[0];
  }
}

/**
 * 根据链名获取 RPC URL
 */
function getRpcUrlsFromChainName(chainName: string): string[] {
  const prodRpcConfig: Record<string, { publicJsonRPCUrl: string[] }> = {
    ethereum: {
      publicJsonRPCUrl: [
        'https://mainnet.gateway.tenderly.co',
        'https://rpc.flashbots.net',
        'https://eth.llamarpc.com',
        'https://eth-mainnet.public.blastapi.io',
        'https://ethereum-rpc.publicnode.com',
      ],
    },
    polygon: {
      publicJsonRPCUrl: [
        'https://gateway.tenderly.co/public/polygon',
        'https://polygon-pokt.nodies.app',
        'https://polygon-bor-rpc.publicnode.com',
        'https://polygon-rpc.com',
        'https://polygon-mainnet.public.blastapi.io',
        'https://rpc-mainnet.matic.quiknode.pro',
      ],
    },
    avalanche: {
      publicJsonRPCUrl: [
        'https://api.avax.network/ext/bc/C/rpc',
        'https://ava-mainnet.public.blastapi.io/ext/bc/C/rpc',
        'https://rpc.ankr.com/avalanche',
      ],
    },
    arbitrum: {
      publicJsonRPCUrl: [
        'https://arb1.arbitrum.io/rpc',
        'https://rpc.ankr.com/arbitrum',
        'https://1rpc.io/arb',
      ],
    },
    base: {
      publicJsonRPCUrl: [
        'https://1rpc.io/base',
        'https://base.llamarpc.com',
        'https://base.publicnode.com',
        'https://base-mainnet.public.blastapi.io',
      ],
    },
    optimism: {
      publicJsonRPCUrl: [
        'https://public-op-mainnet.fastnode.io',
        'https://optimism-rpc.publicnode.com',
      ],
    },
    metis: {
      publicJsonRPCUrl: ['https://andromeda.metis.io/?owner=1088'],
    },
    gnosis: {
      publicJsonRPCUrl: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com'],
    },
    bnb: {
      publicJsonRPCUrl: ['https://bsc.publicnode.com', 'wss://bsc.publicnode.com'],
    },
    scroll: {
      publicJsonRPCUrl: ['https://rpc.scroll.io', 'https://rpc.ankr.com/scroll'],
    },
    zksync: {
      publicJsonRPCUrl: ['https://mainnet.era.zksync.io'],
    },
    linea: {
      publicJsonRPCUrl: [
        'https://1rpc.io/linea',
        'https://linea.drpc.org',
        'https://linea-rpc.publicnode.com',
      ],
    },
    sonic: {
      publicJsonRPCUrl: [
        'https://rpc.soniclabs.com',
        'https://sonic.drpc.org',
        'https://sonic-rpc.publicnode.com',
      ],
    },
    celo: {
      publicJsonRPCUrl: ['https://rpc.ankr.com/celo', 'https://celo.drpc.org'],
    },
    soneium: {
      publicJsonRPCUrl: ['https://soneium.drpc.org', 'https://rpc.soneium.org'],
    },
    plasma: {
      publicJsonRPCUrl: ['https://rpc.plasma.to'],
    },
    ink: {
      publicJsonRPCUrl: ['https://ink.drpc.org'],
    },
  };

  const chainAliases: Record<string, string> = {
    'ethereum-etherfi': 'ethereum',
    'ethereum-prime': 'ethereum',
    'ethereum-horizon': 'ethereum',
    'arbitrum-one': 'arbitrum',
    'xdai': 'gnosis',
    'bsc': 'bnb',
    'binance': 'bnb',
  };

  const normalized = chainName.toLowerCase();
  const mappedChain = chainAliases[normalized] ?? normalized;
  const urls = prodRpcConfig[mappedChain]?.publicJsonRPCUrl ?? [];
  return urls.filter((url) => url.startsWith('http://') || url.startsWith('https://'));
}

/**
 * 获取当前区块号（用于判断 campaign 是否结束）
 */
async function getCurrentBlockNumber(chainName: string): Promise<number | null> {
  try {
    const rpcUrls = getRpcUrlsFromChainName(chainName);
    if (rpcUrls.length === 0) {
      return null;
    }
    
    for (const rpcUrl of rpcUrls) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_blockNumber',
            params: [],
            id: 1
          })
        });
        
        if (!response.ok) {
          continue;
        }
        
        const data = await response.json() as { result?: string };
        if (data.result) {
          const blockNumber = parseInt(data.result, 16);
          return blockNumber;
        }
      } catch {
        // 忽略错误，尝试下一个 RPC
      } finally {
        clearTimeout(timeoutId);
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * 检查 campaign 是否需要更新非 APR 数据（timeRanges、message 等）
 * 只有在 campaign 结束时（当前时间 >= endDate 或当前区块 >= endBlock）才需要更新
 * 
 * 规则：
 * 1. 如果没有缓存数据 → 需要更新
 * 2. 如果有缓存数据但没有 endBlock 和 endDate（无法判断是否结束）→ 需要更新
 * 3. 如果有 endDate 且当前时间 >= endDate → 需要更新（campaign 已结束）
 * 4. 如果有 endBlock 且当前区块 >= endBlock → 需要更新（campaign 已结束）
 * 5. 其他情况（campaign 进行中）→ 不需要更新
 */
async function evaluateTimeRangeUpdate(
  cachedTimeRange: { endDate?: string; endBlock?: string; link?: string } | undefined,
  key: string
): Promise<{ needsUpdate: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  // 如果没有缓存数据，需要更新
  if (!cachedTimeRange) {
    reasons.push('missing-cache');
    return { needsUpdate: true, reasons };
  }
  
  // 如果既没有 endBlock 也没有 endDate，无法判断是否结束，需要更新
  if (!cachedTimeRange.endBlock && !cachedTimeRange.endDate) {
    reasons.push('missing-endDate-and-endBlock');
    return { needsUpdate: true, reasons };
  }
  
  // 检查 endDate
  if (cachedTimeRange.endDate) {
    try {
      // 尝试解析各种日期格式
      let endDate: Date | null = null;
      
      // 尝试直接解析
      endDate = new Date(cachedTimeRange.endDate);
      if (isNaN(endDate.getTime())) {
        // 如果直接解析失败，尝试解析 "Wed Jan 21 2026" 格式
        const dateMatch = cachedTimeRange.endDate.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\w+)\s+(\d+)\s+(\d+)/);
        if (dateMatch) {
          endDate = new Date(cachedTimeRange.endDate);
        }
      }
      
      if (endDate && !isNaN(endDate.getTime())) {
        const now = new Date();
        // 如果当前时间已经超过结束时间，需要更新（campaign 已结束，可能有新数据）
        if (now >= endDate) {
          reasons.push('endDate-passed');
          return { needsUpdate: true, reasons };
        }
        // 如果当前时间 < 结束时间，campaign 还在进行中，不需要更新
        return { needsUpdate: false, reasons };
      }
    } catch (e) {
      // 日期解析失败，需要更新
      reasons.push('endDate-parse-error');
      return { needsUpdate: true, reasons };
    }
  }
  
  // 检查 endBlock（如果提供了结束区块号）
  if (cachedTimeRange.endBlock) {
    try {
      const endBlock = parseInt(cachedTimeRange.endBlock, 10);
      if (!isNaN(endBlock)) {
        // 从 key 中提取链名
        const parts = key.split('-');
        const chainName = parts[0];
        
        // 获取当前区块号
        const currentBlock = await getCurrentBlockNumber(chainName);
        if (currentBlock !== null) {
          // 如果当前区块已经超过结束区块，需要更新
          if (currentBlock >= endBlock) {
            reasons.push('endBlock-passed');
            return { needsUpdate: true, reasons };
          }
          // 如果当前区块 < 结束区块，campaign 还在进行中，不需要更新
          return { needsUpdate: false, reasons };
        } else {
          // 无法获取当前区块号，为了安全起见，需要更新
          reasons.push('current-block-null');
          return { needsUpdate: true, reasons };
        }
      }
    } catch (e) {
      // 区块号解析失败，需要更新
      reasons.push('endBlock-parse-error');
      return { needsUpdate: true, reasons };
    }
  }
  
  // 如果到这里，说明有缓存数据但无法判断状态，为了安全起见，需要更新
  reasons.push('unknown-state');
  return { needsUpdate: true, reasons };
}

function parseMeritEndDate(endDateRaw?: string): Date | null {
  if (!endDateRaw || endDateRaw.trim() === '') {
    return null;
  }
  const parsed = new Date(endDateRaw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function isMeritCampaignExpired(
  chainKey: string,
  endDateRaw: string | undefined,
  endBlockRaw: string | undefined,
  currentBlockCache: Map<string, number | null>
): Promise<boolean> {
  const now = new Date();
  const parsedEndDate = parseMeritEndDate(endDateRaw);
  if (parsedEndDate) {
    return parsedEndDate < now;
  }

  if (!endBlockRaw) {
    return false;
  }

  const endBlock = parseInt(endBlockRaw, 10);
  if (Number.isNaN(endBlock)) {
    return false;
  }

  if (!currentBlockCache.has(chainKey)) {
    const currentBlock = await getCurrentBlockNumber(chainKey);
    currentBlockCache.set(chainKey, currentBlock);
  }

  const currentBlock = currentBlockCache.get(chainKey);
  if (currentBlock === null || currentBlock === undefined) {
    return false;
  }

  return currentBlock >= endBlock;
}

/**
 * 从文件加载缓存的 timeRanges 数据
 * 只保留有全量数据的条目（包含数据结构定义的所有字段）
 * 如果文件不存在或解析失败，返回空对象（会触发所有条目重新获取）
 * 
 * 验证规则：如果之前爬虫成功获取了数据，所有字段都应该存在
 * - 必填字段：link, startDate, endDate（必须存在且非空）
 * - 区块字段：startBlock, endBlock（必须存在，用于判断 campaign 是否结束）
 * - 名称字段：name（必须存在，campaign 名称）
 * - 消息字段：message（可选，对于 key 长度为 2 的条目可能不存在）
 * 
 * 如果缺少任何必填字段，说明之前爬虫出问题了，需要重新获取
 */
async function loadCachedTimeRanges(): Promise<Record<string, { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] }>> {
  try {
    let parsed: any = null;
    let loadedFromPath: string | null = null;
    let loadedFromLabel: string | null = null;

    const candidates = [
      { path: MERIT_TIMERANGES_CACHE_PATH, label: 'merit-timeranges-cache.json' },
      { path: join(DATA_DIR, 'merit-raw-data.json'), label: 'merit-raw-data.json' },
    ];

    for (const candidate of candidates) {
      try {
        const cachedData = await readFile(candidate.path, 'utf-8');
        parsed = JSON.parse(cachedData);
        loadedFromPath = candidate.path;
        loadedFromLabel = candidate.label;
        break;
      } catch {
        // Try next cache source
      }
    }

    if (!parsed) {
      throw new Error('No cached timeRanges source available');
    }
    const timeRanges = parsed.timeRanges || {};
    
    // 验证缓存数据的完整性：确保每个条目都有全量数据
    const validatedTimeRanges: Record<string, { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] }> = {};
    
    for (const [key, value] of Object.entries(timeRanges)) {
      const timeRange = value as { 
        link?: string; 
        startDate?: string; 
        endDate?: string; 
        startBlock?: string; 
        endBlock?: string; 
        name?: string; 
        message?: MeritCampaignInfo[] 
      };
      
      // 检查所有必填字段：link, startDate, endDate（必须存在且非空）
      const hasRequiredFields = 
        timeRange.link && 
        timeRange.link.trim() !== '' &&
        timeRange.startDate && 
        timeRange.startDate.trim() !== '' &&
        timeRange.endDate && 
        timeRange.endDate.trim() !== '';
      
      // 检查区块字段：startBlock, endBlock
      // 注意：endBlock 可能提取不到（如果 HTML 中没有区块链接），但如果有 startBlock 通常也应该有 endBlock
      // 如果都没有区块信息，至少要有 endDate 来判断结束时间
      const hasBlockFields = 
        timeRange.startBlock && 
        timeRange.startBlock.trim() !== '' &&
        timeRange.endBlock && 
        timeRange.endBlock.trim() !== '';
      
      // 检查名称字段：name（必须存在）
      const hasName = 
        timeRange.name && 
        timeRange.name.trim() !== '';
      
      // 检查至少有一个用于判断结束的字段：endDate 或 endBlock
      const hasEndIndicator = 
        (timeRange.endDate && timeRange.endDate.trim() !== '') || 
        (timeRange.endBlock && timeRange.endBlock.trim() !== '');
      
      // 根据 key length 判断 message 是否必需
      // key 长度为 2 的条目（如 "ethereum-sgho"）不需要 message
      const keyParts = key.split('-');
      const shouldHaveMessage = keyParts.length > 2;
      const hasMessage = 
        !shouldHaveMessage || // 如果不需要 message，跳过检查
        (timeRange.message && Array.isArray(timeRange.message) && timeRange.message.length > 0);
      
      // 只保留有全量数据的条目（所有必填字段都存在）
      // message 字段根据 key length 判断是否必需
      if (hasRequiredFields && hasName && hasEndIndicator && hasMessage) {
        // 如果有区块字段，也要验证完整性
        if (timeRange.startBlock || timeRange.endBlock) {
          // 如果有一个区块字段，另一个也应该存在
          if (!hasBlockFields) {
            logger.warn(`⚠️ Cached entry "${key}" has partial block fields, will refetch`);
            continue;
          }
        }
        
        validatedTimeRanges[key] = timeRange as { 
          link: string; 
          startDate: string; 
          endDate: string; 
          startBlock?: string; 
          endBlock?: string; 
          name?: string; 
          message?: MeritCampaignInfo[] 
        };
      } else {
        // 记录缺失的字段，便于调试
        const missingFields: string[] = [];
        if (!hasRequiredFields) missingFields.push('link/startDate/endDate');
        if (!hasName) missingFields.push('name');
        if (!hasEndIndicator) missingFields.push('endDate/endBlock');
        if (!hasMessage && shouldHaveMessage) missingFields.push('message');
        logger.warn(`⚠️ Cached entry "${key}" missing fields: ${missingFields.join(', ')}, will refetch`);
      }
    }
    
    const filteredCount = Object.keys(timeRanges).length - Object.keys(validatedTimeRanges).length;
    if (filteredCount > 0) {
      logger.info(`📦 Filtered out ${filteredCount} incomplete cached entries (missing required fields), will refetch them`);
    }
    if (loadedFromPath && loadedFromLabel) {
      logger.info(`📦 Loaded Merit timeRanges cache from ${loadedFromLabel}`);
    }
    
    return validatedTimeRanges;
  } catch (error) {
    // 文件不存在或解析失败，返回空对象（会触发所有条目重新获取）
    logger.info('📦 No cached time ranges found, will fetch all entries');
    return {};
  }
}

function getHasSelfAuthForKey(meritAPRs: Record<string, number | null>, key: string): boolean {
  return meritAPRs[`self-${key}`] !== null && meritAPRs[`self-${key}`] !== undefined;
}

function hasSelfAuthMessage(message: MeritCampaignInfo[] | undefined): boolean {
  return !!message?.some((m) => (m.action || '').toLowerCase().includes('self authentication'));
}

function isCachedTimeRangeComplete(params: {
  key: string;
  cached: {
    link?: string;
    startDate?: string;
    endDate?: string;
    startBlock?: string;
    endBlock?: string;
    name?: string;
    message?: MeritCampaignInfo[];
  } | undefined;
  hasSelfAuth: boolean;
}): { isComplete: boolean; missing: string[] } {
  const { key, cached, hasSelfAuth } = params;
  const missing: string[] = [];
  if (!cached) return { isComplete: false, missing: ['missing-cache'] };

  const linkOk = !!cached.link && cached.link.trim() !== '';
  const startDateOk = !!cached.startDate && cached.startDate.trim() !== '';
  const endDateOk = !!cached.endDate && cached.endDate.trim() !== '';
  const nameOk = !!cached.name && cached.name.trim() !== '';
  const hasEndIndicatorOk = endDateOk || (!!cached.endBlock && cached.endBlock.trim() !== '');

  if (!linkOk) missing.push('link');
  if (!startDateOk) missing.push('startDate');
  if (!endDateOk) missing.push('endDate');
  if (!nameOk) missing.push('name');
  if (!hasEndIndicatorOk) missing.push('endDate/endBlock');

  const keyParts = key.split('-');
  const shouldHaveMessage = keyParts.length > 2;
  if (shouldHaveMessage) {
    const msgOk = Array.isArray(cached.message) && cached.message.length > 0;
    if (!msgOk) missing.push('message');
  }

  // Block fields: if one exists, require both
  const hasAnyBlock = !!cached.startBlock || !!cached.endBlock;
  if (hasAnyBlock) {
    const startBlockOk = !!cached.startBlock && cached.startBlock.trim() !== '';
    const endBlockOk = !!cached.endBlock && cached.endBlock.trim() !== '';
    if (!startBlockOk || !endBlockOk) missing.push('startBlock/endBlock');
  }

  // Self-auth required only when the self- key exists for this campaign
  if (hasSelfAuth && shouldHaveMessage) {
    if (!hasSelfAuthMessage(cached.message)) missing.push('self-auth');
  }

  return { isComplete: missing.length === 0, missing };
}

/**
 * 获取 Merit APR 数据并构建索引
 * 优化：非 APR 数据（timeRanges、message 等）只在 campaign 结束时更新
 */
export async function fetchMeritData(): Promise<Record<string, MeritDataItem>> {
  try {
    logger.info('🎁 Fetching Merit APR data...');
    const response = await fetch('https://apps.aavechan.com/api/merit/aprs');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json() as MeritAPRResponse;
    logger.info(`✅ Merit APR data fetched successfully`);
    
    const meritAPRs = data.currentAPR.actionsAPR;
    
    // 加载缓存的 timeRanges 数据
    const cachedTimeRanges = await loadCachedTimeRanges();
    logger.info(`📦 Loaded ${Object.keys(cachedTimeRanges).length} cached time ranges`);
    
    // 获取时间范围信息（只在需要时更新）
    const timeRanges = await fetchAllMeritTimeRanges(meritAPRs, { 
      maxConcurrent: 5,
      cachedTimeRanges 
    });
    
    // 建立 Merit APR 数据索引
    // 作用：将原始 Merit APR 数据（键格式复杂，如 "ethereum-supply-weth"）转换为统一的索引格式
    // 输入：Record<string, number | null> - 原始数据，键可能包含多种格式（supply/borrow/prime/multiple/self- 等）
    // 输出：Record<chain-token, {...}> - 统一索引，键为 "chain-token" 格式（如 "ethereum-weth"）
    logger.info('🔍 Indexing Merit APR data...');
    const meritData: Record<string, MeritDataItem> = {};

    // 创建索引条目的辅助函数
    function createIndexEntry(indexKey: string) {
      if (!(indexKey in meritData)) {
        meritData[indexKey] = {
          meritSupplys: [],
          meritBorrows: []
        };
      }
      return meritData[indexKey]!;
    }

    // 获取 key 对应的 link、时间范围、block、name 和 message 信息（处理 self- 前缀）
    function getLinkAndTimeRange(key: string): { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] } {
      const isSelfFormat = key.startsWith('self-');
      const baseKey = isSelfFormat ? key.substring(5) : key;
      
      // 查找 baseKey 的时间范围（self- 开头的 key 使用对应的非 self- key 的时间范围）
      const timeRangeData = timeRanges[baseKey];
      if (timeRangeData) {
        return {
          link: timeRangeData.link,
          startDate: timeRangeData.startDate,
          endDate: timeRangeData.endDate,
          startBlock: timeRangeData.startBlock,
          endBlock: timeRangeData.endBlock,
          ...(timeRangeData.name && { name: timeRangeData.name }),
          ...(timeRangeData.message && timeRangeData.message.length > 0 && { message: timeRangeData.message })
        };
      }
      
      // 如果找不到，返回默认值
      return {
        link: `https://apps.aavechan.com/merit/${baseKey}`,
        startDate: '',
        endDate: ''
      };
    }

    // 先收集所有 key 的信息，按 baseKey 分组
    interface KeyInfo {
      key: string;
      value: number;
      isSelf: boolean;
      supplyTokens: string[];
      borrowTokens: string[];
      chainKey: string;
    }
    
    const baseKeyMap = new Map<string, { nonSelf?: KeyInfo; self?: KeyInfo }>();
    
    // 第一遍遍历：收集所有 key 信息
    Object.entries(meritAPRs).forEach(([key, value]) => {
      if (value === null) return;
      
      const parts = key.split('-');
      if (parts.length < 2) return;
      
      const isSelfFormat = key.startsWith('self-');
      const actualKey = isSelfFormat ? key.substring(5) : key;
      const actualParts = actualKey.split('-');
      
      if (actualParts.length < 2) return;
      
      const chainKey = parseChainKey(actualParts);
      
      let supplyTokens: string[] = [];
      let borrowTokens: string[] = [];

      if (actualKey.includes('-supply-') && actualKey.includes('-borrow-')) {
        const supplyIndex = actualParts.indexOf('supply');
        const borrowIndex = actualParts.indexOf('borrow');
        if (supplyIndex >= 0 && borrowIndex >= 0) {
          const rawSupplyToken = actualParts.slice(supplyIndex + 1, borrowIndex).join('-');
          const rawBorrowToken = actualParts.slice(borrowIndex + 1).join('-');
          supplyTokens = rawSupplyToken.includes('-or-') 
            ? rawSupplyToken.split('-or-').map(t => t.toLowerCase()).filter(Boolean)
            : rawSupplyToken ? [rawSupplyToken.toLowerCase()] : [];
          borrowTokens = rawBorrowToken.includes('-or-')
            ? rawBorrowToken.split('-or-').map(t => t.toLowerCase()).filter(Boolean)
            : rawBorrowToken ? [rawBorrowToken.toLowerCase()] : [];
        }
      } else if (actualKey.includes('-supply-')) {
        const token = actualParts[actualParts.length - 1].toLowerCase();
        if (token) supplyTokens = [token];
      } else if (actualKey.includes('-borrow-')) {
        const token = actualParts[actualParts.length - 1].toLowerCase();
        if (token) borrowTokens = [token];
      } else if (actualParts.length === 2) {
        const token = actualParts[1].toLowerCase();
        if (token) supplyTokens = [token];
      }

      if (supplyTokens.length > 0 || borrowTokens.length > 0) {
        const info: KeyInfo = { key, value, isSelf: isSelfFormat, supplyTokens, borrowTokens, chainKey };
        
        // 按 baseKey 分组（baseKey 就是去掉 self- 前缀的 key）
        const baseKey = actualKey;
        if (!baseKeyMap.has(baseKey)) {
          baseKeyMap.set(baseKey, {});
        }
        const group = baseKeyMap.get(baseKey)!;
        if (isSelfFormat) {
          group.self = info;
        } else {
          group.nonSelf = info;
        }
      }
    });

    // 第二遍遍历：处理每个 baseKey，合并 self 和非 self
    const currentBlockCache = new Map<string, number | null>();
    let expiredCampaignsFiltered = 0;
    const collectTargetMeritRoundTargets = (): Map<string, MeritRoundEstimateTarget> => {
      const targets = new Map<string, MeritRoundEstimateTarget>();
      for (const [baseKey, group] of baseKeyMap.entries()) {
        const nonSelfInfo = group.nonSelf;
        const selfInfo = group.self;
        const keyForTimeRange = nonSelfInfo?.key || selfInfo?.key || baseKey;
        const { endDate } = getLinkAndTimeRange(keyForTimeRange);
        const cycleEndTsMs = parseMeritEndDateToMs(endDate);

        const candidate = nonSelfInfo ?? selfInfo;
        if (!candidate) continue;
        const chainId = CHAIN_KEY_TO_CHAIN_ID[candidate.chainKey.toLowerCase()];
        if (!chainId) continue;

        candidate.supplyTokens.forEach((token) => {
          if (!token || token === 'multiple') return;
          const key = buildMeritRoundKey(chainId, 'supply', token);
          targets.set(key, { cycleEndTsMs });
        });
        candidate.borrowTokens.forEach((token) => {
          if (!token || token === 'multiple') return;
          const key = buildMeritRoundKey(chainId, 'borrow', token);
          targets.set(key, { cycleEndTsMs });
        });
      }
      return targets;
    };

    const targetMeritRoundTargets = collectTargetMeritRoundTargets();
    const meritRoundEstimates = await fetchMeritRoundEstimates(targetMeritRoundTargets).catch((error) => {
      logger.warn(
        `⚠️ Failed to fetch Merkl-based merit round estimates: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return new Map<string, MeritRoundEstimateBase>();
    });
    for (const [baseKey, group] of baseKeyMap.entries()) {
      const nonSelfInfo = group.nonSelf;
      const selfInfo = group.self;
      
      // 检查 key 长度，如果长度为 2（如 ethereum-sgho），跳过获取 message
      const keyParts = baseKey.split('-');
      const shouldFetchMessage = keyParts.length > 2;
      
      // 决定使用哪个 key 获取时间范围（优先使用 nonSelf，因为 self 会跳过获取时间范围）
      const keyForTimeRange = nonSelfInfo?.key || selfInfo?.key || baseKey;
      const { link, startDate, endDate, startBlock, endBlock, name, message } = getLinkAndTimeRange(keyForTimeRange);
      
      // 决定 APR 值
      const aprValue = nonSelfInfo?.value;
      const selfAprValue = selfInfo?.value;
      
      // 如果只有 self，没有 nonSelf，那就不创建条目（因为 self 应该和 nonSelf 配对）
      if (!nonSelfInfo && selfInfo) {
        // 这种情况理论上不应该出现，但为了健壮性，我们创建一个只有 selfApr 的条目
        // 实际上应该跳过，因为 self 应该和对应的 nonSelf 一起出现
        continue;
      }
      
      // 如果没有 nonSelf，跳过
      if (!nonSelfInfo) continue;
      
      // message 已经包含了 Self Authentication（如果在 fetchAllMeritTimeRanges 中获取到了）
      // 直接使用 timeRanges 中的 message，它已经包含了 Self Authentication
      const finalMessage = message || [];
      
      const { supplyTokens, borrowTokens, chainKey } = nonSelfInfo;

      // 过滤掉历史 campaign，只保留进行中和未来的 campaign
      const isExpired = await isMeritCampaignExpired(chainKey, endDate, endBlock, currentBlockCache);
      if (isExpired) {
        expiredCampaignsFiltered++;
        logger.info(`   🗑️ Filtered expired Merit campaign ${baseKey} (endDate: ${endDate || 'N/A'}, endBlock: ${endBlock || 'N/A'})`);
        continue;
      }

      const borrowTargets = borrowTokens.filter(t => t !== 'multiple');
      const supplyTargets = supplyTokens.filter(t => t !== 'multiple');
      const hasBorrowTokens = borrowTargets.length > 0;
      const hasBorrowMultiple = borrowTokens.includes('multiple');
      const hasSupplyTokens = supplyTargets.length > 0;

      // 情况 1: borrowToken 不是 'multiple'，为每个 borrow token 分别处理
      if (hasBorrowTokens) {
        for (const bt of borrowTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${bt.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);

          if (supplyTokens.length > 0) {
            // borrow with supply requirement
            const estimate = getMeritEstimateForEntry(
              meritRoundEstimates,
              chainKey,
              'borrow',
              bt
            );
            const entry: MeritAprEntry = {
              apr: aprValue!,
              selfApr: selfAprValue,
              requiredSupplyTokens: supplyTokens,
              link,
              startDate,
              endDate,
              startBlock,
              endBlock,
              ...(name && { name }),
              ...(finalMessage.length > 0 && { message: finalMessage }),
              ...(estimate ?? {})
            };
            incentives.meritBorrows.push(entry);
          } else {
            // 简单 borrow
            const estimate = getMeritEstimateForEntry(
              meritRoundEstimates,
              chainKey,
              'borrow',
              bt
            );
            const entry: MeritAprEntry = {
              apr: aprValue!,
              selfApr: selfAprValue,
              link,
              startDate,
              endDate,
              startBlock,
              endBlock,
              ...(name && { name }),
              ...(finalMessage.length > 0 && { message: finalMessage }),
              ...(estimate ?? {})
            };
            incentives.meritBorrows.push(entry);
          }
        }

        if (hasSupplyTokens) {
          for (const st of supplyTargets) {
            const supplyIndexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
            const supplyIncentives = createIndexEntry(supplyIndexKey);
            // supply with borrow requirement
            const estimate = getMeritEstimateForEntry(
              meritRoundEstimates,
              chainKey,
              'supply',
              st
            );
            const entry: MeritAprEntry = {
              apr: aprValue!,
              selfApr: selfAprValue,
              requiredBorrowTokens: borrowTokens,
              link,
              startDate,
              endDate,
              startBlock,
              endBlock,
              ...(name && { name }),
              ...(finalMessage.length > 0 && { message: finalMessage }),
              ...(estimate ?? {})
            };
            supplyIncentives.meritSupplys.push(entry);
          }
        }
      }

      // 情况 2: borrowToken 是 'multiple'，为每个 supply token 分别处理
      if (hasBorrowMultiple && hasSupplyTokens) {
        for (const st of supplyTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);
          // supply with borrow requirement (multiple)
          const estimate = getMeritEstimateForEntry(
            meritRoundEstimates,
            chainKey,
            'supply',
            st
          );
          const entry: MeritAprEntry = {
            apr: aprValue!,
            selfApr: selfAprValue,
            requiredBorrowTokens: ['multiple'],
            link,
            startDate,
            endDate,
            startBlock,
            endBlock,
            ...(name && { name }),
            ...(finalMessage.length > 0 && { message: finalMessage }),
            ...(estimate ?? {})
          };
          incentives.meritSupplys.push(entry);
          }
        }

      // 情况 3: 只有 supply token，没有 borrow token（简单 supply 场景）
      if (!hasBorrowTokens && !hasBorrowMultiple && hasSupplyTokens) {
        for (const st of supplyTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);
          const estimate = getMeritEstimateForEntry(
            meritRoundEstimates,
            chainKey,
            'supply',
            st
          );
          const entry: MeritAprEntry = {
            apr: aprValue!,
            selfApr: selfAprValue,
            link,
            startDate,
            endDate,
            startBlock,
            endBlock,
            ...(name && { name }),
            ...(finalMessage.length > 0 && { message: finalMessage }),
            ...(estimate ?? {})
          };
          incentives.meritSupplys.push(entry);
        }
      }
    }

    if (expiredCampaignsFiltered > 0) {
      logger.info(`🗑️ Filtered out ${expiredCampaignsFiltered} expired Merit campaign(s)`);
    }

    logger.info(`✅ Indexed Merit data for ${Object.keys(meritData).length} chain-token combinations`);
    
    // 保存 Merit 原始数据
    await mkdir(DATA_DIR, { recursive: true });
    const meritMerklRawDataPath = join(DATA_DIR, 'merit-merkl-raw-data.json');
    await writeJsonAtomic(meritMerklRawDataPath, {
      timestamp: new Date().toISOString(),
      source: {
        endpoint: `${MERKL_BASE_URL}/opportunities`,
        status: 'PAST',
        type: 'JSON_AIRDROP',
        campaigns: true,
        order: 'desc',
        items: 100,
        maxPages: MERIT_ROUND_ESTIMATE_MAX_PAGES,
        requestTemplateUrl:
          meritRoundEstimateLastFetchMeta?.requestTemplateUrl ??
          `${MERKL_BASE_URL}/opportunities?status=PAST&type=JSON_AIRDROP&campaigns=true&order=desc&items=100&page={page}`,
        firstPageUrl:
          meritRoundEstimateLastFetchMeta?.firstPageUrl ??
          `${MERKL_BASE_URL}/opportunities?status=PAST&type=JSON_AIRDROP&campaigns=true&order=desc&items=100&page=0`,
        pagesScanned: meritRoundEstimateLastFetchMeta?.pagesScanned ?? 0,
        hitCacheOnly: meritRoundEstimateLastFetchMeta?.hitCacheOnly ?? false,
      },
      targets: serializeMeritRoundEstimateTargets(targetMeritRoundTargets),
      lastRoundRewards: serializeMeritRoundEstimates(meritRoundEstimates),
      cacheState: serializeMeritRoundEstimateCache(),
    });
    logger.info(`💾 Merit Merkl raw data saved to ${meritMerklRawDataPath}`);

    await writeJsonAtomic(MERIT_TIMERANGES_CACHE_PATH, {
      timestamp: new Date().toISOString(),
      timeRanges,
    });
    logger.info(`💾 Merit timeRanges cache saved to ${MERIT_TIMERANGES_CACHE_PATH}`);

    const meritRawDataPath = join(DATA_DIR, 'merit-raw-data.json');
    await writeJsonAtomic(meritRawDataPath, {
      timestamp: new Date().toISOString(),
      rawAPRs: data.currentAPR.actionsAPR,
      timeRanges,
      index: meritData
    });
    logger.info(`💾 Merit raw data saved to ${meritRawDataPath}`);
    
    return meritData;
  } catch (error) {
    logger.error('❌ Error fetching Merit APR data:', error);
    return {};
  }
}

/**
 * 批量获取所有 Merit key 的时间范围和链接信息
 * 这个函数会为每个唯一的 key 获取时间范围信息
 * 注意：跳过以 self- 开头的 key，因为它们与去掉 self- 前缀的 key 共享相同的 URL 和时间范围
 * 
 * 优化：只在 campaign 结束时更新非 APR 数据（timeRanges、message 等）
 */
export async function fetchAllMeritTimeRanges(
  meritAPRs: Record<string, number | null>,
  options: { 
    maxConcurrent?: number;
    cachedTimeRanges?: Record<string, { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] }>;
  } = {}
): Promise<Record<string, { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] }>> {
  const { maxConcurrent = 1, cachedTimeRanges = {} } = options;
  
  // 从缓存开始，只更新需要更新的部分
  const timeRanges: Record<string, { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] }> = { ...cachedTimeRanges };
  const uniqueKeys = Object.keys(meritAPRs);
  
  if (uniqueKeys.length === 0) {
    return timeRanges;
  }
  
  // 过滤掉以下情况的 key：
  // 1. 值为 null 的 key（如 "avalanche-supply-savax": null），这些不需要获取时间范围
  // 2. 以 self- 开头的 key，因为它们与去掉 self- 前缀的 key 共享相同的 URL 和时间范围
  // 3. 长度为 2 的 key（如 "ethereum-sgho"），这些不需要获取 message
  const allKeysToCheck = uniqueKeys.filter(key => {
    const value = meritAPRs[key];
    if (value === null) return false; // 跳过 null 值
    if (key.startsWith('self-')) return false; // 跳过 self- 前缀
    const keyParts = key.split('-');
    if (keyParts.length <= 2) return false; // 跳过长度为 2 的 key（不需要 message）
    return true;
  });
  
  // 检查哪些 key 需要更新（只在 campaign 结束时更新）
  const keysToFetch: string[] = [];
  const keysToSkip: string[] = [];
  
  // 并发检查所有 key 是否需要更新
  // Canonical-key support: some keys redirect to another key page (e.g. sonic-supply-usdce -> sonic-supply-usdc).
  // We keep only canonical keys in fetch list, but we will alias duplicates to the canonical result.
  const canonicalMap = new Map<string, string>();
  const canonicalToAliases = new Map<string, Set<string>>();

  // Use aliases from config file
  const getCanonicalKey = (k: string) => discoveredRedirectAliases.get(k) ?? meritKeyAliases[k] ?? k;

  const updateChecks = await Promise.all(
    allKeysToCheck.map(async (key) => {
      const canonicalKey = getCanonicalKey(key);
      canonicalMap.set(key, canonicalKey);
      if (!canonicalToAliases.has(canonicalKey)) canonicalToAliases.set(canonicalKey, new Set());
      canonicalToAliases.get(canonicalKey)!.add(key);

      const cached = cachedTimeRanges[key] ?? cachedTimeRanges[canonicalKey];
      const hasSelfAuth = getHasSelfAuthForKey(meritAPRs, canonicalKey);
      const completeness = isCachedTimeRangeComplete({ key: canonicalKey, cached, hasSelfAuth });
      const needsUpdateByCompleteness = !completeness.isComplete;

      const { needsUpdate: needsUpdateByEndState, reasons: endStateReasons } = await evaluateTimeRangeUpdate(cached, canonicalKey);
      // 如果缺少 self-auth，即使 campaign 还在进行中，也需要更新
      // 这确保当 API 中新增了 self- 前缀的 key 时，能够获取到 self-auth 数据
      const needsUpdateForSelfAuth = hasSelfAuth && completeness.missing.includes('self-auth');
      const needsUpdate = needsUpdateByEndState || needsUpdateByCompleteness || needsUpdateForSelfAuth;
      
      if (needsUpdateForSelfAuth && !needsUpdateByEndState && !needsUpdateByCompleteness) {
        logger.info(`🔄 Force update for ${canonicalKey}: missing self-auth data (campaign still active, API has self-${canonicalKey})`);
      }

      return {
        key,
        canonicalKey,
        needsUpdate,
        cached,
        debug: {
          completenessMissing: completeness.missing,
          endStateReasons,
        },
      };
    })
  );
  
  const canonicalNeedsUpdate = new Map<string, boolean>();
  const canonicalCached = new Map<string, { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] } | undefined>();

  for (const { canonicalKey, needsUpdate, cached, debug } of updateChecks) {
    canonicalNeedsUpdate.set(canonicalKey, (canonicalNeedsUpdate.get(canonicalKey) ?? false) || needsUpdate);
    if (cached && !canonicalCached.has(canonicalKey)) {
      canonicalCached.set(canonicalKey, cached);
    }

    if (needsUpdate) {
      const logParts = [
        `key=${canonicalKey}`,
        debug?.completenessMissing?.length ? `missing=[${debug.completenessMissing.join(',')}]` : 'missing=[]',
        debug?.endStateReasons?.length ? `endState=[${debug.endStateReasons.join(',')}]` : 'endState=[]',
      ];
      logger.info(`🧭 Merit timeRange refresh: ${logParts.join(' | ')}`);
    }
  }

  // Build fetch/skip lists on canonical keys only
  const canonicalKeys = [...canonicalToAliases.keys()];
  for (const canonicalKey of canonicalKeys) {
    const needsUpdate = canonicalNeedsUpdate.get(canonicalKey) ?? true;
    const cached = canonicalCached.get(canonicalKey);
    if (needsUpdate) {
      keysToFetch.push(canonicalKey);
    } else {
      keysToSkip.push(canonicalKey);
      if (cached) timeRanges[canonicalKey] = cached;
    }
  }
  
  const skippedCount = uniqueKeys.length - allKeysToCheck.length;
  logger.info(`📅 Checking ${allKeysToCheck.length} Merit campaigns...`);
  logger.info(`   • ${keysToFetch.length} campaigns need update (ended or new)`);
  logger.info(`   • ${keysToSkip.length} campaigns using cached data (still active)`);
  logger.info(`   • ${skippedCount} campaigns skipped (null/self-/short keys)`);
  if (meritKeyAliases && Object.keys(meritKeyAliases).length > 0) {
    logger.info(`🔁 Known redirect alias map active (${Object.keys(meritKeyAliases).length} entries)`);
  }
  if (keysToFetch.length > 0) {
    logger.info('🧾 Merit campaigns to fetch (index -> key):');
    keysToFetch.forEach((key, idx) => {
      const hasSelfAuth = meritAPRs[`self-${key}`] !== null && meritAPRs[`self-${key}`] !== undefined;
      logger.info(`   • [${idx + 1}/${keysToFetch.length}] ${key}${hasSelfAuth ? ' (has self-auth)' : ''}`);
    });
  }
  if (keysToSkip.length > 0) {
    logger.info('🧾 Merit campaigns using cache (index -> key):');
    keysToSkip.forEach((key, idx) => {
      const hasSelfAuth = meritAPRs[`self-${key}`] !== null && meritAPRs[`self-${key}`] !== undefined;
      logger.info(`   • [${idx + 1}/${keysToSkip.length}] ${key}${hasSelfAuth ? ' (has self-auth)' : ''}`);
    });
  }
  
  // 使用并发控制来避免过多请求
  const semaphore = { count: 0 };
  const results: Array<{ key: string; data: { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] } }> = [];
  
  const fetchWithLimit = async (key: string) => {
    while (semaphore.count >= maxConcurrent) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    semaphore.count++;
    try {
      const hasSelfAuth = meritAPRs[`self-${key}`] !== null && meritAPRs[`self-${key}`] !== undefined;
      const data = await fetchMeritTimeRange(key, { hasSelfAuth });
      results.push({ key, data });
    } catch (error) {
      // 静默失败，继续处理其他 key
    } finally {
      semaphore.count--;
    }
  };
  
  // 只并发获取需要更新的时间范围
  if (keysToFetch.length > 0) {
    await Promise.all(keysToFetch.map(key => fetchWithLimit(key)));
    
    // 更新结果映射
    for (const { key, data } of results) {
      timeRanges[key] = data;
    }
  }

  // Apply canonical aliases (so duplicate keys reuse canonical result without refetching)
  // This keeps dataset consistent while preventing duplicate crawling.
  if (canonicalToAliases.size > 0) {
    for (const [canonicalKey, aliases] of canonicalToAliases.entries()) {
      const canonicalData = timeRanges[canonicalKey];
      if (!canonicalData) continue;
      for (const alias of aliases) {
        if (alias === canonicalKey) continue;
        timeRanges[alias] = canonicalData;
      }
    }
  }
  
  logger.info(`✅ Fetched time ranges for ${Object.keys(timeRanges).length} Merit campaigns`);
  
  return timeRanges;
}

/**
 * 根据 marketName 和 tokenSymbol 获取对应的 meritData
 */
export function getMeritDataFromMarket(
  marketName: string,
  chainName: string,
  tokenSymbol: string,
  meritData: Record<string, MeritDataItem>
): MeritDataItem | null {
  // 根据 marketName 确定 chainKey
  let chainKey: string;
  if (marketName === 'AaveV3EthereumEtherFi') {
    chainKey = 'ethereum-etherfi';
  } else if (marketName === 'AaveV3EthereumLido') {
    chainKey = 'ethereum-prime';
  } else if (marketName === 'AaveV3EthereumHorizon') {
    chainKey = 'ethereum-horizon';
  } else {
    chainKey = chainName.toLowerCase();
  }

  // 尝试匹配 tokenSymbol，使用各种 fallback 策略
  const tokenLower = tokenSymbol.toLowerCase();
  
  // 生成所有可能的 tokenSymbol 变体用于匹配
  const tokenVariants: string[] = [tokenLower];
  
  // 1. 如果有小数点，去掉小数点
  if (tokenLower.includes('.')) {
    tokenVariants.push(tokenLower.replace(/\./g, ''));
  }
  
  // 2. 如果有₮，将₮转化为t
  if (tokenLower.includes('₮')) {
    tokenVariants.push(tokenLower.replace(/₮/g, 't'));
  }
  
  // 3. 如果是weth，换成eth
  if (tokenLower === 'weth') {
    tokenVariants.push('eth');
  }
  
  // 4. 如果结尾是.e，去掉.e
  if (tokenLower.endsWith('.e')) {
    tokenVariants.push(tokenLower.slice(0, -2));
  }
  
  // 5. 如果是usdt0或usd₮0，试一下usdt
  if (tokenLower === 'usdt0' || tokenLower === 'usd₮0') {
    tokenVariants.push('usdt');
  }

  // 去重
  const uniqueVariants = [...new Set(tokenVariants)];

  // 尝试每个变体来查找匹配的 meritData
  for (const variant of uniqueVariants) {
    const indexKey = `${chainKey}-${variant}`;
    if (meritData[indexKey]) {
      return meritData[indexKey];
    }
  }

  // 如果都没找到，返回 null
  return null;
}

// ============================================================================
// Browser Instance Management (Production-Grade)
// ============================================================================

// 全局浏览器实例（复用以提高性能）
let browserInstance: Browser | null = null;

/**
 * 获取或创建浏览器实例（单例模式）
 * PRODUCTION-GRADE: 检查连接状态，自动恢复断开的连接
 */
async function getBrowser(): Promise<Browser> {
  // 如果浏览器存在，检查连接状态
  if (browserInstance) {
    try {
      // 尝试获取页面列表来验证连接
      await browserInstance.pages();
      return browserInstance;
    } catch (error) {
      // 浏览器已断开，清除实例
      logger.warn('⚠️ Browser instance disconnected, will create new one');
      browserInstance = null;
    }
  }

  // 创建新浏览器实例
  try {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    logger.info('✅ Browser instance created');
    return browserInstance;
  } catch (error) {
    browserInstance = null;
    throw error;
  }
}

// ============================================================================
// Semaphore for Page Concurrency Control
// ============================================================================

interface Semaphore {
  acquire(): Promise<() => void>;
}

/**
 * 简单的 semaphore 实现，用于控制并发页面操作
 * PRODUCTION-GRADE: 防止无限制的并行 newPage() 调用
 */
function createSemaphore(concurrency: number): Semaphore {
  let available = concurrency;
  const queue: Array<() => void> = [];

  return {
    async acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        if (available > 0) {
          available--;
          resolve(() => {
            available++;
            const next = queue.shift();
            if (next) next();
          });
        } else {
          queue.push(() => {
            available--;
            resolve(() => {
              available++;
              const next = queue.shift();
              if (next) next();
            });
          });
        }
      });
    },
  };
}

// 全局 semaphore，默认并发数：2（安全默认值）
const DEFAULT_PAGE_CONCURRENCY = 2;
let pageSemaphore: Semaphore | null = null;

function getPageSemaphore(): Semaphore {
  if (!pageSemaphore) {
    const concurrency = Number(process.env.PUPPETEER_PAGE_CONCURRENCY ?? DEFAULT_PAGE_CONCURRENCY);
    pageSemaphore = createSemaphore(concurrency);
    logger.info(`📊 Created local Puppeteer page semaphore with concurrency=${concurrency} (controls browser.newPage() calls)`);
  }
  return pageSemaphore;
}

/**
 * 关闭浏览器实例
 * PRODUCTION-GRADE: 使用 browser.close() 而不是 disconnect()
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
      logger.info('✅ Browser instance closed');
    } catch (error) {
      logger.error('❌ Error closing browser instance:', error);
    } finally {
      browserInstance = null;
    }
  }
}

/**
 * 获取 Merit 页面 HTML 内容（静态 fetch，用于 name 和 date 提取）
 * name 和 date 在 SSR HTML 中就有，不需要 JavaScript 渲染
 * 这样可以减少性能消耗，避免不必要的 Puppeteer 调用
 */
// Runtime-discovered redirect aliases (in-memory only, not persisted)
// New redirects discovered at runtime are logged but not saved to file
// Known stable redirects should be added to meritKeyAliases in config.ts
const discoveredRedirectAliases = new Map<string, string>();

// Export empty function for backward compatibility (no-op since we don't persist aliases anymore)
export async function flushMeritKeyAliases(): Promise<void> {
  // No-op: aliases are now static configuration, not persisted to file
}

async function fetchMeritPageHtmlStatic(key: string): Promise<{ html: string; finalKey: string } | null> {
  try {
    const url = `https://apps.aavechan.com/merit/${key}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      logger.warn(`⚠️ Failed to fetch Merit page ${url}: HTTP ${response.status}`);
      return null;
    }

    // node-fetch follows redirects; capture final URL to detect canonical key
    const finalUrl = response.url || url;
    const match = finalUrl.match(/\/merit\/([^/?#]+)/);
    const finalKey = match?.[1] ? decodeURIComponent(match[1]) : key;
    if (finalKey && finalKey !== key) {
      const wasNew = !discoveredRedirectAliases.has(key);
      discoveredRedirectAliases.set(key, finalKey);
      if (wasNew) {
        logger.info(`🔁 Discovered redirect alias: ${key} -> ${finalKey} (runtime only, add to meritKeyAliases in config.ts if stable)`);
      }
    }

    const html = await response.text();
    return { html, finalKey };
  } catch (error) {
    logger.error(`❌ Error fetching Merit page for key ${key}:`, error);
    return null;
  }
}

/**
 * 使用 browser rendering 提取 Campaign info
 * 打开 Campaign info 弹窗，从表格中提取 action 和 description
 */
async function extractCampaignInfoWithBrowser(key: string): Promise<MeritCampaignInfo[]> {
  // Cloudflare Workers Browser Rendering primary
  const workerInfos = await extractCampaignInfoWithWorker(key);
  if (workerInfos.length > 0) {
    return workerInfos;
  }

  // Fallback: local Puppeteer (keep for reliability)
  // PRODUCTION-GRADE: Use semaphore for concurrency control
  const semaphore = getPageSemaphore();
  logger.debug(`📊 [Puppeteer Semaphore] Acquiring semaphore for campaign info extraction (key: ${key})`);
  const release = await semaphore.acquire();
  logger.debug(`📊 [Puppeteer Semaphore] Acquired semaphore for campaign info extraction (key: ${key})`);
  
  let page: Page | null = null;
  
  try {
    const url = `https://apps.aavechan.com/merit/${key}`;
    
    const browser = await getBrowser();
    page = await browser.newPage();
    
    try {
      // 设置视口和 User-Agent
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // 导航到页面
      await page.goto(url, { 
        waitUntil: 'networkidle2',
        timeout: 30000 
      });
      
      // 等待页面加载
      await page.waitForSelector('body', { timeout: 10000 });
      
      // 等待页面完全加载（包括 JavaScript 执行）- 减少等待时间
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 尝试查找并点击 "Campaign info" 按钮
      // 方法1: 查找包含 "Campaign info" 文本的按钮
      try {
        const buttons = await page.$$('button');
        for (const button of buttons) {
          const text = await page.evaluate((el) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (el as any).textContent || '';
          }, button);
          if (text && /campaign\s+info/i.test(text)) {
            await button.click();
            await new Promise(resolve => setTimeout(resolve, 800));
            break;
          }
        }
      } catch (e) {
        // 静默失败，继续尝试其他方法
      }
      
      // 方法2: 尝试查找包含 "info" 的按钮（更宽泛的匹配）
      try {
        const infoButtonIndex = await page.$$eval('button', (buttons) => {
          return buttons.findIndex((btn) => {
            const text = btn.textContent || '';
            return /info/i.test(text) && text.length < 50;
          });
        });
        if (infoButtonIndex >= 0) {
          const buttons = await page.$$('button');
          if (buttons[infoButtonIndex]) {
            await buttons[infoButtonIndex].click();
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }
      } catch (e) {
        // 静默失败
      }
      
      // 从页面中提取表格数据
      // 查找包含 Action 和 Description 列的表格
      const campaignInfos = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const infos: Array<{ action?: string; description?: string }> = [];
        
        // 查找所有表格
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        if (!doc) return infos;
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tables = doc.querySelectorAll('table');
        
        for (let i = 0; i < tables.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const table = tables[i] as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows = table.querySelectorAll('tbody tr');
          
          for (let j = 0; j < rows.length; j++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const row = rows[j] as any;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const action = (cells[0] as any)?.textContent?.trim() || '';
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const description = (cells[1] as any)?.textContent?.trim() || '';
              
              // 验证：action 应该较短，description 应该较长
              // 不依赖文字匹配，只要表格有两列且内容合理就提取
              if (action.length > 0 && description.length > action.length && description.length > 20) {
                infos.push({ action, description });
              }
            }
          }
        }
        
        return infos;
      });
      
      if (campaignInfos.length > 0) {
        return campaignInfos as MeritCampaignInfo[];
      }
      
      return [];
    } finally {
      // PRODUCTION-GRADE: Always close page, even on errors
      if (page) {
        try {
          await page.close();
        } catch (error) {
          logger.warn('⚠️ Error closing page:', error);
        }
      }
      // Release semaphore slot
      release();
    }
  } catch (error) {
    // Release semaphore even on outer error
    release();
    // 静默失败，fallback 到其他方法
    logger.warn(`⚠️ extractCampaignInfoWithBrowser failed for ${key}:`, error);
    return [];
  }
}

async function extractMeritDynamicInfoWithBrowser(
  key: string,
  options: { needCampaignInfo: boolean; needSelfAuth: boolean }
): Promise<MeritDynamicInfo> {
  const { needCampaignInfo, needSelfAuth } = options;
  const allowLocalPuppeteerFallback = process.env.MERIT_ALLOW_LOCAL_PUPPETEER !== 'false';

  // Cloudflare Workers Browser Rendering primary (single navigation on worker side)
  // 使用 try-catch 捕获超时错误，快速 fallback 到 puppeteer
  let workerResult: MeritDynamicInfo | null = null;
  try {
    workerResult = await extractMeritDynamicInfoWithWorker(key);
    if (workerResult) {
      return {
        campaignInfo: needCampaignInfo ? workerResult.campaignInfo : [],
        selfAuthDescription: needSelfAuth ? workerResult.selfAuthDescription : null,
        source: 'worker',
      };
    }
  } catch (error) {
    // Worker 超时或失败，立即 fallback 到 puppeteer，不阻塞进程
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('timeout')) {
      logger.warn(`⏱️ Cloudflare Worker timeout for ${key}, falling back to puppeteer: ${errorMsg}`);
    } else {
      logger.warn(`⚠️ Cloudflare Worker failed for ${key}, falling back to puppeteer: ${errorMsg}`);
    }
    // 继续执行 fallback 逻辑
  }

  if (!allowLocalPuppeteerFallback) {
    return { campaignInfo: [], selfAuthDescription: null, source: 'puppeteer' };
  }

  // Fallback: local Puppeteer (single navigation locally)
  // PRODUCTION-GRADE: Use semaphore for concurrency control
  const semaphore = getPageSemaphore();
  logger.debug(`📊 [Puppeteer Semaphore] Acquiring semaphore for dynamic info extraction (key: ${key})`);
  const release = await semaphore.acquire();
  logger.debug(`📊 [Puppeteer Semaphore] Acquired semaphore for dynamic info extraction (key: ${key})`);
  
  let page: Page | null = null;
  
  try {
    const url = `https://apps.aavechan.com/merit/${key}`;
    const browser = await getBrowser();
    page = await browser.newPage();

    // 修复 tsx 编译引入 __name 的问题
    // tsx 会在编译时添加 __name 辅助函数，但在浏览器环境中不存在
    // 在页面加载前注入 __name 定义
    await page.evaluateOnNewDocument(() => {
      // @ts-ignore
      if (typeof globalThis.__name === 'undefined') {
        // @ts-ignore
        globalThis.__name = (func: any) => func;
      }
    });

    try {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      await page.waitForSelector('body', { timeout: 10000 });
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const [campaignInfo, selfAuthDescription] = await Promise.all([
        (async () => {
          if (!needCampaignInfo) return [];
          try {
            const buttons = await page.$$('button');
            for (const button of buttons) {
              const text = await page.evaluate((el) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (el as any).textContent || '';
              }, button);
              if (text && /campaign\s+info/i.test(text)) {
                await button.click();
                await new Promise((resolve) => setTimeout(resolve, 800));
                break;
              }
            }
          } catch {}

          try {
            const infoButtonIndex = await page.$$eval('button', (buttons) => {
              return buttons.findIndex((btn) => {
                const text = btn.textContent || '';
                return /info/i.test(text) && text.length < 50;
              });
            });
            if (infoButtonIndex >= 0) {
              const buttons = await page.$$('button');
              if (buttons[infoButtonIndex]) {
                await buttons[infoButtonIndex].click();
                await new Promise((resolve) => setTimeout(resolve, 800));
              }
            }
          } catch {}

          const infos = await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const infos: Array<{ action?: string; description?: string }> = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const doc = (globalThis as any).document;
            if (!doc) return infos;
            const tables = doc.querySelectorAll('table');
            for (let i = 0; i < tables.length; i++) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const table = tables[i] as any;
              const rows = table.querySelectorAll('tbody tr');
              for (let j = 0; j < rows.length; j++) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const row = rows[j] as any;
                const cells = row.querySelectorAll('td');
                if (cells.length >= 2) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const action = (cells[0] as any)?.textContent?.trim() || '';
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const description = (cells[1] as any)?.textContent?.trim() || '';
                  if (action.length > 0 && description.length > action.length && description.length > 20) {
                    infos.push({ action, description });
                  }
                }
              }
            }
            return infos;
          });

          return (Array.isArray(infos) ? infos : []) as MeritCampaignInfo[];
        })(),
        (async () => {
          if (!needSelfAuth) return null;
          logger.info(`🔍 [Puppeteer Fallback] Starting self-auth extraction for ${key}`);
          let result: string | null = null;
          try {
            // 使用箭头函数避免 TypeScript 编译引入 __name 等辅助变量
            // 这样可以避免编译后的代码在浏览器环境中不可用
            // @ts-ignore - page.evaluate 中的代码在浏览器环境中执行，DOM API 可用
            result = await page.evaluate(() => {
              // @ts-ignore
              const doc = globalThis.document;
              if (!doc) return null;

              // 使用箭头函数避免 TypeScript 编译引入 __name 等辅助变量
              // @ts-ignore
              const norm = (s) => {
                return String(s || '').replace(/\s+/g, ' ').trim();
              };

              // @ts-ignore
              const hasSelfAuth = (s) => {
                const t = String(s || '').toLowerCase();
                return t.includes('self') && (t.includes('authentication') || t.includes('verify') || t.includes('proof'));
              };

              // @ts-ignore
              const scoreEl = (el) => {
                const text = norm(el ? el.textContent : null);
                if (!text || !hasSelfAuth(text)) return -1;
                let score = 0;
                if (text.length >= 60 && text.length <= 900) score += 3;
                if (text.toLowerCase().includes('supply')) score += 1;
                if (text.toLowerCase().includes('borrow')) score += 1;
                try {
                  // @ts-ignore
                  const cs = globalThis.getComputedStyle(el);
                  const bg = cs ? cs.backgroundColor : '';
                  if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') score += 2;
                  const border = cs ? cs.borderColor : '';
                  if (border && border !== 'rgba(0, 0, 0, 0)' && border !== 'transparent') score += 1;
                } catch {}
                if (text.length > 900) score -= 3;
                return score;
              };

              try {
                const candidates = doc.querySelectorAll('section,article,aside,div,p,li');

                let best = null;
                let bestScore = -1;
                for (let i = 0; i < candidates.length; i++) {
                  const el = candidates[i];
                  const s = scoreEl(el);
                  if (s > bestScore) {
                    bestScore = s;
                    best = el;
                  }
                }

                if (best) {
                  let container = best;
                  let foundValid = false;
                  for (let i = 0; i < 4; i++) {
                    const t = norm(container ? container.textContent : null);
                    if (t && t.length >= 60 && t.length <= 900 && hasSelfAuth(t)) {
                      foundValid = true;
                      break;
                    }
                    container = container ? container.parentElement : null;
                    if (!container) break;
                  }
                  if (foundValid && container) {
                    const finalText = norm(container.textContent);
                    if (finalText && hasSelfAuth(finalText) && finalText.length <= 1200) {
                      return finalText.length > 950 ? finalText.slice(0, 950) : finalText;
                    }
                  }
                  // 如果向上查找失败，尝试使用 best 元素本身的文本（放宽长度限制）
                  const bestText = norm(best.textContent);
                  if (bestText && hasSelfAuth(bestText) && bestText.length >= 60 && bestText.length <= 1200) {
                    return bestText.length > 950 ? bestText.slice(0, 950) : bestText;
                  }
                }
              } catch {}

              // text-based fallback
              const allElements = doc.querySelectorAll('*');
              for (let i = 0; i < allElements.length; i++) {
                const element = allElements[i];
                if (!element) continue;
                const text = norm(element.textContent || '');
                if (hasSelfAuth(text) && text.length > 60 && text.length < 1000) {
                  return text;
                }
              }

              return null;
            }) as string | null;
          } catch (evalError) {
            logger.error(`❌ [Puppeteer Fallback] Error in page.evaluate for ${key}:`, evalError);
            result = null;
          }
          
          if (result) {
            logger.info(`✅ [Puppeteer Fallback] Self-auth extracted for ${key}: ${result.substring(0, 100)}...`);
          } else {
            logger.warn(`⚠️ [Puppeteer Fallback] No self-auth found for ${key}`);
            // 尝试获取页面文本内容用于调试
            try {
              // 获取页面文本用于调试
              // @ts-ignore - page.evaluate 中的代码在浏览器环境中执行
              const pageText = await page.evaluate(() => {
                // @ts-ignore
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const doc = (globalThis as any).document;
                const body = doc ? doc.body : null;
                const innerText = body ? body.innerText : '';
                return innerText ? innerText.substring(0, 1000) : '';
              }) as string;
              // 检查页面文本中是否包含 self-auth 相关关键词
              const hasSelfAuthInText = /self.*(auth|verify|proof)/i.test(pageText);
              logger.info(`🔍 [Puppeteer Fallback] Page text sample (${pageText.length} chars, has self-auth keywords: ${hasSelfAuthInText}): ${pageText.substring(0, 200)}...`);
              
              // 尝试查找所有包含 self 的文本
              // @ts-ignore - page.evaluate 中的代码在浏览器环境中执行
              const selfTexts = await page.evaluate(() => {
                // @ts-ignore
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const doc = (globalThis as any).document;
                const results = [];
                const body = doc ? doc.body : null;
                const allText = body ? body.innerText : '';
                const lines = allText ? allText.split('\n') : [];
                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i];
                  const lower = line.toLowerCase();
                  if (lower.includes('self') && (lower.includes('auth') || lower.includes('verify') || lower.includes('proof'))) {
                    results.push(line.trim().substring(0, 200));
                  }
                }
                return results;
              }) as string[];
              if (selfTexts.length > 0) {
                logger.info(`🔍 [Puppeteer Fallback] Found ${selfTexts.length} potential self-auth texts:`, selfTexts);
                // 如果找到了 self-auth 文本，但提取函数返回 null，说明提取逻辑有问题
                // 尝试使用找到的第一个文本作为结果
                if (!result && selfTexts.length > 0) {
                  result = selfTexts[0];
                  logger.info(`✅ [Puppeteer Fallback] Using first found self-auth text for ${key}: ${result.substring(0, 100)}...`);
                }
              } else {
                logger.warn(`⚠️ [Puppeteer Fallback] No self-auth texts found in page content for ${key}`);
              }
            } catch (debugError) {
              logger.warn(`⚠️ [Puppeteer Fallback] Failed to get debug info: ${debugError}`);
            }
          }
          
          return result;
        })(),
      ]);

      return { campaignInfo, selfAuthDescription, source: 'puppeteer' };
    } finally {
      // PRODUCTION-GRADE: Always close page, even on errors
      if (page) {
        try {
          await page.close();
        } catch (error) {
          logger.warn('⚠️ Error closing page:', error);
        }
      }
      // Release semaphore slot
      release();
    }
  } catch (error) {
    // Release semaphore even on outer error
    release();
    logger.warn(`⚠️ extractMeritDynamicInfoWithBrowser failed for ${key}:`, error);
    return { campaignInfo: [], selfAuthDescription: null, source: 'puppeteer' };
  }
}

/**
 * 优先级 #1：从 DOM 直接提取日期
 * 使用 cheerio 解析 HTML，查找带有 class "text-xs whitespace-nowrap" 的 span 元素
 * 这种方法比正则表达式更可靠，能正确处理复杂的 HTML 结构
 */
function extractDatesFromDom(html: string): { startDate?: string; endDate?: string } {
  try {
    const $ = cheerio.load(html);
    
    // 查找所有带有 class "text-xs whitespace-nowrap" 的 span 元素
    const candidateSpans: string[] = [];
    $('span.text-xs.whitespace-nowrap').each((_index: number, element: any) => {
      const text = $(element).text().trim();
      if (text) {
        candidateSpans.push(text);
      }
    });
    
    // 过滤出符合日期格式的内容
    // 匹配格式：Mon/Tue/Wed/Thu/Fri/Sat/Sun + 月份缩写 + 日期 + 年份
    const dateRegex = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4}$/;
    const dates = candidateSpans.filter((txt) => dateRegex.test(txt));
    
    if (dates.length >= 2) {
      return {
        startDate: dates[0],
        endDate: dates[1]
      };
    }
  } catch (error) {
    // 忽略错误，继续使用其他方法
  }
  
  return {};
}

/**
 * 优先级 #2：使用正则表达式匹配各种日期格式
 */
function extractDatesWithRegex(html: string): { startDate?: string; endDate?: string } {
  const dates: string[] = [];
  
  // 匹配各种日期格式
  const patterns = [
    // Thu Jan 01 2026
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}/g,
    // 2026-01-01 (ISO)
    /\d{4}-\d{2}-\d{2}/g,
    // Jan 1, 2026
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/g,
    // 01/01/2026 (美式)
    /\d{1,2}\/\d{1,2}\/\d{4}/g,
    // 01-01-2026
    /\d{1,2}-\d{1,2}-\d{4}/g
  ];
  
  for (const pattern of patterns) {
    const matches = html.match(pattern);
    if (matches) {
      dates.push(...matches);
    }
  }
  
  // 去重并排序
  const uniqueDates = [...new Set(dates)];
  
  if (uniqueDates.length >= 2) {
    // 尝试解析并排序日期，选择最早和最晚的
    const parsedDates = uniqueDates
      .map(dateStr => {
        try {
          const date = new Date(dateStr);
          if (!isNaN(date.getTime())) {
            return { original: dateStr, parsed: date };
          }
        } catch {
          // 忽略解析失败的日期
        }
        return null;
      })
      .filter((d): d is { original: string; parsed: Date } => d !== null)
      .sort((a, b) => a.parsed.getTime() - b.parsed.getTime());
    
    if (parsedDates.length >= 2) {
      return {
        startDate: parsedDates[0].original,
        endDate: parsedDates[parsedDates.length - 1].original
      };
    }
    
    // 如果无法解析，直接使用前两个
    return {
      startDate: uniqueDates[0],
      endDate: uniqueDates[1]
    };
  }
  
  return {};
}

/**
 * 优先级 #3：提取区块号
 */
function extractBlockNumbers(html: string): { startBlock?: string; endBlock?: string } {
  // 匹配 etherscan.io/block/ 链接中的区块号
  const blockPattern = /etherscan\.io\/block\/(\d+)/g;
  const matches: string[] = [];
  let match;
  
  while ((match = blockPattern.exec(html)) !== null) {
    matches.push(match[1]);
  }
  
  // 去重并转换为数字排序
  const uniqueBlocks = [...new Set(matches)]
    .map(block => parseInt(block, 10))
    .filter(block => !isNaN(block))
    .sort((a, b) => a - b);
  
  if (uniqueBlocks.length >= 2) {
    return {
      startBlock: uniqueBlocks[0].toString(),
      endBlock: uniqueBlocks[uniqueBlocks.length - 1].toString()
    };
  } else if (uniqueBlocks.length === 1) {
    return {
      startBlock: uniqueBlocks[0].toString()
    };
  }
  
  return {};
}

/**
 * 通过 RPC 查询区块时间戳
 */
async function getBlockTimestamp(blockNumber: string, chainName?: string): Promise<string | null> {
  try {
    // 根据链名选择 RPC 端点
    const rpcUrls = chainName ? getRpcUrlsFromChainName(chainName) : [];
    
    if (rpcUrls.length === 0) {
      return null;
    }
    
    for (const rpcUrl of rpcUrls) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_getBlockByNumber',
            params: [`0x${parseInt(blockNumber, 10).toString(16)}`, false],
            id: 1
          })
        });
        
        if (!response.ok) {
          continue;
        }
        
        const data = await response.json() as { result?: { timestamp?: string } };
        
        if (data.result?.timestamp) {
          // 将十六进制时间戳转换为日期字符串
          const timestamp = parseInt(data.result.timestamp, 16);
          const date = new Date(timestamp * 1000);
          return date.toISOString();
        }
      } catch {
        // ignore and try next rpc
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * 将区块号转换为日期
 */
async function convertBlocksToDates(
  startBlock?: string,
  endBlock?: string,
  chainName?: string
): Promise<{ startDate?: string; endDate?: string }> {
  const result: { startDate?: string; endDate?: string } = {};
  
  if (startBlock) {
    const startDate = await getBlockTimestamp(startBlock, chainName);
    if (startDate) {
      result.startDate = startDate;
    }
  }
  
  if (endBlock) {
    const endDate = await getBlockTimestamp(endBlock, chainName);
    if (endDate) {
      result.endDate = endDate;
    }
  }
  
  return result;
}

/**
 * 从 HTML 中提取 campaign 名称
 * 名称通常在页面主标题位置（如 "Borrow GHO", "Supply (Celo or ETH) and borrow USDT"）
 * 在 Next.js SSR 页面中，这些信息通常在 script 标签的 JSON 数据中
 */
function extractCampaignName(html: string): string | undefined {
  try {
    const $ = cheerio.load(html);
    const scriptContent = $('script').text();
    
    // 优先级 #1：从 script 标签中的 JSON 数据提取页面主标题
    // 查找常见的 campaign 名称模式
    const namePatterns = [
      // "Borrow GHO on Aave V3 Base" 格式（带完整描述）
      /"Borrow\s+[A-Z]+\s+on\s+Aave\s+V3\s+[A-Z]+"/i,
      // "Supply (Celo or ETH) and borrow USDT" 格式
      /"Supply\s*\([^)]+\)\s+and\s+borrow\s+[A-Z]+"/i,
      // "Supply Celo and borrow USDT" 格式
      /"Supply\s+[A-Z]+\s+and\s+borrow\s+[A-Z]+"/i,
      // "Supply Celo or ETH and borrow USDT" 格式
      /"Supply\s+[A-Z]+\s+or\s+[A-Z]+\s+and\s+borrow\s+[A-Z]+"/i,
      // "Borrow GHO" 格式（简单 borrow）
      /"Borrow\s+[A-Z]+"/i,
      // "Supply [TOKEN]" 格式（简单 supply）
      /"Supply\s+[A-Z]+"/i,
      // children 数组中的格式（带完整描述）
      /children":\["Borrow\s+[A-Z]+\s+on\s+Aave\s+V3\s+[A-Z]+"/i,
      /children":\["Supply\s*\([^)]+\)\s+and\s+borrow\s+[A-Z]+"/i,
      /children":\["Borrow\s+[A-Z]+"/i,
      /children":\["Supply\s+[A-Z]+"/i,
    ];
    
    for (const pattern of namePatterns) {
      const match = scriptContent.match(pattern);
      if (match) {
        let extracted = match[0]
          .replace(/^"|"$/g, '')
          .replace(/^children":\["/, '')
          .replace(/"$/, '');
        
        // 清理可能的转义字符
        extracted = extracted.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        
        if (extracted.length > 3 && extracted.length < 200) {
          return extracted;
        }
      }
    }
    
    // 优先级 #2：从 h1 标题提取（页面中可能有 "Last supply (celo or eth) and borrow usdt..."）
    const h1Text = $('h1').first().text().trim();
    if (h1Text && h1Text.length > 5) {
      // 尝试从 h1 文本中提取 campaign 名称（去掉 "Last" 和 "campaign round has ended" 等前缀后缀）
      const nameMatch = h1Text.match(/(?:Last\s+)?(Supply\s*(?:\([^)]+\))?\s+(?:and|or)\s+borrow\s+[A-Z]+)/i) ||
                       h1Text.match(/(?:Last\s+)?(Borrow\s+[A-Z]+)/i) ||
                       h1Text.match(/(?:Last\s+)?(Supply\s+[A-Z]+)/i);
      if (nameMatch && nameMatch[1]) {
        return nameMatch[1];
      }
      // 如果 h1 文本本身就很短且看起来像标题，直接使用
      if (h1Text.length < 100 && !h1Text.toLowerCase().includes('campaign round has ended')) {
        return h1Text;
      }
    }
    
    // 优先级 #3：使用正则从 HTML 文本中提取
    const nameRegex = /(?:Supply\s*(?:\([^)]+\))?\s+(?:and|or)\s+borrow\s+[A-Z]+|Borrow\s+[A-Z]+|Supply\s+[A-Z]+)/i;
    const htmlMatch = html.match(nameRegex);
    if (htmlMatch) {
      return htmlMatch[0];
    }
  } catch (error) {
    // 静默失败
  }
  
  return undefined;
}

/**
 * 使用 browser rendering 提取 Self Authentication 描述
 * 基于位置提取：根据截图，Self 认证描述出现在一个浅绿色框中
 * 不依赖精确文本匹配，而是基于 DOM 结构位置
 * 需要使用 browser rendering 因为内容可能需要 JavaScript 渲染
 */
export async function extractSelfAuthenticationDescriptionWithBrowser(key: string): Promise<string | null> {
  // Cloudflare Browser Rendering (REST API) primary
  const cloudflareDescription = await extractSelfAuthenticationDescriptionWithCloudflare(key);
  if (cloudflareDescription) {
    return cloudflareDescription;
  }

  // Fallback: local Puppeteer (keep for reliability)
  // PRODUCTION-GRADE: Use semaphore for concurrency control
  const semaphore = getPageSemaphore();
  logger.debug(`📊 [Puppeteer Semaphore] Acquiring semaphore for self-auth extraction (key: ${key})`);
  const release = await semaphore.acquire();
  logger.debug(`📊 [Puppeteer Semaphore] Acquired semaphore for self-auth extraction (key: ${key})`);
  
  let page: Page | null = null;
  
  try {
    const url = `https://apps.aavechan.com/merit/${key}`;
    logger.info(`🔍 [Self Auth] Starting extraction for ${key} from ${url}`);
    
    const browser = await getBrowser();
    page = await browser.newPage();
    
    // 修复 tsx 编译引入 __name 的问题
    // tsx 会在编译时添加 __name 辅助函数，但在浏览器环境中不存在
    // 在页面加载前注入 __name 定义
    await page.evaluateOnNewDocument(() => {
      // @ts-ignore
      if (typeof globalThis.__name === 'undefined') {
        // @ts-ignore
        globalThis.__name = (func: any) => func;
      }
    });
    
    try {
      // 设置视口和 User-Agent
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // 导航到页面
      logger.info(`🔍 [Self Auth] Navigating to ${url}...`);
      await page.goto(url, { 
        waitUntil: 'networkidle2',
        timeout: 30000 
      });
      
      // 等待页面加载
      await page.waitForSelector('body', { timeout: 10000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
      logger.info(`🔍 [Self Auth] Page loaded, starting extraction...`);
      
      // 在浏览器中提取 Self Authentication 描述
      // 基于页面布局定位：根据截图，Self 认证描述出现在一个浅绿色信息框中
      // 优先使用 CSS 选择器、DOM 结构和样式来定位，而不是文本内容
      // @ts-ignore - page.evaluate 中的代码在浏览器环境中执行，DOM API 可用
      const selfDescription = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        if (!doc) return null;

        // Shared helpers for all strategies (do NOT rely on aave.self.xyz)
        // 使用箭头函数避免 TypeScript 编译引入 __name 等辅助变量
        const norm = (s: any) => {
          return String(s || '').replace(/\s+/g, ' ').trim();
        };

        const hasSelfAuth = (s: any) => {
          const t = String(s || '').toLowerCase();
          return t.includes('self') && (t.includes('authentication') || t.includes('verify') || t.includes('proof'));
        };
        
        // 方法1: 不依赖链接，基于 Self + authentication 语义 + 布局（更鲁棒）
        // 用户要求：即使没有完整的 aave.self.xyz，也要能识别 Self Authentication 相关文案
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const candidates = doc.querySelectorAll('section,article,aside,div,p,li') as any;
          const scoreEl = (el: any) => {
            const text = norm(el?.textContent);
            if (!text || !hasSelfAuth(text)) return -1;
            let score = 0;
            if (text.length >= 60 && text.length <= 900) score += 3;
            if (text.toLowerCase().includes('supply')) score += 1;
            if (text.toLowerCase().includes('borrow')) score += 1;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const cs = (globalThis as any).getComputedStyle(el);
              const bg = cs?.backgroundColor || '';
              if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') score += 2;
              const border = cs?.borderColor || '';
              if (border && border !== 'rgba(0, 0, 0, 0)' && border !== 'transparent') score += 1;
            } catch {}
            if (text.length > 900) score -= 3;
            return score;
          }

          let best: any = null;
          let bestScore = -1;
          for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            const s = scoreEl(el);
            if (s > bestScore) {
              bestScore = s;
              best = el;
            }
          }

          if (best) {
            let container: any = best;
            for (let i = 0; i < 4; i++) {
              const t = norm(container?.textContent);
              if (t.length >= 60 && t.length <= 900 && hasSelfAuth(t)) break;
              container = container?.parentElement;
              if (!container) break;
            }
            const finalText = norm(container?.textContent);
            if (finalText && hasSelfAuth(finalText) && finalText.length <= 1200) {
              return finalText.length > 950 ? finalText.slice(0, 950) : finalText;
            }
          }
        } catch (e) {
          // 忽略选择器错误
        }
        
        // 方法2: 根据 CSS 类/样式定位 - 查找浅绿色背景的信息框
        // 尝试查找包含特定背景色相关的 CSS 类的元素
        const styleSelectors = [
          '[class*="green"]',
          '[class*="emerald"]',
          '[class*="lime"]',
          '[class*="bg-"]', // Tailwind CSS 背景色类
        ];
        
        for (const selector of styleSelectors) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const elements = doc.querySelectorAll(selector) as any;
            for (let i = 0; i < elements.length; i++) {
              const element = elements[i];
              if (!element) continue;
              
              // 检查元素的计算样式，看是否有浅绿色背景
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const computedStyle = (globalThis as any).getComputedStyle(element);
              const bgColor = computedStyle.backgroundColor;
              
              // 检查 Self Authentication 语义（不依赖链接）
              const text = norm(element.textContent || '');
              if (hasSelfAuth(text) && text.length > 50 && text.length < 1000) {
                return text;
              }
            }
          } catch (e) {
            // 忽略选择器错误
          }
        }
        
        // 方法3: 根据 DOM 结构定位 - 查找特定的容器类型
        // 信息框通常在 div、section、article 等容器中，且可能包含特定的结构
        const containerSelectors = ['div', 'section', 'article', 'aside'];
        for (const tagName of containerSelectors) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const containers = doc.querySelectorAll(tagName) as any;
            for (let i = 0; i < containers.length; i++) {
              const container = containers[i];
              if (!container) continue;
              
              const text = norm(container.textContent || '');
              if (hasSelfAuth(text) && text.length > 50 && text.length < 1000) {
                return text;
              }
            }
          } catch (e) {
            // 忽略错误
          }
        }
        
        // 方法4: 文本定位（fallback）- 如果所有布局定位都失败，使用文本定位作为最后手段
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allElements = doc.querySelectorAll('*') as any;
        for (let i = 0; i < allElements.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const element = allElements[i] as any;
          if (!element) continue;
          
          const text = norm(element.textContent || '');
          if (hasSelfAuth(text) && text.length > 60 && text.length < 1000) {
            return text;
          }
        }
        
        return null;
      });
      
      // 获取浏览器控制台的输出
      const consoleMessages = await page.evaluate(() => {
        // 尝试获取 console.log 的输出（如果页面有存储的话）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (globalThis as any).__selfAuthDebug || null;
      });
      
      if (consoleMessages) {
        logger.info(`🔍 [Self Auth] Browser console output: ${JSON.stringify(consoleMessages)}`);
      }
      
      if (selfDescription) {
        logger.info(`✅ [Self Auth] Successfully extracted for ${key}: ${selfDescription.substring(0, 100)}...`);
        logger.info(`📝 [Self Auth] Full extracted text (${selfDescription.length} chars): ${selfDescription}`);
      } else {
        logger.warn(`⚠️ [Self Auth] No description found for ${key}`);
      }
      
      return selfDescription;
    } finally {
      // PRODUCTION-GRADE: Always close page, even on errors
      if (page) {
        try {
          await page.close();
        } catch (error) {
          logger.warn('⚠️ Error closing page:', error);
        }
      }
      // Release semaphore slot
      release();
    }
  } catch (error) {
    // Release semaphore even on outer error
    release();
    logger.warn(`⚠️ Failed to extract Self description with browser for ${key}:`, error);
    return null;
  }
}

/**
 * 从 HTML 中提取 campaign info（action 和 description）
 * 从 Campaign info 弹窗的表格中提取 action 和 description
 * 基于表格结构提取，不依赖具体的文字内容
 */
function extractCampaignInfo(html: string): MeritCampaignInfo[] {
  try {
    const $ = cheerio.load(html);
    const campaignInfos: MeritCampaignInfo[] = [];
    // 直接使用原始 HTML，因为 script 标签中的内容可能需要特殊处理
    const scriptContent = $('script').text();
    const rawHtml = html; // 保留原始 HTML 用于备用提取
    
    // 优先级 #1：从 HTML DOM 表格中提取（最可靠的方法）
    // 查找 Campaign info 弹窗中的表格：第一列是 Action，第二列是 Description
    $('table tbody tr').each((_index: number, element: any) => {
      const tds = $(element).find('td');
      if (tds.length >= 2) {
        const action = $(tds[0]).text().trim();
        const description = $(tds[1]).text().trim();
        
        // 只要表格有两列，就提取（不依赖文字内容验证）
        if (action && description && action.length > 0 && description.length > 0) {
          campaignInfos.push({ action, description });
        }
      }
    });
    
    // 优先级 #2：如果 DOM 中没有找到，从原始 HTML 中直接提取
    // HTML 中的格式可能是转义的：\"children\":\"Supply WETH\" 或未转义的："children":"Supply WETH"
    if (campaignInfos.length === 0) {
      // 在原始 HTML 中查找，支持转义和未转义的格式
      // 匹配格式：\"children\":\"Supply WETH\" 或 "children":"Supply WETH"
      const actionPattern = /(?:\\?"children\\?"\s*:\s*\\?")((?:Supply|Borrow|Stake|Hold)\s+[^"\\]{1,200})(?:\\?")/i;
      const actionMatch = rawHtml.match(actionPattern);
      
      if (actionMatch) {
        const action = actionMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
        const actionIndex = actionMatch.index || 0;
        
        // 在 action 之后查找 description（在 30000 字符内，因为中间可能有大量其他内容）
        const searchStart = actionIndex + actionMatch[0].length;
        
        // 查找 "Rewards are distributed" 开头的 description
        // 直接在原始 HTML 中查找（不限制在特定区域中）
        const fullRewardsIndex = rawHtml.indexOf('Rewards are distributed', searchStart);
        if (fullRewardsIndex > 0 && fullRewardsIndex < searchStart + 30000) {
          // 向前查找 "children"，向后查找结束引号
          const beforeRewards = rawHtml.substring(Math.max(0, fullRewardsIndex - 200), fullRewardsIndex);
          const childrenMatch = beforeRewards.match(/(?:\\?")?children(?:\\?")?\s*:\s*(?:\\?")/);
          
          if (childrenMatch) {
            // description 文本从 "Rewards are distributed" 开始
            const descStart = fullRewardsIndex;
            let descEnd = descStart;
            let foundEnd = false;
            
            // 向后查找结束引号（在 "Rewards are distributed..." 之后）
            // 方法：查找 "Threshold)" 或类似模式，然后找到后面的第一个 }
            // 在 HTML 中，\" 是转义的引号，所以我们需要找到真正的结束位置
            const thresholdPattern = /Threshold\)/i;
            const thresholdMatch = rawHtml.substring(descStart, descStart + 200).match(thresholdPattern);
            
            if (thresholdMatch) {
              const thresholdEnd = descStart + thresholdMatch.index! + thresholdMatch[0].length;
              // 在 Threshold) 之后查找第一个 }，然后向前找到对应的引号
              const afterThreshold = rawHtml.substring(thresholdEnd, Math.min(thresholdEnd + 50, rawHtml.length));
              const closingBraceIndex = afterThreshold.indexOf('}');
              
              if (closingBraceIndex > 0) {
                // 向前查找引号（在 Threshold) 和 } 之间）
                const between = rawHtml.substring(thresholdEnd, thresholdEnd + closingBraceIndex);
                // 查找最后一个引号（可能是转义的 \"）
                const lastQuoteIndex = between.lastIndexOf('"');
                if (lastQuoteIndex > 0) {
                  // 检查这个引号是否是转义的
                  const isEscaped = lastQuoteIndex > 0 && between[lastQuoteIndex - 1] === '\\';
                  if (isEscaped) {
                    // 如果是转义的，description 应该到 Threshold) 结束
                    descEnd = thresholdEnd;
                  } else {
                    // 如果不是转义的，description 应该到这个引号
                    descEnd = thresholdEnd + lastQuoteIndex;
                  }
                  foundEnd = true;
                } else {
                  // 如果没有找到引号，description 应该到 Threshold) 结束
                  descEnd = thresholdEnd;
                  foundEnd = true;
                }
              }
            } else {
              // 如果没有找到 Threshold)，使用原来的方法
              const maxSearch = 200;
              for (let i = descStart; i < Math.min(descStart + maxSearch, rawHtml.length) && !foundEnd; i++) {
                if (rawHtml[i] === '"') {
                  const isEscaped = i > 0 && rawHtml[i - 1] === '\\';
                  if (!isEscaped && i + 1 < rawHtml.length) {
                    const nextChar = rawHtml[i + 1];
                    if (nextChar === '}' || nextChar === ']') {
                      descEnd = i;
                      foundEnd = true;
                    }
                  }
                }
              }
            }
            
            if (foundEnd) {
              const description = rawHtml.substring(descStart, descEnd)
                .replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
              
              // 验证 description
              if (description.startsWith('Rewards are distributed') && 
                  description.length > action.length && description.length > 20 && description.length < 1000) {
                campaignInfos.push({ action, description });
              }
            }
          }
        }
      }
    }
    
    // 优先级 #3：更精确的表格行匹配（备用方案）
    // 查找格式：["$","tr",...] 中包含两个 td
    if (campaignInfos.length === 0) {
      // 查找包含两个 td 的 tr 行
      const trWithTdsPattern = /"\$","tr"[^]]*"children":\[\["\\\$","td"[^]]*"children":"([^"]{3,200})"[^]]*\],\["\\\$","td"[^]]*"children":"([^"]{20,800})"[^]]*\]/g;
      const matches = [...scriptContent.matchAll(trWithTdsPattern)];
      
      for (const match of matches) {
        const action = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
        const description = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
        
        if (action.length > 0 && description.length > action.length) {
          campaignInfos.push({ action, description });
        }
      }
    }
    
    // 去重：如果多个条目有相同的 action，只保留第一个
    const seenActions = new Set<string>();
    const uniqueInfos: MeritCampaignInfo[] = [];
    for (const info of campaignInfos) {
      if (info.action && !seenActions.has(info.action.toLowerCase())) {
        seenActions.add(info.action.toLowerCase());
        uniqueInfos.push(info);
      } else if (!info.action && info.description) {
        // 如果没有 action 但有 description，也保留
        uniqueInfos.push(info);
      }
    }
    
    return uniqueInfos.length > 0 ? uniqueInfos : [];
  } catch (error) {
    return [];
  }
}

/**
 * 获取 Merit 激励的时间范围和链接
 * 按照三层优先级策略提取数据
 * 返回包含 link、startDate、endDate、block、name 和 description 信息的对象
 */
export async function fetchMeritTimeRange(
  key: string,
  options: { hasSelfAuth?: boolean } = {}
): Promise<{ link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] }> {
  const link = `https://apps.aavechan.com/merit/${key}`;
  const result: { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] } = {
    link,
    startDate: '',
    endDate: ''
  };
  
  // 检查 key 长度，如果长度为 2（如 ethereum-sgho），跳过获取 message
  const keyParts = key.split('-');
  const shouldFetchMessage = keyParts.length > 2;
  
  try {
    // 获取页面 HTML（使用静态 fetch，name 和 date 在 SSR 中就有，不需要 Puppeteer）
    const page = await fetchMeritPageHtmlStatic(key);
    if (!page) {
      logger.warn(`⚠️ Failed to fetch HTML for key: ${key}`);
      return result;
    }
    const { html, finalKey } = page;
    // Note: redirect detection and alias recording already happened in fetchMeritPageHtmlStatic
    
    // 提取 campaign 名称（使用静态 HTML，原来方法就很好，不需要 Puppeteer）
    const name = extractCampaignName(html);
    
  const { hasSelfAuth = false } = options;

  // 只有当 key 长度大于 2 时才提取 message（Self-auth 也挂在 message 里，所以也需要）
    let message: MeritCampaignInfo[] = [];
    let messageStrategy: string | null = null;
    let selfAuthStrategy: string | null = null;
    let dateStrategy: string | null = null;

  if (shouldFetchMessage) {
    // 优先级 #1：静态 HTML 解析（零额外网络请求）
    message = extractCampaignInfo(html);
    if (message.length > 0) messageStrategy = 'message:p1:static-dom/regex';
  }

  const needDynamicCampaignInfo = shouldFetchMessage && message.length === 0;
  const needDynamicSelfAuth = hasSelfAuth;

  let dynamicSource: 'worker' | 'puppeteer' | null = null;
  if (needDynamicCampaignInfo || needDynamicSelfAuth) {
    const dynamic = await extractMeritDynamicInfoWithBrowser(key, {
      needCampaignInfo: needDynamicCampaignInfo,
      needSelfAuth: needDynamicSelfAuth,
    });
    dynamicSource = dynamic.source;

    if (needDynamicCampaignInfo && dynamic.campaignInfo.length > 0) {
      message = dynamic.campaignInfo;
      messageStrategy = `message:p2:dynamic:${dynamic.source}`;
    }

    if (needDynamicSelfAuth && dynamic.selfAuthDescription) {
      message = [
        ...(message || []),
        { action: 'Self Authentication', description: dynamic.selfAuthDescription },
      ];
      selfAuthStrategy = `self-auth:p2:dynamic:${dynamic.source}`;
      logger.info(`✅ Self Authentication description extracted for ${key} (source: ${dynamic.source})`);
    } else if (needDynamicSelfAuth && !dynamic.selfAuthDescription) {
      logger.warn(`⚠️ Self Authentication description missing for ${key} (dynamic extraction returned empty, source: ${dynamic.source})`);
      // 记录更详细的错误信息，帮助诊断问题
      if (dynamic.source === 'puppeteer') {
        logger.warn(`   → Puppeteer fallback may have failed. Check if page loaded correctly.`);
      } else if (dynamic.source === 'worker') {
        logger.warn(`   → Worker extraction may have failed or timed out.`);
      }
    }
  }
    
    if (name) {
      result.name = name;
    }
    if (message.length > 0) {
      result.message = message;
    }

    // Strategy summary (helps optimize resource usage) — logged after date strategy is decided.
    
    // 优先级 #1：从 DOM 直接提取日期（基于 class "text-xs whitespace-nowrap" 的 span 元素）
    let dates = extractDatesFromDom(html);
    if (dates.startDate && dates.endDate) {
      result.startDate = dates.startDate;
      result.endDate = dates.endDate;
      dateStrategy = 'date:p1:dom-spans';
      
      // 同时尝试提取区块号
      const blocks = extractBlockNumbers(html);
      if (blocks.startBlock) result.startBlock = blocks.startBlock;
      if (blocks.endBlock) result.endBlock = blocks.endBlock;
      
      logger.info(
        `🧠 Merit crawl strategies for ${key}: ${[
          messageStrategy ?? 'message:none',
          hasSelfAuth ? (selfAuthStrategy ?? 'self-auth:missing') : 'self-auth:n/a',
          dateStrategy ?? 'date:missing',
        ].join(' | ')}`
      );
      return result;
    }
    
    // 优先级 #2：使用正则表达式匹配各种日期格式
    dates = extractDatesWithRegex(html);
    if (dates.startDate && dates.endDate) {
      result.startDate = dates.startDate;
      result.endDate = dates.endDate;
      dateStrategy = 'date:p2:regex';
      
      // 同时尝试提取区块号
      const blocks = extractBlockNumbers(html);
      if (blocks.startBlock) result.startBlock = blocks.startBlock;
      if (blocks.endBlock) result.endBlock = blocks.endBlock;
      
      logger.info(
        `🧠 Merit crawl strategies for ${key}: ${[
          messageStrategy ?? 'message:none',
          hasSelfAuth ? (selfAuthStrategy ?? 'self-auth:missing') : 'self-auth:n/a',
          dateStrategy ?? 'date:missing',
        ].join(' | ')}`
      );
      return result;
    }
    
    // 优先级 #3：提取区块号并通过链查询转换为日期
    const blocks = extractBlockNumbers(html);
    if (blocks.startBlock || blocks.endBlock) {
      
      if (blocks.startBlock) result.startBlock = blocks.startBlock;
      if (blocks.endBlock) result.endBlock = blocks.endBlock;
      
      // 尝试通过 RPC 获取区块时间戳
      const parts = key.split('-');
      const chainName = parts[0];
      const blockDates = await convertBlocksToDates(blocks.startBlock, blocks.endBlock, chainName);
      if (blockDates.startDate) result.startDate = blockDates.startDate;
      if (blockDates.endDate) result.endDate = blockDates.endDate;
      dateStrategy = 'date:p3:block->rpc';
      
      // 如果仍然没有日期，使用空字符串（必填字段）
      if (!result.startDate) result.startDate = '';
      if (!result.endDate) result.endDate = '';
      
      logger.info(
        `🧠 Merit crawl strategies for ${key}: ${[
          messageStrategy ?? 'message:none',
          hasSelfAuth ? (selfAuthStrategy ?? 'self-auth:missing') : 'self-auth:n/a',
          dateStrategy ?? 'date:missing',
        ].join(' | ')}`
      );
      return result;
    }
    
    logger.warn(`⚠️ Could not extract time range information for key: ${key}`);
    // 即使没有找到，也返回默认值（必填字段）
    logger.info(
      `🧠 Merit crawl strategies for ${key}: ${[
        messageStrategy ?? 'message:none',
        hasSelfAuth ? (selfAuthStrategy ?? 'self-auth:missing') : 'self-auth:n/a',
        dateStrategy ?? 'date:missing',
      ].join(' | ')}`
    );
    return result;
    
  } catch (error) {
    logger.error(`❌ Error fetching time range for key ${key}:`, error);
    return result;
  }
}
