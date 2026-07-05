import * as cheerio from "cheerio";
import type { Browser, BrowserContext } from "playwright";
import { mkdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";
import { writeJsonAtomic } from "./file-utils.js";
import { toFiniteNumber } from "./utils/number.js";
import {
  extractCampaignInfoWithWorker,
  extractMeritDynamicInfoWithWorker,
  type MeritDynamicInfo,
} from "./cloudflare-browser.js";
import { meritKeyAliases } from "./config.js";
import { fifoEvict, type MeritCampaignGroup, isWithinLookbackWindow } from "@internal/aave-shared-contracts";

const MERIT_ENDED_LOOKBACK_DAYS = 7;
import {
  createMerklConcurrencyLimitedFetch,
  getAaveRpcUrlsByChainName,
} from "@internal/aave-shared-config";

const merklLimitedFetch = createMerklConcurrencyLimitedFetch(fetch);

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const RUNTIME_DATA_DIR = join(DATA_DIR, "runtime");
const DEBUG_DATA_DIR = join(DATA_DIR, "debug");
const MERKL_BASE_URL = "https://api.merkl.xyz/v4";
const MERIT_ROUND_ESTIMATE_MAX_PAGES = 12;
const MERIT_ROUND_ESTIMATE_MAX_ENTRIES = 200;
const MERIT_ROUND_POST_END_REFRESH_MS = 24 * 60 * 60 * 1000;
const MERIT_ROUND_SCAN_GLOBAL_COOLDOWN_MS = 10 * 60 * 1000;
const MERIT_CAMPAIGN_METADATA_CACHE_PATH = join(
  RUNTIME_DATA_DIR,
  "merit-campaign-metadata-cache.json"
);
const MERIT_ROUND_CREATOR_ALLOWLIST = new Set(["aave"]);
const MERIT_ROUND_CREATOR_SLUG_FILTER = "aave";

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
  apr: number; // 年化比例（上游 Merit 为百分数，入库时已 /100）
  selfApr?: number;
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

export interface MeritDataItem {
  meritSupplys: MeritCampaignGroup[];
  meritBorrows: MeritCampaignGroup[];
  /** Protocol version. Currently only V3. */
  protocolVersion: "v3" | "v4";
}

/** Merit `actionsAPR` is percent; pipeline / snapshot use annual yield ratio. */
function meritAprPercentToRatio(percent: number): number {
  return percent / 100;
}

type MeritAction = "supply" | "borrow";

interface MeritRoundEstimateBase {
  latestAmountUsd: number;
  latestCampaignId: string;
  latestCampaignStartTimestamp?: number | null;
  latestCampaignEndTimestamp?: number | null;
  latestOpportunityId?: string;
  latestOpportunityName?: string | null;
  latestOpportunityIdentifier?: string | null;
  latestOpportunityType?: string | null;
  latestOpportunityChainId?: number | null;
  latestOpportunityChainName?: string | null;
  latestOpportunityLastCampaignCreatedAt?: number | null;
  matchedAction?: MeritAction;
  matchedToken?: string;
  matchedCreatorId?: string | null;
  matchedCreatorTags?: string[];
  matchedFromSource?: string | null;
}

const isNewerMeritRoundEstimate = (
  candidate: MeritRoundEstimateBase,
  current: MeritRoundEstimateBase
): boolean => {
  const candidateEnd = candidate.latestCampaignEndTimestamp ?? 0;
  const currentEnd = current.latestCampaignEndTimestamp ?? 0;
  if (candidateEnd !== currentEnd) return candidateEnd > currentEnd;

  const candidateStart = candidate.latestCampaignStartTimestamp ?? 0;
  const currentStart = current.latestCampaignStartTimestamp ?? 0;
  if (candidateStart !== currentStart) return candidateStart > currentStart;

  const candidateCreated =
    candidate.latestOpportunityLastCampaignCreatedAt ?? 0;
  const currentCreated = current.latestOpportunityLastCampaignCreatedAt ?? 0;
  if (candidateCreated !== currentCreated)
    return candidateCreated > currentCreated;

  return false;
};

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
  pagesScannedByChain?: Record<string, number>;
  chainIdsScanned?: number[];
  hitCacheOnly: boolean;
}

type MeritCampaignMetadataEntry = {
  link: string;
  startDate: string;
  endDate: string;
  startBlock?: string;
  endBlock?: string;
  name?: string;
  message?: MeritCampaignInfo[];
  failedAt?: string;
  lastCheckedAt?: string;
};

const _meritState = {
  roundEstimateCache: null as Map<string, MeritRoundEstimateCacheEntry> | null,
  roundEstimateLastFetchMeta: null as MeritRoundEstimateFetchMeta | null,
  roundEstimateLastGlobalScanAtMs: null as number | null,
  campaignMetadataMemoryCache: null as Record<
    string,
    MeritCampaignMetadataEntry
  > | null,
  campaignMetadataLoadedFromDisk: false,
  browserInstance: null as Browser | null,
};

export function getMeritCacheStats(): {
  roundEstimateCache: number;
  campaignMetadataCache: number;
  blockNumberCache: number;
  redirectAliases: number;
  browserActive: boolean;
} {
  return {
    roundEstimateCache: _meritState.roundEstimateCache?.size ?? 0,
    campaignMetadataCache: _meritState.campaignMetadataMemoryCache
      ? Object.keys(_meritState.campaignMetadataMemoryCache).length
      : 0,
    blockNumberCache: meritCurrentBlockNumberCache.size,
    redirectAliases: discoveredRedirectAliases.size,
    browserActive: _meritState.browserInstance?.isConnected() ?? false,
  };
}

/** @internal test-only hook to reset all mutable state */
export function resetMeritState(): void {
  _meritState.roundEstimateCache = null;
  _meritState.roundEstimateLastFetchMeta = null;
  _meritState.roundEstimateLastGlobalScanAtMs = null;
  _meritState.campaignMetadataMemoryCache = null;
  _meritState.campaignMetadataLoadedFromDisk = false;
  _meritState.browserInstance = null;
}

const toIsoOrNull = (value: number | null | undefined): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
};

const CHAIN_KEY_TO_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  "ethereum-prime": 1,
  "ethereum-horizon": 1,
  "ethereum-etherfi": 1,
  optimism: 10,
  polygon: 137,
  arbitrum: 42161,
  arbitrum_one: 42161,
  base: 8453,
  avalanche: 43114,
  gnosis: 100,
  xdai: 100,
  bnb: 56,
  scroll: 534352,
  zksync: 324,
  linea: 59144,
  metis: 1088,
  metis_andromeda: 1088,
  sonic: 146,
  celo: 42220,
  soneium: 1868,
  plasma: 9745,
  ink: 57073,
  mantle: 5000,
  megaeth: 4326,
  fantom: 250,
  harmony: 1666600000,
};

const normalizeTokenSymbolForMatching = (token: string): string => {
  const raw = token
    .toLowerCase()
    .replace(/₮/g, "t")
    .replace(/[^a-z0-9]/g, "");
  if (!raw) return raw;

  const aliasMap: Record<string, string> = {
    usdte: "usdt",
    usdt0: "usdt",
    usdc0: "usdc",
  };
  return aliasMap[raw] ?? raw;
};

const parseMeritEndDateToMs = (value: string | undefined): number | null => {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isFinite(ts)) return ts;
  return null;
};

const buildMeritRoundKey = (
  chainId: number,
  action: MeritAction,
  token: string
): string => `${chainId}:${action}:${normalizeTokenSymbolForMatching(token)}`;

const extractActionTokenPairs = (
  text: string
): Array<{ action: MeritAction; token: string }> => {
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
      if (!tokenRaw || tokenRaw === "multiple") continue;
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
  if (typeof rawAmount === "string" && !rawAmount.includes(".")) {
    normalizedAmount = amount / Math.pow(10, Math.max(decimals, 0));
  }
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) return null;

  const amountUsd = normalizedAmount * price;
  return Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : null;
};

const isAllowedMeritRoundCreator = (campaign: any): boolean => {
  const creatorIdRaw = campaign?.creator?.creatorId;
  const creatorId =
    typeof creatorIdRaw === "string" ? creatorIdRaw.trim().toLowerCase() : "";
  const creatorTagsRaw = Array.isArray(campaign?.creator?.tags)
    ? campaign.creator.tags
    : [];
  const creatorTags = creatorTagsRaw
    .map((tag: unknown) =>
      typeof tag === "string" ? tag.trim().toLowerCase() : ""
    )
    .filter(Boolean);

  if (creatorId && MERIT_ROUND_CREATOR_ALLOWLIST.has(creatorId)) return true;
  if (creatorTags.some((tag: string) => MERIT_ROUND_CREATOR_ALLOWLIST.has(tag)))
    return true;
  return false;
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
    chainId: "{chainId}",
    status: "PAST",
    type: "JSON_AIRDROP",
    campaigns: "true",
    items: "100",
    creatorSlug: MERIT_ROUND_CREATOR_SLUG_FILTER,
    page: "{page}",
  });
  const requestTemplateUrl = `${MERKL_BASE_URL}/opportunities?${paramsTemplate.toString()}`;
  const firstPageUrl = requestTemplateUrl
    .replace("chainId=%7BchainId%7D", "chainId=42220")
    .replace("page=%7Bpage%7D", "page=0");
  let pagesScanned = 0;
  const cache =
    _meritState.roundEstimateCache ??
    new Map<string, MeritRoundEstimateCacheEntry>();
  if (!_meritState.roundEstimateCache) {
    _meritState.roundEstimateCache = cache;
  }

  const targetEntries =
    targets && targets.size > 0 ? Array.from(targets.entries()) : [];
  const dueKeys = new Set<string>(
    targetEntries
      .filter(([key, target]) =>
        shouldRefreshMeritRoundEstimate(target, cache.get(key), nowMs)
      )
      .map(([key]) => key)
  );
  const keysToFetch =
    dueKeys.size > 0
      ? new Set<string>(targetEntries.map(([key]) => key))
      : new Set<string>();

  if (
    targetEntries.length > 0 &&
    dueKeys.size > 0 &&
    _meritState.roundEstimateLastGlobalScanAtMs !== null &&
    nowMs - _meritState.roundEstimateLastGlobalScanAtMs <
      MERIT_ROUND_SCAN_GLOBAL_COOLDOWN_MS
  ) {
    _meritState.roundEstimateLastFetchMeta = {
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

  // If no target key is due, return cached estimates directly.
  if (targetEntries.length > 0 && keysToFetch.size === 0) {
    _meritState.roundEstimateLastFetchMeta = {
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
  const baselineEstimates = new Map<string, MeritRoundEstimateBase>();
  targetEntries.forEach(([key]) => {
    const cached = cache.get(key)?.estimate;
    if (cached) baselineEstimates.set(key, cached);
  });
  const targetChainIds = Array.from(
    new Set(
      targetEntries
        .map(([key]) => {
          const [rawChainId] = key.split(":");
          const parsed = Number(rawChainId);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        })
        .filter((value): value is number => value !== null)
    )
  );
  const chainIdsToScan = targetChainIds.length > 0 ? targetChainIds : [null];
  const pagesScannedByChain: Record<string, number> = {};
  let creatorSlugFallbackUsed = false;

  for (const scanChainId of chainIdsToScan) {
    const chainKey = scanChainId === null ? "all" : String(scanChainId);
    pagesScannedByChain[chainKey] = 0;
    for (let page = 0; page < MERIT_ROUND_ESTIMATE_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        status: "PAST",
        type: "JSON_AIRDROP",
        campaigns: "true",
        items: "100",
        page: String(page),
        creatorSlug: MERIT_ROUND_CREATOR_SLUG_FILTER,
      });
      if (scanChainId !== null) {
        params.set("chainId", String(scanChainId));
      }
      let response = await merklLimitedFetch(
        `${MERKL_BASE_URL}/opportunities?${params.toString()}`
      );
      if (!response.ok) {
        await response.text().catch(() => {});
        params.delete("creatorSlug");
        response = await merklLimitedFetch(
          `${MERKL_BASE_URL}/opportunities?${params.toString()}`
        );
        if (response.ok && !creatorSlugFallbackUsed) {
          creatorSlugFallbackUsed = true;
          logger.warn(
            `⚠️ Merkl opportunities query with creatorSlug failed once; fallback to query without creatorSlug`
          );
        }
      }
      if (!response.ok) {
        throw new Error(`Merkl opportunities failed (${response.status})`);
      }
      const payload = (await response.json()) as any;
      if (!Array.isArray(payload)) break;
      pagesScanned += 1;
      pagesScannedByChain[chainKey] += 1;

      for (const opportunity of payload) {
        const opportunityId = String(opportunity?.id ?? "");
        if (!opportunityId) continue;

        const chainId = toFiniteNumber(opportunity?.chainId);
        if (chainId === null || chainId <= 0) continue;

        const campaigns = Array.isArray(opportunity?.campaigns)
          ? opportunity.campaigns
          : [];
        if (campaigns.length === 0) continue;

        for (const campaign of campaigns) {
          if (!isAllowedMeritRoundCreator(campaign)) continue;

          const amountUsd = extractAirdropAmountUsd(campaign);
          if (amountUsd === null) continue;

          const startTimestamp = toFiniteNumber(campaign?.startTimestamp);
          const endTimestamp = toFiniteNumber(campaign?.endTimestamp);
          if (
            startTimestamp === null ||
            endTimestamp === null ||
            endTimestamp <= startTimestamp
          )
            continue;

          const campaignId = String(campaign?.id ?? "");
          if (!campaignId) continue;

          const textSources = [
            { source: "opportunity.name", text: opportunity?.name },
            { source: "campaign.params.url", text: campaign?.params?.url },
          ].filter(
            (entry): entry is { source: string; text: string } =>
              typeof entry.text === "string" && entry.text.trim().length > 0
          );

          const creatorIdRaw = campaign?.creator?.creatorId;
          const creatorId =
            typeof creatorIdRaw === "string" && creatorIdRaw.trim().length > 0
              ? creatorIdRaw.trim()
              : null;
          const creatorTags = Array.isArray(campaign?.creator?.tags)
            ? campaign.creator.tags.filter(
                (tag: unknown): tag is string =>
                  typeof tag === "string" && tag.trim().length > 0
              )
            : [];
          const opportunityChainName =
            typeof opportunity?.chain?.name === "string"
              ? opportunity.chain.name
              : typeof opportunity?.chainName === "string"
                ? opportunity.chainName
                : null;
          const opportunityType =
            typeof opportunity?.type === "string" ? opportunity.type : null;
          const opportunityIdentifier =
            typeof opportunity?.identifier === "string"
              ? opportunity.identifier
              : null;
          const opportunityLastCampaignCreatedAt = toFiniteNumber(
            opportunity?.lastCampaignCreatedAt
          );

          for (const textSource of textSources) {
            const pairs = extractActionTokenPairs(textSource.text);
            if (pairs.length === 0) continue;

            for (const { action, token } of pairs) {
              const key = buildMeritRoundKey(chainId, action, token);
              if (targets && !targets.has(key)) continue;
              if (keysToFetch.size > 0 && !keysToFetch.has(key)) continue;
              const nextEstimate: MeritRoundEstimateBase = {
                latestAmountUsd: amountUsd,
                latestCampaignId: campaignId,
                latestCampaignStartTimestamp: startTimestamp,
                latestCampaignEndTimestamp: endTimestamp,
                latestOpportunityId: opportunityId,
                latestOpportunityName:
                  typeof opportunity?.name === "string"
                    ? opportunity.name
                    : null,
                latestOpportunityIdentifier: opportunityIdentifier,
                latestOpportunityType: opportunityType,
                latestOpportunityChainId: chainId,
                latestOpportunityChainName: opportunityChainName,
                latestOpportunityLastCampaignCreatedAt:
                  opportunityLastCampaignCreatedAt,
                matchedAction: action,
                matchedToken: token,
                matchedCreatorId: creatorId,
                matchedCreatorTags: creatorTags,
                matchedFromSource: textSource.source,
              };
              const existingOrBaseline =
                fetchedEstimates.get(key) ?? baselineEstimates.get(key);
              if (
                existingOrBaseline &&
                !isNewerMeritRoundEstimate(nextEstimate, existingOrBaseline)
              )
                continue;

              fetchedEstimates.set(key, nextEstimate);
            }
          }
        }
      }

      if (payload.length < 100) break;
      // Do not exit early when all targets have a match:
      // Merkl PAST ordering is not reliably "latest round first" for these JSON_AIRDROP entries.
      // We keep scanning (bounded by maxPages) and let timestamp comparison choose the newest match.
    }
  }

  if (pagesScanned > 0) {
    _meritState.roundEstimateLastGlobalScanAtMs = nowMs;
  }

  // Update per-key cache entries (including negative-cache timestamps for misses).
  // When a scan runs, stamp all current target keys together to reduce repeated scans.
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

  for (const [key, entry] of cache) {
    if (nowMs - entry.lastCheckedAtMs > 2 * MERIT_ROUND_POST_END_REFRESH_MS) {
      cache.delete(key);
    }
  }
  fifoEvict(cache, MERIT_ROUND_ESTIMATE_MAX_ENTRIES);

  const result = new Map<string, MeritRoundEstimateBase>();
  _meritState.roundEstimateLastFetchMeta = {
    requestTemplateUrl,
    firstPageUrl,
    pagesScanned,
    pagesScannedByChain,
    chainIdsScanned: targetChainIds,
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
): Record<
  string,
  { cycleEndTsMs: number | null; cycleEndIso: string | null }
> => {
  const serialized: Record<
    string,
    { cycleEndTsMs: number | null; cycleEndIso: string | null }
  > = {};
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
): Record<
  string,
  { lastRoundRewardUsd: number; lastRoundCampaignId: string }
> => {
  const serialized: Record<
    string,
    {
      lastRoundRewardUsd: number;
      lastRoundCampaignId: string;
      lastRoundCampaignStartTimestamp: number | null;
      lastRoundCampaignEndTimestamp: number | null;
      lastRoundOpportunityId: string | null;
      lastRoundOpportunityName: string | null;
      lastRoundOpportunityIdentifier: string | null;
      lastRoundOpportunityType: string | null;
      lastRoundOpportunityChainId: number | null;
      lastRoundOpportunityChainName: string | null;
      lastRoundOpportunityLastCampaignCreatedAt: number | null;
      matchedAction: MeritAction | null;
      matchedToken: string | null;
      matchedCreatorId: string | null;
      matchedCreatorTags: string[];
      matchedFromSource: string | null;
    }
  > = {};
  for (const [key, estimate] of estimates.entries()) {
    serialized[key] = {
      lastRoundRewardUsd: estimate.latestAmountUsd,
      lastRoundCampaignId: estimate.latestCampaignId,
      lastRoundCampaignStartTimestamp:
        estimate.latestCampaignStartTimestamp ?? null,
      lastRoundCampaignEndTimestamp:
        estimate.latestCampaignEndTimestamp ?? null,
      lastRoundOpportunityId: estimate.latestOpportunityId ?? null,
      lastRoundOpportunityName: estimate.latestOpportunityName ?? null,
      lastRoundOpportunityIdentifier:
        estimate.latestOpportunityIdentifier ?? null,
      lastRoundOpportunityType: estimate.latestOpportunityType ?? null,
      lastRoundOpportunityChainId: estimate.latestOpportunityChainId ?? null,
      lastRoundOpportunityChainName:
        estimate.latestOpportunityChainName ?? null,
      lastRoundOpportunityLastCampaignCreatedAt:
        estimate.latestOpportunityLastCampaignCreatedAt ?? null,
      matchedAction: estimate.matchedAction ?? null,
      matchedToken: estimate.matchedToken ?? null,
      matchedCreatorId: estimate.matchedCreatorId ?? null,
      matchedCreatorTags: estimate.matchedCreatorTags ?? [],
      matchedFromSource: estimate.matchedFromSource ?? null,
    };
  }
  return serialized;
};

const serializeMeritRoundEstimateCache = () => {
  if (!_meritState.roundEstimateCache) return {};

  const serialized: Record<
    string,
    {
      lastRoundRewardUsd: number | null;
      lastRoundCampaignId: string | null;
      lastRoundCampaignStartTimestamp: number | null;
      lastRoundCampaignEndTimestamp: number | null;
      lastRoundOpportunityId: string | null;
      lastRoundOpportunityName: string | null;
      lastRoundOpportunityIdentifier: string | null;
      lastRoundOpportunityType: string | null;
      lastRoundOpportunityChainId: number | null;
      lastRoundOpportunityChainName: string | null;
      lastRoundOpportunityLastCampaignCreatedAt: number | null;
      matchedAction: MeritAction | null;
      matchedToken: string | null;
      matchedCreatorId: string | null;
      matchedCreatorTags: string[];
      matchedFromSource: string | null;
      lastCheckedAtMs: number;
      lastCheckedAtIso: string | null;
      miss: boolean;
    }
  > = {};

  for (const [key, entry] of _meritState.roundEstimateCache.entries()) {
    serialized[key] = {
      lastRoundRewardUsd: entry.estimate?.latestAmountUsd ?? null,
      lastRoundCampaignId: entry.estimate?.latestCampaignId ?? null,
      lastRoundCampaignStartTimestamp:
        entry.estimate?.latestCampaignStartTimestamp ?? null,
      lastRoundCampaignEndTimestamp:
        entry.estimate?.latestCampaignEndTimestamp ?? null,
      lastRoundOpportunityId: entry.estimate?.latestOpportunityId ?? null,
      lastRoundOpportunityName: entry.estimate?.latestOpportunityName ?? null,
      lastRoundOpportunityIdentifier:
        entry.estimate?.latestOpportunityIdentifier ?? null,
      lastRoundOpportunityType: entry.estimate?.latestOpportunityType ?? null,
      lastRoundOpportunityChainId:
        entry.estimate?.latestOpportunityChainId ?? null,
      lastRoundOpportunityChainName:
        entry.estimate?.latestOpportunityChainName ?? null,
      lastRoundOpportunityLastCampaignCreatedAt:
        entry.estimate?.latestOpportunityLastCampaignCreatedAt ?? null,
      matchedAction: entry.estimate?.matchedAction ?? null,
      matchedToken: entry.estimate?.matchedToken ?? null,
      matchedCreatorId: entry.estimate?.matchedCreatorId ?? null,
      matchedCreatorTags: entry.estimate?.matchedCreatorTags ?? [],
      matchedFromSource: entry.estimate?.matchedFromSource ?? null,
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
  if (
    parts.length >= 2 &&
    parts[0] === "ethereum" &&
    parts[1] !== "supply" &&
    parts[1] !== "borrow"
  ) {
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
  return getAaveRpcUrlsByChainName(chainName);
}

/**
 * 获取当前区块号（用于判断 campaign 是否结束）
 */
async function getCurrentBlockNumber(
  chainName: string
): Promise<number | null> {
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
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_blockNumber",
            params: [],
            id: 1,
          }),
        });

        if (!response.ok) {
          await response.text().catch(() => {});
          continue;
        }

        const data = (await response.json()) as { result?: string };
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

const MERIT_BLOCK_NUMBER_CACHE_TTL_MS = 60_000;
const MAX_BLOCK_NUMBER_CACHE_ENTRIES = 50;

const meritCurrentBlockNumberCache = new Map<
  string,
  { fetchedAtMs: number; blockNumber: number | null }
>();

function pruneBlockNumberCache(nowMs: number): void {
  for (const [key, entry] of meritCurrentBlockNumberCache) {
    if (nowMs - entry.fetchedAtMs > MERIT_BLOCK_NUMBER_CACHE_TTL_MS) {
      meritCurrentBlockNumberCache.delete(key);
    }
  }
  fifoEvict(meritCurrentBlockNumberCache, MAX_BLOCK_NUMBER_CACHE_ENTRIES);
}

async function getCurrentBlockNumberCached(
  chainName: string
): Promise<number | null> {
  const nowMs = Date.now();
  const cached = meritCurrentBlockNumberCache.get(chainName);
  if (cached && nowMs - cached.fetchedAtMs < MERIT_BLOCK_NUMBER_CACHE_TTL_MS) {
    return cached.blockNumber;
  }

  pruneBlockNumberCache(nowMs);
  const blockNumber = await getCurrentBlockNumber(chainName);
  meritCurrentBlockNumberCache.set(chainName, {
    fetchedAtMs: nowMs,
    blockNumber,
  });
  return blockNumber;
}

function parseMeritEndDate(endDateRaw?: string): Date | null {
  if (!endDateRaw || endDateRaw.trim() === "") {
    return null;
  }
  const parsed = new Date(endDateRaw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hasEndedByMeritEndDate(
  endDateRaw: string | undefined,
  nowMs = Date.now()
): boolean {
  const parsedEndDate = parseMeritEndDate(endDateRaw);
  if (!parsedEndDate) {
    return false;
  }
  return parsedEndDate.getTime() < nowMs;
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function isMeritCampaignMetadataEnded(endDateRaw?: string): boolean {
  return hasEndedByMeritEndDate(endDateRaw);
}

export function filterRecentExpiredMeritCampaigns(groups: MeritCampaignGroup[]): MeritCampaignGroup[] {
  const nowMs = Date.now();
  const active = groups.filter(g => {
    const bd = g.breakdowns ?? [];
    return bd.length === 0 || bd.some(b => !b.campaignEndedAt || new Date(b.campaignEndedAt).getTime() >= nowMs);
  });
  const recentlyEnded = groups.filter(g => {
    const bd = g.breakdowns ?? [];
    if (bd.length === 0) return false;
    if (!bd.every(b => b.campaignEndedAt && new Date(b.campaignEndedAt).getTime() < nowMs)) return false;
    return bd.some(b => isWithinLookbackWindow(b.campaignEndedAt, nowMs, MERIT_ENDED_LOOKBACK_DAYS));
  });
  if (recentlyEnded.length === 0) return active;
  const latest = recentlyEnded.reduce((a, b) => {
    const aEnd = Math.max(...(a.breakdowns ?? []).map(bd => bd.campaignEndedAt ? new Date(bd.campaignEndedAt).getTime() : 0));
    const bEnd = Math.max(...(b.breakdowns ?? []).map(bd => bd.campaignEndedAt ? new Date(bd.campaignEndedAt).getTime() : 0));
    return aEnd >= bEnd ? a : b;
  });
  return [...active, latest];
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
function clearMeritCampaignMetadataMemoryCache(): void {
  _meritState.campaignMetadataMemoryCache = null;
  _meritState.campaignMetadataLoadedFromDisk = false;
}

async function loadCachedMeritCampaignMetadata(): Promise<
  Record<string, MeritCampaignMetadataEntry>
> {
  if (_meritState.campaignMetadataMemoryCache) {
    return _meritState.campaignMetadataMemoryCache;
  }
  if (_meritState.campaignMetadataLoadedFromDisk) {
    return {};
  }
  try {
    let parsed: any = null;
    let loadedFromPath: string | null = null;
    let loadedFromLabel: string | null = null;

    const candidates = [
      {
        path: MERIT_CAMPAIGN_METADATA_CACHE_PATH,
        label: "merit-campaign-metadata-cache.json",
      },
      {
        path: join(DEBUG_DATA_DIR, "merit-raw-data.json"),
        label: "debug/merit-raw-data.json",
      },
      {
        path: join(DATA_DIR, "merit-raw-data.json"),
        label: "merit-raw-data.json (legacy)",
      },
    ];

    for (const candidate of candidates) {
      try {
        const cachedData = await readFile(candidate.path, "utf-8");
        parsed = JSON.parse(cachedData);
        loadedFromPath = candidate.path;
        loadedFromLabel = candidate.label;
        break;
      } catch {
        // Try next cache source
      }
    }

    if (!parsed) {
      throw new Error("No cached merit campaign metadata source available");
    }
    const timeRanges = parsed.campaignMetadataByKey || {};

    // 验证缓存数据的完整性：确保每个条目都有全量数据
    const validatedTimeRanges: Record<string, MeritCampaignMetadataEntry> = {};

    for (const [key, value] of Object.entries(timeRanges)) {
      const timeRange = value as {
        link?: string;
        startDate?: string;
        endDate?: string;
        startBlock?: string;
        endBlock?: string;
        name?: string;
        message?: MeritCampaignInfo[];
      };

      const hasLinkAndStart =
        timeRange.link &&
        timeRange.link.trim() !== "" &&
        timeRange.startDate &&
        timeRange.startDate.trim() !== "";

      const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/;
      const datesAreIso =
        (!timeRange.startDate || ISO_DATE_PATTERN.test(timeRange.startDate)) &&
        (!timeRange.endDate || timeRange.endDate.trim() === "" || ISO_DATE_PATTERN.test(timeRange.endDate));

      const hasBlockFields =
        timeRange.startBlock &&
        timeRange.startBlock.trim() !== "" &&
        timeRange.endBlock &&
        timeRange.endBlock.trim() !== "";

      const hasName = timeRange.name !== undefined;

      const hasEndIndicator =
        (timeRange.endDate && timeRange.endDate.trim() !== "") ||
        (timeRange.endBlock && timeRange.endBlock.trim() !== "");

      const keyParts = key.split("-");
      const shouldHaveMessage = keyParts.length > 2;
      const hasMessage =
        !shouldHaveMessage || timeRange.message !== undefined;

      const isValidEntry =
        hasLinkAndStart && hasName && datesAreIso && (hasEndIndicator || hasBlockFields || timeRange.endDate !== undefined) && hasMessage;

      if (isValidEntry) {
        if (timeRange.startBlock || timeRange.endBlock) {
          if (!hasBlockFields) {
            logger.warn(
              `⚠️ Cached entry "${key}" has partial block fields, will refetch`
            );
            continue;
          }
        }

        validatedTimeRanges[key] = {
          link: timeRange.link!,
          startDate: timeRange.startDate!,
          endDate: timeRange.endDate ?? "",
          ...(timeRange.startBlock ? { startBlock: timeRange.startBlock } : {}),
          ...(timeRange.endBlock ? { endBlock: timeRange.endBlock } : {}),
          ...(timeRange.name !== undefined ? { name: timeRange.name } : {}),
          ...(timeRange.message !== undefined
            ? { message: timeRange.message }
            : {}),
        };
      } else {
        const missingFields: string[] = [];
        if (!hasLinkAndStart) missingFields.push("link/startDate");
        if (!hasName) missingFields.push("name");
        if (!hasEndIndicator && timeRange.endDate === undefined)
          missingFields.push("endDate/endBlock");
        if (!hasMessage && shouldHaveMessage) missingFields.push("message");
        if (!datesAreIso) missingFields.push("iso-dates");
        logger.warn(
          `⚠️ Cached entry "${key}" missing fields: ${missingFields.join(", ")}, will refetch`
        );
      }
    }

    const filteredCount =
      Object.keys(timeRanges).length - Object.keys(validatedTimeRanges).length;
    if (filteredCount > 0) {
      logger.info(
        `📦 Filtered out ${filteredCount} incomplete cached entries (missing required fields), will refetch them`
      );
    }
    if (loadedFromPath && loadedFromLabel) {
      logger.info(
        `📦 Loaded Merit campaign metadata cache from ${loadedFromLabel}`
      );
    }

    _meritState.campaignMetadataMemoryCache = validatedTimeRanges;
    _meritState.campaignMetadataLoadedFromDisk = true;
    return _meritState.campaignMetadataMemoryCache;
  } catch (error) {
    // 文件不存在或解析失败，返回空对象（会触发所有条目重新获取）
    logger.info(
      "📦 No cached merit campaign metadata found, will fetch all entries"
    );
    _meritState.campaignMetadataLoadedFromDisk = true;
    return {};
  }
}

function getHasSelfAuthForKey(
  meritAPRs: Record<string, number | null>,
  key: string
): boolean {
  return (
    meritAPRs[`self-${key}`] !== null && meritAPRs[`self-${key}`] !== undefined
  );
}

function hasSelfAuthMessage(message: MeritCampaignInfo[] | undefined): boolean {
  return !!message?.some((m) =>
    (m.action || "").toLowerCase().includes("self authentication")
  );
}

export function isCachedTimeRangeComplete(params: {
  key: string;
  cached:
    | {
        link?: string;
        startDate?: string;
        endDate?: string;
        startBlock?: string;
        endBlock?: string;
        name?: string;
        message?: MeritCampaignInfo[];
      }
    | undefined;
  hasSelfAuth: boolean;
}): { isComplete: boolean; missing: string[] } {
  const { key, cached, hasSelfAuth } = params;
  const missing: string[] = [];
  if (!cached) return { isComplete: false, missing: ["missing-cache"] };

  const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/;
  const linkOk = !!cached.link && cached.link.trim() !== "";
  const startDateOk = !!cached.startDate && cached.startDate.trim() !== "";
  const startDateIsoOk = !cached.startDate || ISO_DATE_PATTERN.test(cached.startDate);
  const endDateOk = cached.endDate !== undefined;
  const endDateIsoOk = !cached.endDate || cached.endDate.trim() === "" || ISO_DATE_PATTERN.test(cached.endDate);
  const nameOk = cached.name !== undefined;
  const hasEndIndicatorOk =
    (cached.endDate !== undefined && cached.endDate.trim() !== "") ||
    (!!cached.endBlock && cached.endBlock.trim() !== "");

  if (!linkOk) missing.push("link");
  if (!startDateOk) missing.push("startDate");
  if (!startDateIsoOk) missing.push("startDate-iso");
  if (!endDateOk) missing.push("endDate");
  if (!endDateIsoOk) missing.push("endDate-iso");
  if (!nameOk) missing.push("name");
  if (!hasEndIndicatorOk && cached.endDate === undefined)
    missing.push("endDate/endBlock");

  const keyParts = key.split("-");
  const shouldHaveMessage = keyParts.length > 2;
  if (shouldHaveMessage) {
    const msgOk = cached.message !== undefined;
    if (!msgOk) missing.push("message");
  }

  // Block fields: if one exists, require both
  const hasAnyBlock = !!cached.startBlock || !!cached.endBlock;
  if (hasAnyBlock) {
    const startBlockOk = !!cached.startBlock && cached.startBlock.trim() !== "";
    const endBlockOk = !!cached.endBlock && cached.endBlock.trim() !== "";
    if (!startBlockOk || !endBlockOk) missing.push("startBlock/endBlock");
  }

  // Self-auth required only when the self- key exists for this campaign
  // and message was fetched with actual content
  if (hasSelfAuth && shouldHaveMessage && cached.message && cached.message.length > 0) {
    if (!hasSelfAuthMessage(cached.message)) missing.push("self-auth");
  }

  return { isComplete: missing.length === 0, missing };
}

/**
 * 获取 Merit APR 数据并构建索引
 * 优化：非 APR 数据（timeRanges、message 等）只在 campaign 结束时更新
 */
export async function fetchMeritData(): Promise<Record<string, MeritDataItem>> {
  try {
    discoveredRedirectAliases.clear();
    logger.info("🎁 Fetching Merit APR data...");
    const response = await fetch("https://apps.aavechan.com/api/merit/aprs");

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = (await response.json()) as MeritAPRResponse;
    logger.info(`✅ Merit APR data fetched successfully`);

    const meritAPRs = data.currentAPR.actionsAPR;

    // 加载缓存的 timeRanges 数据
    const cachedTimeRanges = await loadCachedMeritCampaignMetadata();
    logger.info(
      `📦 Loaded ${Object.keys(cachedTimeRanges).length} cached time ranges`
    );

    // 获取时间范围信息（只在需要时更新）
    const timeRanges = await fetchAllMeritTimeRanges(meritAPRs, {
      maxConcurrent: 5,
      cachedTimeRanges,
    });

    // 建立 Merit APR 数据索引
    // 作用：将原始 Merit APR 数据（键格式复杂，如 "ethereum-supply-weth"）转换为统一的索引格式
    // 输入：Record<string, number | null> - 原始数据，键可能包含多种格式（supply/borrow/prime/multiple/self- 等）
    // 输出：Record<chain-token, {...}> - 统一索引，键为 "chain-token" 格式（如 "ethereum-weth"）
    logger.info("🔍 Indexing Merit APR data...");
    const meritData: Record<string, MeritDataItem> = {};

    function createIndexEntry(indexKey: string) {
      if (!(indexKey in meritData)) {
        meritData[indexKey] = {
          meritSupplys: [],
          meritBorrows: [],
          protocolVersion: "v3",
        };
      }
      return meritData[indexKey]!;
    }

    // 获取 key 对应的 link、时间范围、block、name 和 message 信息（处理 self- 前缀）
    function getLinkAndTimeRange(key: string): {
      link: string;
      startDate: string;
      endDate: string;
      startBlock?: string;
      endBlock?: string;
      name?: string;
      message?: MeritCampaignInfo[];
    } {
      const isSelfFormat = key.startsWith("self-");
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
          ...(timeRangeData.name !== undefined && { name: timeRangeData.name }),
          ...(timeRangeData.message !== undefined && {
            message: timeRangeData.message,
          }),
        };
      }

      // 如果找不到，返回默认值
      return {
        link: `https://apps.aavechan.com/merit/${baseKey}`,
        startDate: "",
        endDate: "",
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

      const parts = key.split("-");
      if (parts.length < 2) return;

      const isSelfFormat = key.startsWith("self-");
      const actualKey = isSelfFormat ? key.substring(5) : key;
      const actualParts = actualKey.split("-");

      if (actualParts.length < 2) return;

      const chainKey = parseChainKey(actualParts);

      let supplyTokens: string[] = [];
      let borrowTokens: string[] = [];

      if (actualKey.includes("-supply-") && actualKey.includes("-borrow-")) {
        const supplyIndex = actualParts.indexOf("supply");
        const borrowIndex = actualParts.indexOf("borrow");
        if (supplyIndex >= 0 && borrowIndex >= 0) {
          const rawSupplyToken = actualParts
            .slice(supplyIndex + 1, borrowIndex)
            .join("-");
          const rawBorrowToken = actualParts.slice(borrowIndex + 1).join("-");
          supplyTokens = rawSupplyToken.includes("-or-")
            ? rawSupplyToken
                .split("-or-")
                .map((t) => t.toLowerCase())
                .filter(Boolean)
            : rawSupplyToken
              ? [rawSupplyToken.toLowerCase()]
              : [];
          borrowTokens = rawBorrowToken.includes("-or-")
            ? rawBorrowToken
                .split("-or-")
                .map((t) => t.toLowerCase())
                .filter(Boolean)
            : rawBorrowToken
              ? [rawBorrowToken.toLowerCase()]
              : [];
        }
      } else if (actualKey.includes("-supply-")) {
        const token = actualParts[actualParts.length - 1].toLowerCase();
        if (token) supplyTokens = [token];
      } else if (actualKey.includes("-borrow-")) {
        const token = actualParts[actualParts.length - 1].toLowerCase();
        if (token) borrowTokens = [token];
      } else if (actualParts.length === 2) {
        const token = actualParts[1].toLowerCase();
        if (token) supplyTokens = [token];
      }

      if (supplyTokens.length > 0 || borrowTokens.length > 0) {
        const info: KeyInfo = {
          key,
          value,
          isSelf: isSelfFormat,
          supplyTokens,
          borrowTokens,
          chainKey,
        };

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
    const collectTargetMeritRoundTargets = (): Map<
      string,
      MeritRoundEstimateTarget
    > => {
      const targets = new Map<string, MeritRoundEstimateTarget>();
      for (const [baseKey, group] of baseKeyMap.entries()) {
        const nonSelfInfo = group.nonSelf;
        const selfInfo = group.self;
        const keyForTimeRange = nonSelfInfo?.key || selfInfo?.key || baseKey;
        const { endDate } = getLinkAndTimeRange(keyForTimeRange);
        const cycleEndTsMs = parseMeritEndDateToMs(endDate);

        const candidate = nonSelfInfo;
        if (!candidate) continue;
        const chainId = CHAIN_KEY_TO_CHAIN_ID[candidate.chainKey.toLowerCase()];
        if (!chainId) continue;

        candidate.supplyTokens.forEach((token) => {
          if (!token || token === "multiple") return;
          const key = buildMeritRoundKey(chainId, "supply", token);
          targets.set(key, { cycleEndTsMs });
        });
        candidate.borrowTokens.forEach((token) => {
          if (!token || token === "multiple") return;
          const key = buildMeritRoundKey(chainId, "borrow", token);
          targets.set(key, { cycleEndTsMs });
        });
      }
      return targets;
    };

    const targetMeritRoundTargets = collectTargetMeritRoundTargets();
    const meritRoundEstimates = await fetchMeritRoundEstimates(
      targetMeritRoundTargets
    ).catch((error) => {
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
      const keyParts = baseKey.split("-");
      const shouldFetchMessage = keyParts.length > 2;

      // 决定使用哪个 key 获取时间范围（优先使用 nonSelf，因为 self 会跳过获取时间范围）
      const keyForTimeRange = nonSelfInfo?.key || selfInfo?.key || baseKey;
      const { link, startDate, endDate, startBlock, endBlock, name, message } =
        getLinkAndTimeRange(keyForTimeRange);

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

      const MERIT_LINK_PREFIX = 'https://apps.aavechan.com/merit/';
      const meritKey = link.startsWith(MERIT_LINK_PREFIX)
        ? link.slice(MERIT_LINK_PREFIX.length)
        : undefined;

      const borrowTargets = borrowTokens.filter((t) => t !== "multiple");
      const supplyTargets = supplyTokens.filter((t) => t !== "multiple");
      const hasBorrowTokens = borrowTargets.length > 0;
      const hasBorrowMultiple = borrowTokens.includes("multiple");
      const hasSupplyTokens = supplyTargets.length > 0;

      // 情况 1: borrowToken 不是 'multiple'，为每个 borrow token 分别处理
      if (hasBorrowTokens) {
        for (const bt of borrowTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${bt.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);
          const campaignKey = meritKey ?? `${indexKey}-borrow`;

          if (supplyTokens.length > 0) {
            const estimate = getMeritEstimateForEntry(
              meritRoundEstimates,
              chainKey,
              "borrow",
              bt
            );
            const entry: MeritAprEntry = {
              apr: meritAprPercentToRatio(aprValue!),
              ...(selfAprValue != null && Number.isFinite(selfAprValue)
                ? { selfApr: meritAprPercentToRatio(selfAprValue) }
                : {}),
              requiredSupplyTokens: supplyTokens,
              link,
              startDate,
              endDate,
              startBlock,
              endBlock,
              ...(name && { name }),
              ...(finalMessage.length > 0 && { message: finalMessage }),
              ...(estimate ?? {}),
            };
            incentives.meritBorrows.push(buildCampaignGroupFromMeritEntry(entry, campaignKey));
          } else {
            const estimate = getMeritEstimateForEntry(
              meritRoundEstimates,
              chainKey,
              "borrow",
              bt
            );
            const entry: MeritAprEntry = {
              apr: meritAprPercentToRatio(aprValue!),
              ...(selfAprValue != null && Number.isFinite(selfAprValue)
                ? { selfApr: meritAprPercentToRatio(selfAprValue) }
                : {}),
              link,
              startDate,
              endDate,
              startBlock,
              endBlock,
              ...(name && { name }),
              ...(finalMessage.length > 0 && { message: finalMessage }),
              ...(estimate ?? {}),
            };
            incentives.meritBorrows.push(buildCampaignGroupFromMeritEntry(entry, campaignKey));
          }
        }

        if (hasSupplyTokens) {
          for (const st of supplyTargets) {
            const supplyIndexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
            const supplyIncentives = createIndexEntry(supplyIndexKey);
            const campaignKey = meritKey ?? `${supplyIndexKey}-supply`;
            const estimate = getMeritEstimateForEntry(
              meritRoundEstimates,
              chainKey,
              "supply",
              st
            );
            const entry: MeritAprEntry = {
              apr: meritAprPercentToRatio(aprValue!),
              ...(selfAprValue != null && Number.isFinite(selfAprValue)
                ? { selfApr: meritAprPercentToRatio(selfAprValue) }
                : {}),
              requiredBorrowTokens: borrowTokens,
              link,
              startDate,
              endDate,
              startBlock,
              endBlock,
              ...(name && { name }),
              ...(finalMessage.length > 0 && { message: finalMessage }),
              ...(estimate ?? {}),
            };
            supplyIncentives.meritSupplys.push(buildCampaignGroupFromMeritEntry(entry, campaignKey));
          }
        }
      }

      // 情况 2: borrowToken 是 'multiple'，为每个 supply token 分别处理
      if (hasBorrowMultiple && hasSupplyTokens) {
        for (const st of supplyTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);
          const campaignKey = meritKey ?? `${indexKey}-supply`;
          const estimate = getMeritEstimateForEntry(
            meritRoundEstimates,
            chainKey,
            "supply",
            st
          );
          const entry: MeritAprEntry = {
            apr: meritAprPercentToRatio(aprValue!),
            ...(selfAprValue != null && Number.isFinite(selfAprValue)
              ? { selfApr: meritAprPercentToRatio(selfAprValue) }
              : {}),
            requiredBorrowTokens: ["multiple"],
            link,
            startDate,
            endDate,
            startBlock,
            endBlock,
            ...(name && { name }),
            ...(finalMessage.length > 0 && { message: finalMessage }),
            ...(estimate ?? {}),
          };
          incentives.meritSupplys.push(buildCampaignGroupFromMeritEntry(entry, campaignKey));
        }
      }

      // 情况 3: 只有 supply token，没有 borrow token（简单 supply 场景）
      if (!hasBorrowTokens && !hasBorrowMultiple && hasSupplyTokens) {
        for (const st of supplyTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);
          const campaignKey = meritKey ?? `${indexKey}-supply`;
          const estimate = getMeritEstimateForEntry(
            meritRoundEstimates,
            chainKey,
            "supply",
            st
          );
          const entry: MeritAprEntry = {
            apr: meritAprPercentToRatio(aprValue!),
            ...(selfAprValue != null && Number.isFinite(selfAprValue)
              ? { selfApr: meritAprPercentToRatio(selfAprValue) }
              : {}),
            link,
            startDate,
            endDate,
            startBlock,
            endBlock,
            ...(name && { name }),
            ...(finalMessage.length > 0 && { message: finalMessage }),
            ...(estimate ?? {}),
          };
          incentives.meritSupplys.push(buildCampaignGroupFromMeritEntry(entry, campaignKey));
        }
      }
    }

    for (const key of Object.keys(meritData)) {
      meritData[key].meritSupplys = filterRecentExpiredMeritCampaigns(
        meritData[key].meritSupplys
      );
      meritData[key].meritBorrows = filterRecentExpiredMeritCampaigns(
        meritData[key].meritBorrows
      );
    }

    logger.info(
      `✅ Indexed Merit data for ${Object.keys(meritData).length} chain-token combinations`
    );

    // 保存 Merit 原始数据
    await mkdir(DEBUG_DATA_DIR, { recursive: true });
    const meritMerklRawDataPath = join(
      DEBUG_DATA_DIR,
      "merit-merkl-raw-data.json"
    );
    await writeJsonAtomic(meritMerklRawDataPath, {
      timestamp: new Date().toISOString(),
      source: {
        endpoint: `${MERKL_BASE_URL}/opportunities`,
        status: "PAST",
        type: "JSON_AIRDROP",
        campaigns: true,
        items: 100,
        maxPages: MERIT_ROUND_ESTIMATE_MAX_PAGES,
        globalCooldownMs: MERIT_ROUND_SCAN_GLOBAL_COOLDOWN_MS,
        requestTemplateUrl:
          _meritState.roundEstimateLastFetchMeta?.requestTemplateUrl ??
          `${MERKL_BASE_URL}/opportunities?chainId={chainId}&status=PAST&type=JSON_AIRDROP&campaigns=true&items=100&creatorSlug=${MERIT_ROUND_CREATOR_SLUG_FILTER}&page={page}`,
        firstPageUrl:
          _meritState.roundEstimateLastFetchMeta?.firstPageUrl ??
          `${MERKL_BASE_URL}/opportunities?chainId=42220&status=PAST&type=JSON_AIRDROP&campaigns=true&items=100&creatorSlug=${MERIT_ROUND_CREATOR_SLUG_FILTER}&page=0`,
        pagesScanned: _meritState.roundEstimateLastFetchMeta?.pagesScanned ?? 0,
        pagesScannedByChain:
          _meritState.roundEstimateLastFetchMeta?.pagesScannedByChain ?? {},
        chainIdsScanned:
          _meritState.roundEstimateLastFetchMeta?.chainIdsScanned ?? [],
        hitCacheOnly:
          _meritState.roundEstimateLastFetchMeta?.hitCacheOnly ?? false,
        queryShape:
          "status=PAST&type=JSON_AIRDROP&campaigns=true&items=100&creatorSlug=aave&chainId={chainId}&page={page}",
        lastGlobalScanAtMs: _meritState.roundEstimateLastGlobalScanAtMs,
        lastGlobalScanAtIso: toIsoOrNull(
          _meritState.roundEstimateLastGlobalScanAtMs
        ),
      },
      targets: serializeMeritRoundEstimateTargets(targetMeritRoundTargets),
      lastRoundRewards: serializeMeritRoundEstimates(meritRoundEstimates),
      cacheState: serializeMeritRoundEstimateCache(),
    });
    logger.debug(`💾 Merit Merkl raw data saved to ${meritMerklRawDataPath}`);

    await writeJsonAtomic(
      MERIT_CAMPAIGN_METADATA_CACHE_PATH,
      {
        timestamp: new Date().toISOString(),
        campaignMetadataByKey: timeRanges,
      },
      { space: 0 }
    );
    _meritState.campaignMetadataMemoryCache = timeRanges;
    _meritState.campaignMetadataLoadedFromDisk = true;
    logger.info(
      `💾 Merit campaign metadata cache saved to ${MERIT_CAMPAIGN_METADATA_CACHE_PATH}`
    );

    const meritRawDataPath = join(DEBUG_DATA_DIR, "merit-raw-data.json");
    await writeJsonAtomic(meritRawDataPath, {
      timestamp: new Date().toISOString(),
      rawAPRs: data.currentAPR.actionsAPR,
      campaignMetadataByKey: timeRanges,
      index: meritData,
    });
    logger.debug(`💾 Merit raw data saved to ${meritRawDataPath}`);

    return meritData;
  } catch (error) {
    logger.error("❌ Error fetching Merit APR data:", error);
    return {};
  }
}

const MERIT_CAMPAIGN_METADATA_MAX_ENTRIES = 500;
const MERIT_FAILED_RETRY_INTERVAL_MS = 30 * 60 * 1000;
const MERIT_ENDED_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Shrink campaignMetadataMemoryCache by removing stale keys and enforcing max entries.
 * Mutates `cache` in place. Eviction strategy: FIFO (by insertion order).
 */
export function shrinkCampaignMetadataCache(
  cache: Record<string, MeritCampaignMetadataEntry>,
  activeAprKeys: string[]
): { removed: number } {
  const activeKeys = new Set(activeAprKeys.map((k) => k.replace(/^self-/, "")));
  const staleKeys = Object.keys(cache).filter((k) => !activeKeys.has(k));
  for (const key of staleKeys) {
    delete cache[key];
  }
  let overflowRemoved = 0;
  const cacheKeys = Object.keys(cache);
  if (cacheKeys.length > MERIT_CAMPAIGN_METADATA_MAX_ENTRIES) {
    overflowRemoved = cacheKeys.length - MERIT_CAMPAIGN_METADATA_MAX_ENTRIES;
    for (let i = 0; i < overflowRemoved; i++) {
      delete cache[cacheKeys[i]];
    }
  }
  return { removed: staleKeys.length + overflowRemoved };
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
    cachedTimeRanges?: Record<string, MeritCampaignMetadataEntry>;
  } = {}
): Promise<Record<string, MeritCampaignMetadataEntry>> {
  const { maxConcurrent = 1, cachedTimeRanges = {} } = options;

  // 从缓存开始，只更新需要更新的部分
  const timeRanges: Record<string, MeritCampaignMetadataEntry> = {
    ...cachedTimeRanges,
  };
  const uniqueKeys = Object.keys(meritAPRs);

  if (uniqueKeys.length === 0) {
    return timeRanges;
  }

  // 过滤掉以下情况的 key：
  // 1. 值为 null 的 key（如 "avalanche-supply-savax": null），这些不需要获取时间范围
  // 2. 以 self- 开头的 key，因为它们与去掉 self- 前缀的 key 共享相同的 URL 和时间范围
  // 3. 长度为 2 的 key（如 "ethereum-sgho"），这些不需要获取 message
  const allKeysToCheck = uniqueKeys.filter((key) => {
    const value = meritAPRs[key];
    if (value === null) return false; // 跳过 null 值
    if (key.startsWith("self-")) return false; // 跳过 self- 前缀
    const keyParts = key.split("-");
    if (keyParts.length <= 2) return false; // 跳过长度为 2 的 key（不需要 message）
    return true;
  });

  // 检查哪些 key 需要更新（只在 campaign 结束时更新）
  const keysToFetch: string[] = [];
  const keysToSkip: string[] = [];

  // 并发检查所有 key 是否需要更新
  // Canonical-key support: some keys redirect to another key page (e.g. sonic-supply-usdce -> sonic-supply-usdc).
  // We keep only canonical keys in fetch list, but we will alias duplicates to the canonical result.
  const canonicalToAliases = new Map<string, Set<string>>();

  // Use aliases from config file
  const getCanonicalKey = (k: string) =>
    discoveredRedirectAliases.get(k) ?? meritKeyAliases[k] ?? k;

  const updateChecks = await Promise.all(
    allKeysToCheck.map(async (key) => {
      const canonicalKey = getCanonicalKey(key);
      if (!canonicalToAliases.has(canonicalKey))
        canonicalToAliases.set(canonicalKey, new Set());
      canonicalToAliases.get(canonicalKey)!.add(key);

      const cached = cachedTimeRanges[key] ?? cachedTimeRanges[canonicalKey];
      const hasSelfAuth = getHasSelfAuthForKey(meritAPRs, canonicalKey);
      const completeness = isCachedTimeRangeComplete({
        key: canonicalKey,
        cached,
        hasSelfAuth,
      });
      // Cache completeness is necessary but not sufficient:
      // once a campaign end date has passed, we must refetch to pick up renewed rounds.
      const cachedCampaignEnded = isMeritCampaignMetadataEnded(cached?.endDate);
      const failedAtMs = cached?.failedAt ? new Date(cached.failedAt).getTime() : 0;
      const withinRetryCooldown = failedAtMs > 0 && (Date.now() - failedAtMs) < MERIT_FAILED_RETRY_INTERVAL_MS;
      const lastCheckedAtMs = cached?.lastCheckedAt ? new Date(cached.lastCheckedAt).getTime() : 0;
      const withinEndedRecheck = cachedCampaignEnded && lastCheckedAtMs > 0 && (Date.now() - lastCheckedAtMs) < MERIT_ENDED_RECHECK_INTERVAL_MS;
      const needsUpdate = !completeness.isComplete || (cachedCampaignEnded && !withinRetryCooldown && !withinEndedRecheck);
      if (completeness.isComplete) {
        logger.debug(
          `📦 Skip refresh for ${canonicalKey}: cached metadata is complete`
        );
      }

      return {
        key,
        canonicalKey,
        needsUpdate,
        cached,
        debug: {
          completenessMissing: completeness.missing,
          cachedCampaignEnded,
        },
      };
    })
  );

  const canonicalNeedsUpdate = new Map<string, boolean>();
  const canonicalCached = new Map<
    string,
    MeritCampaignMetadataEntry | undefined
  >();

  for (const { canonicalKey, needsUpdate, cached, debug } of updateChecks) {
    canonicalNeedsUpdate.set(
      canonicalKey,
      (canonicalNeedsUpdate.get(canonicalKey) ?? false) || needsUpdate
    );
    if (cached && !canonicalCached.has(canonicalKey)) {
      canonicalCached.set(canonicalKey, cached);
    }

    if (needsUpdate) {
      const logParts = [
        `key=${canonicalKey}`,
        debug?.completenessMissing?.length
          ? `missing=[${debug.completenessMissing.join(",")}]`
          : "missing=[]",
        `cachedEnded=${debug?.cachedCampaignEnded ? "yes" : "no"}`,
      ];
      logger.info(`🧭 Merit timeRange refresh: ${logParts.join(" | ")}`);
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
      if (cached) {
        timeRanges[canonicalKey] = cached;
      }
    }
  }

  const skippedCount = uniqueKeys.length - allKeysToCheck.length;
  logger.info(`📅 Checking ${allKeysToCheck.length} Merit campaigns...`);
  logger.info(
    `   • ${keysToFetch.length} campaigns need update (ended or new)`
  );
  logger.info(
    `   • ${keysToSkip.length} campaigns using cached data (still active)`
  );
  logger.info(`   • ${skippedCount} campaigns skipped (null/self-/short keys)`);
  if (meritKeyAliases && Object.keys(meritKeyAliases).length > 0) {
    logger.info(
      `🔁 Known redirect alias map active (${Object.keys(meritKeyAliases).length} entries)`
    );
  }
  if (keysToFetch.length > 0) {
    logger.debug("🧾 Merit campaigns to fetch (index -> key):");
    keysToFetch.forEach((key, idx) => {
      const hasSelfAuth =
        meritAPRs[`self-${key}`] !== null &&
        meritAPRs[`self-${key}`] !== undefined;
      logger.debug(
        `   • [${idx + 1}/${keysToFetch.length}] ${key}${hasSelfAuth ? " (has self-auth)" : ""}`
      );
    });
  }
  if (keysToSkip.length > 0) {
    logger.debug("🧾 Merit campaigns using cache (index -> key):");
    keysToSkip.forEach((key, idx) => {
      const hasSelfAuth =
        meritAPRs[`self-${key}`] !== null &&
        meritAPRs[`self-${key}`] !== undefined;
      logger.debug(
        `   • [${idx + 1}/${keysToSkip.length}] ${key}${hasSelfAuth ? " (has self-auth)" : ""}`
      );
    });
  }

  // 使用并发控制来避免过多请求
  const semaphore = { count: 0 };
  const results: Array<{ key: string; data: MeritCampaignMetadataEntry }> = [];

  const fetchWithLimit = async (key: string) => {
    while (semaphore.count >= maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    semaphore.count++;
    try {
      const hasSelfAuth =
        meritAPRs[`self-${key}`] !== null &&
        meritAPRs[`self-${key}`] !== undefined;
      const data: MeritCampaignMetadataEntry = await fetchMeritTimeRange(key, { hasSelfAuth });
      data.lastCheckedAt = new Date().toISOString();
      results.push({ key, data });
    } catch (error) {
      const cached = cachedTimeRanges[key] ?? cachedTimeRanges[getCanonicalKey(key)];
      const failedEntry: MeritCampaignMetadataEntry = {
        link: cached?.link ?? `https://apps.aavechan.com/merit/${key}`,
        startDate: cached?.startDate ?? "",
        endDate: cached?.endDate ?? "",
        ...(cached?.name && { name: cached.name }),
        ...(cached?.message && { message: cached.message }),
        failedAt: new Date().toISOString(),
      };
      results.push({ key, data: failedEntry });
      logger.warn(`⚠️ Merit timeRange fetch failed for ${key}, marked failedAt to suppress retry`);
    } finally {
      semaphore.count--;
    }
  };

  // 只并发获取需要更新的时间范围
  if (keysToFetch.length > 0) {
    await Promise.all(keysToFetch.map((key) => fetchWithLimit(key)));

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

  const { removed } = shrinkCampaignMetadataCache(timeRanges, uniqueKeys);
  if (removed > 0) {
    logger.info(
      `🧹 Shrunk campaignMetadataMemoryCache: removed ${removed} stale key(s) not in current APR response`
    );
  }

  logger.info(
    `✅ Fetched time ranges for ${Object.keys(timeRanges).length} Merit campaigns`
  );

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
  if (marketName === "AaveV3EthereumEtherFi") {
    chainKey = "ethereum-etherfi";
  } else if (marketName === "AaveV3EthereumLido") {
    chainKey = "ethereum-prime";
  } else if (marketName === "AaveV3EthereumHorizon") {
    chainKey = "ethereum-horizon";
  } else {
    chainKey = chainName.toLowerCase();
  }

  // 尝试匹配 tokenSymbol，使用各种 fallback 策略
  const tokenLower = tokenSymbol.toLowerCase();

  // 生成所有可能的 tokenSymbol 变体用于匹配
  const tokenVariants: string[] = [tokenLower];

  // 1. 如果有小数点，去掉小数点
  if (tokenLower.includes(".")) {
    tokenVariants.push(tokenLower.replace(/\./g, ""));
  }

  // 2. 如果有₮，将₮转化为t
  if (tokenLower.includes("₮")) {
    tokenVariants.push(tokenLower.replace(/₮/g, "t"));
  }

  // 3. 如果是weth，换成eth
  if (tokenLower === "weth") {
    tokenVariants.push("eth");
  }

  // 4. 如果结尾是.e，去掉.e
  if (tokenLower.endsWith(".e")) {
    tokenVariants.push(tokenLower.slice(0, -2));
  }

  // 5. 如果是usdt0或usd₮0，试一下usdt
  if (tokenLower === "usdt0" || tokenLower === "usd₮0") {
    tokenVariants.push("usdt");
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

/**
 * 获取或创建浏览器实例（单例模式）
 * PRODUCTION-GRADE: 检查连接状态，自动恢复断开的连接
 */
let _browserLastUsedAt: number | null = null;
let _browserClosing = false;
const BROWSER_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

async function getBrowser(): Promise<Browser> {
  if (_browserClosing) {
    throw new Error("Browser is closing, retry later");
  }
  if (_meritState.browserInstance) {
    try {
      if (_meritState.browserInstance.isConnected()) {
        _browserLastUsedAt = Date.now();
        return _meritState.browserInstance;
      }
    } catch (_error) {
      // isConnected() failed — treat as disconnected
    }
    logger.warn("⚠️ Browser instance disconnected, closing old instance before creating new one");
    const oldBrowser = _meritState.browserInstance;
    _meritState.browserInstance = null;
    _browserLastUsedAt = null;
    try {
      await oldBrowser.close();
    } catch (closeErr) {
      logger.warn("⚠️ Failed to close disconnected browser:", closeErr);
    }
  }

  try {
    const { chromium } = await import("playwright");
    _meritState.browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    _browserLastUsedAt = Date.now();
    _browserClosing = false;
    logger.info("✅ Playwright browser instance created");
    return _meritState.browserInstance;
  } catch (error) {
    _meritState.browserInstance = null;
    _browserLastUsedAt = null;
    throw error;
  }
}

setInterval(() => {
  if (
    !_browserClosing &&
    _meritState.browserInstance &&
    _browserLastUsedAt !== null &&
    Date.now() - _browserLastUsedAt > BROWSER_IDLE_TIMEOUT_MS
  ) {
    logger.info("🧹 Browser idle for 2min, closing to reclaim memory");
    _browserClosing = true;
    const browser = _meritState.browserInstance;
    _meritState.browserInstance = null;
    _browserLastUsedAt = null;
    browser
      .close()
      .then(() => {
        _browserClosing = false;
      })
      .catch(() => {
        _browserClosing = false;
      });
  }
}, 60_000).unref();

export async function closeBrowser(): Promise<void> {
  if (_meritState.browserInstance) {
    try {
      await _meritState.browserInstance.close();
      logger.info("✅ Playwright browser instance closed");
    } catch (error) {
      logger.error("❌ Error closing browser instance:", error);
    } finally {
      _meritState.browserInstance = null;
    }
  }
}

/**
 * 获取 Merit 页面 HTML 内容（静态 fetch，用于 name 和 date 提取）
 * name 和 date 在 SSR HTML 中就有，不需要 JavaScript 渲染
 * 这样可以减少性能消耗，避免不必要的浏览器调用
 */
// Runtime-discovered redirect aliases (in-memory only, not persisted)
// New redirects discovered at runtime are logged but not saved to file
// Known stable redirects should be added to meritKeyAliases in config.ts
const discoveredRedirectAliases = new Map<string, string>();

async function fetchMeritPageHtmlStatic(
  key: string
): Promise<{ html: string; finalKey: string } | null> {
  try {
    const url = `https://apps.aavechan.com/merit/${key}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      await response.text().catch(() => {});
      logger.warn(
        `⚠️ Failed to fetch Merit page ${url}: HTTP ${response.status}`
      );
      return null;
    }

    // native fetch follows redirects; capture final URL to detect canonical key
    const finalUrl = response.url || url;
    const match = finalUrl.match(/\/merit\/([^/?#]+)/);
    const finalKey = match?.[1] ? decodeURIComponent(match[1]) : key;
    if (finalKey && finalKey !== key) {
      const wasNew = !discoveredRedirectAliases.has(key);
      discoveredRedirectAliases.set(key, finalKey);
      if (wasNew) {
        logger.info(
          `🔁 Discovered redirect alias: ${key} -> ${finalKey} (runtime only, add to meritKeyAliases in config.ts if stable)`
        );
      }
    }

    const html = await response.text();
    return { html, finalKey };
  } catch (error) {
    logger.error(`❌ Error fetching Merit page for key ${key}:`, error);
    return null;
  }
}

async function extractMeritDynamicInfoWithBrowser(
  key: string,
  options: { needCampaignInfo: boolean; needSelfAuth: boolean }
): Promise<MeritDynamicInfo> {
  const { needCampaignInfo, needSelfAuth } = options;
  // Production: set MERIT_ALLOW_LOCAL_PLAYWRIGHT=false to prevent Chromium OOM on Railway.
  // Development: default true allows local Playwright as last-resort fallback.
  const allowLocalPlaywrightFallback =
    process.env.MERIT_ALLOW_LOCAL_PLAYWRIGHT !== "false";

  // Primary: Render browserless (CDP) — most reliable, no memory cost on Railway
  const renderResult = await extractMeritDynamicInfoWithRender(key);
  if (renderResult) {
    return {
      campaignInfo: needCampaignInfo ? renderResult.campaignInfo : [],
      selfAuthDescription: needSelfAuth
        ? renderResult.selfAuthDescription
        : null,
      source: "render",
    };
  }

  // Secondary: Cloudflare Worker — free tier 429-prone but zero local cost
  let workerResult: MeritDynamicInfo | null = null;
  try {
    workerResult = await extractMeritDynamicInfoWithWorker(key);
    if (workerResult) {
      return {
        campaignInfo: needCampaignInfo ? workerResult.campaignInfo : [],
        selfAuthDescription: needSelfAuth
          ? workerResult.selfAuthDescription
          : null,
        source: "worker",
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes("timeout")) {
      logger.warn(
        `⏱️ Cloudflare Worker timeout for ${key}, falling back to Playwright: ${errorMsg}`
      );
    } else {
      logger.warn(
        `⚠️ Cloudflare Worker failed for ${key}, falling back to Playwright: ${errorMsg}`
      );
    }
  }

  if (!allowLocalPlaywrightFallback) {
    return { campaignInfo: [], selfAuthDescription: null, source: "playwright" };
  }

  const PLAYWRIGHT_RSS_GUARD_MB = 700;
  const rssBeforeLaunch = process.memoryUsage().rss / 1024 / 1024;
  if (rssBeforeLaunch > PLAYWRIGHT_RSS_GUARD_MB) {
    logger.warn(
      `🛡️ Skipping Playwright fallback for ${key}: RSS ${Math.round(rssBeforeLaunch)}MB exceeds guard ${PLAYWRIGHT_RSS_GUARD_MB}MB`
    );
    return { campaignInfo: [], selfAuthDescription: null, source: "playwright" };
  }

  let context: BrowserContext | null = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: MERIT_PAGE_VIEWPORT,
      userAgent: MERIT_PAGE_USER_AGENT,
    });
    const page = await createMeritPage(context, key);

    try {
      const [campaignInfo, selfAuthDescription] = await Promise.all([
        needCampaignInfo
          ? extractCampaignInfoFromPage(page, key)
          : Promise.resolve([]),
        needSelfAuth
          ? extractSelfAuthFromPage(page, key)
          : Promise.resolve(null),
      ]);

      return { campaignInfo, selfAuthDescription, source: "playwright" };
    } finally {
      if (context) {
        try {
          await context.close();
        } catch (error) {
          logger.warn("⚠️ Error closing browser context:", error);
        }
      }
    }
  } catch (error) {
    if (context) {
      try {
        await context.close();
      } catch (_) {}
    }
    logger.warn(
      `⚠️ extractMeritDynamicInfoWithBrowser failed for ${key}:`,
      error
    );
    return { campaignInfo: [], selfAuthDescription: null, source: "playwright" };
  }
}

type PlaywrightPage = import("playwright").Page;

async function createMeritPage(
  context: BrowserContext,
  key: string
): Promise<import("playwright").Page> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    if (typeof (globalThis as any).__name === "undefined") {
      (globalThis as any).__name = (func: any) => func;
    }
  });
  const url = `https://apps.aavechan.com/merit/${key}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("body", { timeout: 10000 });
  await page.waitForTimeout(3000);
  return page;
}

const MERIT_PAGE_VIEWPORT = { width: 1920, height: 1080 };
const MERIT_PAGE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function extractCampaignInfoFromPage(
  page: PlaywrightPage,
  key: string
): Promise<MeritCampaignInfo[]> {
  try {
    const campaignInfoButton = page.locator("button", {
      hasText: /campaign\s+info/i,
    });
    if ((await campaignInfoButton.count()) > 0) {
      await campaignInfoButton.first().click();
      await page.waitForSelector("table tbody tr", {
        timeout: 5000,
        state: "attached",
      });
    }
  } catch (e) {
    logger.debug(
      `merit: campaign info button click failed for ${key}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const infos = await page.evaluate(() => {
    const infos: Array<{ action?: string; description?: string }> = [];
    const doc = globalThis.document;
    if (!doc) return infos;
    const tables = doc.querySelectorAll("table");
    for (let i = 0; i < tables.length; i++) {
      const rows = tables[i].querySelectorAll("tbody tr");
      for (let j = 0; j < rows.length; j++) {
        const cells = rows[j].querySelectorAll("td");
        if (cells.length >= 2) {
          const action = cells[0]?.textContent?.trim() || "";
          const description = cells[1]?.textContent?.trim() || "";
          if (
            action.length > 0 &&
            description.length > action.length &&
            description.length > 20
          ) {
            infos.push({ action, description });
          }
        }
      }
    }
    return infos;
  });

  return (Array.isArray(infos) ? infos : []) as MeritCampaignInfo[];
}

async function extractSelfAuthFromPage(
  page: PlaywrightPage,
  key: string
): Promise<string | null> {
  logger.info(`🔍 Starting self-auth extraction for ${key}`);
  let result: string | null = null;
  try {
    result = (await page.evaluate(() => {
      const doc = globalThis.document;
      if (!doc) return null;

      const norm = (s: any) => {
        return String(s || "")
          .replace(/\s+/g, " ")
          .trim();
      };

      const hasSelfAuth = (s: any) => {
        const t = String(s || "").toLowerCase();
        return (
          t.includes("self") &&
          (t.includes("authentication") ||
            t.includes("verify") ||
            t.includes("proof"))
        );
      };

      const scoreEl = (el: Element) => {
        const text = norm(el ? el.textContent : null);
        if (!text || !hasSelfAuth(text)) return -1;
        let score = 0;
        if (text.length >= 60 && text.length <= 900) score += 3;
        if (text.toLowerCase().includes("supply")) score += 1;
        if (text.toLowerCase().includes("borrow")) score += 1;
        try {
          const cs = globalThis.getComputedStyle(el);
          const bg = cs ? cs.backgroundColor : "";
          if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent")
            score += 2;
          const border = cs ? cs.borderColor : "";
          if (
            border &&
            border !== "rgba(0, 0, 0, 0)" &&
            border !== "transparent"
          )
            score += 1;
        } catch (e) {
          console.warn("merit: style scoring failed:", e);
        }
        if (text.length > 900) score -= 3;
        return score;
      };

      try {
        const candidates = doc.querySelectorAll(
          "section,article,aside,div,p,li"
        );

        let best: Element | null = null;
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
          let container: Element | null = best;
          let foundValid = false;
          for (let i = 0; i < 4; i++) {
            const t = norm(container ? container.textContent : null);
            if (
              t &&
              t.length >= 60 &&
              t.length <= 900 &&
              hasSelfAuth(t)
            ) {
              foundValid = true;
              break;
            }
            container = container ? container.parentElement : null;
            if (!container) break;
          }
          if (foundValid && container) {
            const finalText = norm(container.textContent);
            if (
              finalText &&
              hasSelfAuth(finalText) &&
              finalText.length <= 1200
            ) {
              return finalText.length > 950
                ? finalText.slice(0, 950)
                : finalText;
            }
          }
          const bestText = norm(best.textContent);
          if (
            bestText &&
            hasSelfAuth(bestText) &&
            bestText.length >= 60 &&
            bestText.length <= 1200
          ) {
            return bestText.length > 950
              ? bestText.slice(0, 950)
              : bestText;
          }
        }
      } catch (e) {
        console.warn("merit: description extraction failed:", e);
      }

      const allElements = doc.querySelectorAll("*");
      for (let i = 0; i < allElements.length; i++) {
        const element = allElements[i];
        if (!element) continue;
        const text = norm(element.textContent || "");
        if (
          hasSelfAuth(text) &&
          text.length > 60 &&
          text.length < 1000
        ) {
          return text;
        }
      }

      return null;
    })) as string | null;
  } catch (evalError) {
    logger.error(
      `❌ Error in page.evaluate for self-auth ${key}:`,
      evalError
    );
    result = null;
  }

  if (result) {
    logger.info(
      `✅ Self-auth extracted for ${key}: ${result.substring(0, 100)}...`
    );
  } else {
    logger.warn(`⚠️ No self-auth found for ${key}`);
  }

  return result;
}

let renderLastActiveTimestamp = 0;
const RENDER_RECENTLY_ACTIVE_MS = 5 * 60 * 1000;
let renderConcurrentCount = 0;
const RENDER_MAX_CONCURRENT = 1;

function isRenderRecentlyActive(): boolean {
  return Date.now() - renderLastActiveTimestamp < RENDER_RECENTLY_ACTIVE_MS;
}

async function extractMeritDynamicInfoWithRender(
  key: string
): Promise<MeritDynamicInfo | null> {
  const renderUrl = process.env.RENDER_SERVICE_URL?.trim();
  if (!renderUrl) {
    return null;
  }

  if (renderConcurrentCount >= RENDER_MAX_CONCURRENT) {
    logger.debug(
      `⏭️ [Render Fallback] Skipping ${key}: ${renderConcurrentCount} concurrent connections (limit: ${RENDER_MAX_CONCURRENT})`
    );
    return null;
  }

  renderConcurrentCount++;

  let context: BrowserContext | null = null;
  let browser: Browser | null = null;

  try {
    const wsEndpoint = renderUrl.replace(/^https?/, "wss");
    const recentlyActive = isRenderRecentlyActive();
    const cdpTimeout = recentlyActive ? 15000 : 120000;
    logger.info(
      `🔗 [Render Fallback] Connecting to remote browser at ${renderUrl} for ${key} (recentlyActive=${recentlyActive}, timeout=${cdpTimeout}ms)`
    );

    browser = await (await import("playwright")).chromium.connectOverCDP(wsEndpoint, {
      timeout: cdpTimeout,
    });

    context = await browser.newContext({
      viewport: MERIT_PAGE_VIEWPORT,
      userAgent: MERIT_PAGE_USER_AGENT,
    });
    const page = await createMeritPage(context, key);

    const campaignInfo = await extractCampaignInfoFromPage(page, key);
    const selfAuthDescription = await extractSelfAuthFromPage(page, key);

    renderLastActiveTimestamp = Date.now();

    logger.info(
      `✅ [Render Fallback] Extracted for ${key}: campaigns=${campaignInfo.length}, selfAuth=${!!selfAuthDescription}`
    );

    return { campaignInfo, selfAuthDescription, source: "render" };
  } catch (error) {
    logger.warn(
      `⚠️ [Render Fallback] Failed for ${key}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (_) {}
    }
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
    renderConcurrentCount--;
  }
}

const ETHEREUM_AVERAGE_BLOCK_TIME_S = 12;


/**
 * 优先级 #3：提取区块号
 */
function extractBlockNumbers(html: string): {
  startBlock?: string;
  endBlock?: string;
} {
  // 匹配 etherscan.io/block/ 链接中的区块号
  const blockPattern = /etherscan\.io\/block\/(\d+)/g;
  const matches: string[] = [];
  let match;

  while ((match = blockPattern.exec(html)) !== null) {
    matches.push(match[1]);
  }

  // 去重并转换为数字排序
  const uniqueBlocks = [...new Set(matches)]
    .map((block) => parseInt(block, 10))
    .filter((block) => !isNaN(block))
    .sort((a, b) => a - b);

  if (uniqueBlocks.length >= 2) {
    return {
      startBlock: uniqueBlocks[0].toString(),
      endBlock: uniqueBlocks[uniqueBlocks.length - 1].toString(),
    };
  } else if (uniqueBlocks.length === 1) {
    return {
      startBlock: uniqueBlocks[0].toString(),
    };
  }

  return {};
}

async function getEthereumBlockTimestamp(
  blockNumber: string
): Promise<string | null> {
  try {
    const rpcUrls = getRpcUrlsFromChainName("ethereum");
    if (rpcUrls.length === 0) return null;

    for (const rpcUrl of rpcUrls) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_getBlockByNumber",
            params: [`0x${parseInt(blockNumber, 10).toString(16)}`, false],
            id: 1,
          }),
        });

        if (!response.ok) {
          await response.text().catch(() => {});
          continue;
        }

        const data = (await response.json()) as {
          result?: { timestamp?: string };
        };

        if (data.result?.timestamp) {
          const timestamp = parseInt(data.result.timestamp, 16);
          return new Date(timestamp * 1000).toISOString();
        }
      } catch {
        // try next rpc
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return null;
  } catch {
    return null;
  }
}

function estimateEndBlockTimestamp(
  startBlockTsIso: string,
  startBlock: string,
  endBlock: string
): string {
  const startTsMs = new Date(startBlockTsIso).getTime();
  const blockDiff =
    parseInt(endBlock, 10) - parseInt(startBlock, 10);
  const estimatedTsMs =
    startTsMs + blockDiff * ETHEREUM_AVERAGE_BLOCK_TIME_S * 1000;
  return new Date(estimatedTsMs).toISOString();
}

/**
 * 将区块号转换为日期
 */
async function convertBlocksToDates(
  startBlock?: string,
  endBlock?: string
): Promise<{ startDate?: string; endDate?: string; startDateSource?: string; endDateSource?: string }> {
  const result: { startDate?: string; endDate?: string; startDateSource?: string; endDateSource?: string } = {};

  if (startBlock) {
    const startDate = await getEthereumBlockTimestamp(startBlock);
    if (startDate) {
      result.startDate = startDate;
      result.startDateSource = "ethereum-rpc";
    }
  }

  if (endBlock) {
    const endDate = await getEthereumBlockTimestamp(endBlock);
    if (endDate) {
      result.endDate = endDate;
      result.endDateSource = "ethereum-rpc";
    } else if (result.startDate && startBlock) {
      result.endDate = estimateEndBlockTimestamp(
        result.startDate,
        startBlock,
        endBlock
      );
      result.endDateSource = "ethereum-rpc-estimated";
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
    const scriptContent = $("script").text();

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
          .replace(/^"|"$/g, "")
          .replace(/^children":\["/, "")
          .replace(/"$/, "");

        // 清理可能的转义字符
        extracted = extracted.replace(/\\"/g, '"').replace(/\\\\/g, "\\");

        if (extracted.length > 3 && extracted.length < 200) {
          return extracted;
        }
      }
    }

    // 优先级 #2：从 h1 标题提取（页面中可能有 "Last supply (celo or eth) and borrow usdt..."）
    const h1Text = $("h1").first().text().trim();
    if (h1Text && h1Text.length > 5) {
      // 尝试从 h1 文本中提取 campaign 名称（去掉 "Last" 和 "campaign round has ended" 等前缀后缀）
      const nameMatch =
        h1Text.match(
          /(?:Last\s+)?(Supply\s*(?:\([^)]+\))?\s+(?:and|or)\s+borrow\s+[A-Z]+)/i
        ) ||
        h1Text.match(/(?:Last\s+)?(Borrow\s+[A-Z]+)/i) ||
        h1Text.match(/(?:Last\s+)?(Supply\s+[A-Z]+)/i);
      if (nameMatch && nameMatch[1]) {
        return nameMatch[1];
      }
      // 如果 h1 文本本身就很短且看起来像标题，直接使用
      if (
        h1Text.length < 100 &&
        !h1Text.toLowerCase().includes("campaign round has ended")
      ) {
        return h1Text;
      }
    }

    // 优先级 #3：使用正则从 HTML 文本中提取
    const nameRegex =
      /(?:Supply\s*(?:\([^)]+\))?\s+(?:and|or)\s+borrow\s+[A-Z]+|Borrow\s+[A-Z]+|Supply\s+[A-Z]+)/i;
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
 * 从 HTML 中提取 campaign info（action 和 description）
 * 从 Campaign info 弹窗的表格中提取 action 和 description
 * 基于表格结构提取，不依赖具体的文字内容
 */
function extractCampaignInfo(html: string): MeritCampaignInfo[] {
  try {
    const $ = cheerio.load(html);
    const campaignInfos: MeritCampaignInfo[] = [];
    // 直接使用原始 HTML，因为 script 标签中的内容可能需要特殊处理
    const scriptContent = $("script").text();
    const rawHtml = html; // 保留原始 HTML 用于备用提取

    // 优先级 #1：从 HTML DOM 表格中提取（最可靠的方法）
    // 查找 Campaign info 弹窗中的表格：第一列是 Action，第二列是 Description
    $("table tbody tr").each((_index: number, element: any) => {
      const tds = $(element).find("td");
      if (tds.length >= 2) {
        const action = $(tds[0]).text().trim();
        const description = $(tds[1]).text().trim();

        // 只要表格有两列，就提取（不依赖文字内容验证）
        if (
          action &&
          description &&
          action.length > 0 &&
          description.length > 0
        ) {
          campaignInfos.push({ action, description });
        }
      }
    });

    // 优先级 #2：如果 DOM 中没有找到，从原始 HTML 中直接提取
    // HTML 中的格式可能是转义的：\"children\":\"Supply WETH\" 或未转义的："children":"Supply WETH"
    if (campaignInfos.length === 0) {
      // 在原始 HTML 中查找，支持转义和未转义的格式
      // 匹配格式：\"children\":\"Supply WETH\" 或 "children":"Supply WETH"
      const actionPattern =
        /(?:\\?"children\\?"\s*:\s*\\?")((?:Supply|Borrow|Stake|Hold)\s+[^"\\]{1,200})(?:\\?")/i;
      const actionMatch = rawHtml.match(actionPattern);

      if (actionMatch) {
        const action = actionMatch[1]
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
          .trim();
        const actionIndex = actionMatch.index || 0;

        // 在 action 之后查找 description（在 30000 字符内，因为中间可能有大量其他内容）
        const searchStart = actionIndex + actionMatch[0].length;

        // 查找 "Rewards are distributed" 开头的 description
        // 直接在原始 HTML 中查找（不限制在特定区域中）
        const fullRewardsIndex = rawHtml.indexOf(
          "Rewards are distributed",
          searchStart
        );
        if (fullRewardsIndex > 0 && fullRewardsIndex < searchStart + 30000) {
          // 向前查找 "children"，向后查找结束引号
          const beforeRewards = rawHtml.substring(
            Math.max(0, fullRewardsIndex - 200),
            fullRewardsIndex
          );
          const childrenMatch = beforeRewards.match(
            /(?:\\?")?children(?:\\?")?\s*:\s*(?:\\?")/
          );

          if (childrenMatch) {
            // description 文本从 "Rewards are distributed" 开始
            const descStart = fullRewardsIndex;
            let descEnd = descStart;
            let foundEnd = false;

            // 向后查找结束引号（在 "Rewards are distributed..." 之后）
            // 方法：查找 "Threshold)" 或类似模式，然后找到后面的第一个 }
            // 在 HTML 中，\" 是转义的引号，所以我们需要找到真正的结束位置
            const thresholdPattern = /Threshold\)/i;
            const thresholdMatch = rawHtml
              .substring(descStart, descStart + 200)
              .match(thresholdPattern);

            if (thresholdMatch) {
              const thresholdEnd =
                descStart + thresholdMatch.index! + thresholdMatch[0].length;
              // 在 Threshold) 之后查找第一个 }，然后向前找到对应的引号
              const afterThreshold = rawHtml.substring(
                thresholdEnd,
                Math.min(thresholdEnd + 50, rawHtml.length)
              );
              const closingBraceIndex = afterThreshold.indexOf("}");

              if (closingBraceIndex > 0) {
                // 向前查找引号（在 Threshold) 和 } 之间）
                const between = rawHtml.substring(
                  thresholdEnd,
                  thresholdEnd + closingBraceIndex
                );
                // 查找最后一个引号（可能是转义的 \"）
                const lastQuoteIndex = between.lastIndexOf('"');
                if (lastQuoteIndex > 0) {
                  // 检查这个引号是否是转义的
                  const isEscaped =
                    lastQuoteIndex > 0 && between[lastQuoteIndex - 1] === "\\";
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
              for (
                let i = descStart;
                i < Math.min(descStart + maxSearch, rawHtml.length) &&
                !foundEnd;
                i++
              ) {
                if (rawHtml[i] === '"') {
                  const isEscaped = i > 0 && rawHtml[i - 1] === "\\";
                  if (!isEscaped && i + 1 < rawHtml.length) {
                    const nextChar = rawHtml[i + 1];
                    if (nextChar === "}" || nextChar === "]") {
                      descEnd = i;
                      foundEnd = true;
                    }
                  }
                }
              }
            }

            if (foundEnd) {
              const description = rawHtml
                .substring(descStart, descEnd)
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, "\\")
                .trim();

              // 验证 description
              if (
                description.startsWith("Rewards are distributed") &&
                description.length > action.length &&
                description.length > 20 &&
                description.length < 1000
              ) {
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
      const trWithTdsPattern =
        /"\$","tr"[^]]*"children":\[\["\\\$","td"[^]]*"children":"([^"]{3,200})"[^]]*\],\["\\\$","td"[^]]*"children":"([^"]{20,800})"[^]]*\]/g;
      const matches = [...scriptContent.matchAll(trWithTdsPattern)];

      for (const match of matches) {
        const action = match[1]
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
          .trim();
        const description = match[2]
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
          .trim();

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
): Promise<{
  link: string;
  startDate: string;
  endDate: string;
  startBlock?: string;
  endBlock?: string;
  name?: string;
  message?: MeritCampaignInfo[];
}> {
  const link = `https://apps.aavechan.com/merit/${key}`;
  const result: {
    link: string;
    startDate: string;
    endDate: string;
    startBlock?: string;
    endBlock?: string;
    name?: string;
    message?: MeritCampaignInfo[];
  } = {
    link,
    startDate: "",
    endDate: "",
  };

  // 检查 key 长度，如果长度为 2（如 ethereum-sgho），跳过获取 message
  const keyParts = key.split("-");
  const shouldFetchMessage = keyParts.length > 2;

  try {
    // 获取页面 HTML（使用静态 fetch，name 和 date 在 SSR 中就有，不需要浏览器渲染）
    const page = await fetchMeritPageHtmlStatic(key);
    if (!page) {
      logger.warn(`⚠️ Failed to fetch HTML for key: ${key}`);
      return result;
    }
    const { html, finalKey } = page;
    // Note: redirect detection and alias recording already happened in fetchMeritPageHtmlStatic

    // 提取 campaign 名称（使用静态 HTML，原来方法就很好，不需要浏览器渲染）
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
      if (message.length > 0) messageStrategy = "message:p1:static-dom/regex";
    }

    const needDynamicCampaignInfo = shouldFetchMessage && message.length === 0;
    const needDynamicSelfAuth = hasSelfAuth;

    let dynamicSource: "worker" | "render" | "playwright" | null = null;
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
          {
            action: "Self Authentication",
            description: dynamic.selfAuthDescription,
          },
        ];
        selfAuthStrategy = `self-auth:p2:dynamic:${dynamic.source}`;
        logger.info(
          `✅ Self Authentication description extracted for ${key} (source: ${dynamic.source})`
        );
      } else if (needDynamicSelfAuth && !dynamic.selfAuthDescription) {
        logger.warn(
          `⚠️ Self Authentication description missing for ${key} (dynamic extraction returned empty, source: ${dynamic.source})`
        );
        // 记录更详细的错误信息，帮助诊断问题
        if (dynamic.source === "playwright") {
            logger.warn(
              `   → Playwright fallback may have failed. Check if page loaded correctly.`
          );
        } else if (dynamic.source === "worker") {
          logger.warn(`   → Worker extraction may have failed or timed out.`);
        }
      }
    }

    result.name = name ?? "";
    if (message.length > 0) {
      result.message = message;
    } else {
      result.message = [];
    }

    const blocks = extractBlockNumbers(html);
    if (blocks.startBlock || blocks.endBlock) {
      if (blocks.startBlock) result.startBlock = blocks.startBlock;
      if (blocks.endBlock) result.endBlock = blocks.endBlock;
      const blockDates = await convertBlocksToDates(
        blocks.startBlock,
        blocks.endBlock
      );
      if (blockDates.startDate) result.startDate = blockDates.startDate;
      if (blockDates.endDate) result.endDate = blockDates.endDate;
      const srcParts = [
        blockDates.startDateSource ?? "none",
        blockDates.endDateSource ?? "none",
      ];
      dateStrategy = `date:block->${srcParts.join("+")}`;
      if (blockDates.endDateSource === "ethereum-rpc-estimated") {
        logger.info(
          `📅 Merit endDate estimated for ${key}: endBlock ${blocks.endBlock} not yet mined, using ${ETHEREUM_AVERAGE_BLOCK_TIME_S}s/block estimate`
        );
      }
    }

    if (!result.startDate) result.startDate = "";
    if (!result.endDate) result.endDate = "";

    if (!dateStrategy) {
      logger.warn(`⚠️ Could not extract time range information for key: ${key}`);
    }

    logger.info(
      `🧠 Merit crawl strategies for ${key}: ${[
        messageStrategy ?? "message:none",
        hasSelfAuth
          ? (selfAuthStrategy ?? "self-auth:missing")
          : "self-auth:n/a",
        dateStrategy ?? "date:missing",
      ].join(" | ")}`
    );
    return result;
  } catch (error) {
    logger.error(`❌ Error fetching time range for key ${key}:`, error);
    return result;
  }
}

export interface MeritCampaignBreakdownInput {
  baseApr: number;
  selfApr: number;
  startDate: string;
  endDate: string;
  meritKey: string;
  selfPositionCap: number | null;
  baseBreakdownMessage?: string;
  selfBreakdownMessage?: string;
}

export function extractPositionCapFromSelfAuth(text: string | null): number | null {
  if (!text) return null;
  if (!text.toLowerCase().includes('self')) return null;
  const match = text.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function buildMeritCampaignBreakdowns(input: MeritCampaignBreakdownInput) {
  const { baseApr, selfApr, startDate, endDate, meritKey, selfPositionCap, baseBreakdownMessage, selfBreakdownMessage } = input;
  const breakdowns: Array<{
    campaignApr: number;
    campaignStartedAt: string;
    campaignEndedAt: string;
    campaignId: string;
    campaignType: 'DUTCH_AUCTION';
    positionCap?: number;
    message?: string;
  }> = [];

  if (baseApr > 0) {
    breakdowns.push({
      campaignApr: baseApr,
      campaignStartedAt: startDate,
      campaignEndedAt: endDate,
      campaignId: `${meritKey}-base`,
      campaignType: 'DUTCH_AUCTION',
      ...(baseBreakdownMessage ? { message: baseBreakdownMessage } : {}),
    });
  }

  if (selfApr > 0) {
    breakdowns.push({
      campaignApr: selfApr,
      campaignStartedAt: startDate,
      campaignEndedAt: endDate,
      campaignId: `${meritKey}-self`,
      campaignType: 'DUTCH_AUCTION',
      ...(selfPositionCap != null && selfPositionCap > 0 ? { positionCap: selfPositionCap } : {}),
      ...(selfBreakdownMessage ? { message: selfBreakdownMessage } : {}),
    });
  }

  return breakdowns;
}

export function buildCampaignGroupFromMeritEntry(
  entry: MeritAprEntry,
  meritKey: string
): MeritCampaignGroup {
  const selfAuthMsg = (entry.message ?? []).find(
    (m) => m.action?.toLowerCase().includes('self authentication')
  );
  let selfPositionCap: number | null = null;
  if (selfAuthMsg?.description) {
    const match = selfAuthMsg.description.match(/\$\s*([\d,]+(?:\.\d+)?)/);
    if (match) {
      const parsed = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) selfPositionCap = parsed;
    }
  }

  const nonSelfMessages = (entry.message ?? []).filter(
    (m) => !m.action?.toLowerCase().includes('self authentication')
  );
  const baseBreakdownMessage = nonSelfMessages.length > 0
    ? JSON.stringify(nonSelfMessages)
    : undefined;
  const selfBreakdownMessage = selfAuthMsg
    ? JSON.stringify([selfAuthMsg])
    : undefined;

  const breakdowns = buildMeritCampaignBreakdowns({
    baseApr: entry.apr,
    selfApr: entry.selfApr ?? 0,
    startDate: entry.startDate,
    endDate: entry.endDate,
    meritKey,
    selfPositionCap,
    baseBreakdownMessage,
    selfBreakdownMessage,
  });

  return {
    link: entry.link,
    ...(entry.name ? { name: entry.name } : {}),
    breakdowns,
  };
}
