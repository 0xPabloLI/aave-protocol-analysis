import { mkdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";
import { writeJsonAtomic } from "./file-utils.js";
import { merklFetchConfig } from "./config.js";
import {
  createMerklConcurrencyLimitedFetch,
  fetchMerklOpportunitiesSnapshot,
  normalizeMerklCampaignTotalBudget,
  resolveCacheTtlMs,
} from "@internal/aave-shared-config";
import type {
  MerklCampaignBreakdown,
  MerklOpportunityGroup,
  ForecastCampaignTypeLite,
  NormalizeCampaignTypeInput,
  MerklCampaignAccess,
  MerklBorrowHookProtocol,
  MerklHealthFactorHook,
  RuntimeReserveData,
  NetPositionConstraint,
  CrossAssetPairing,
} from "@internal/aave-shared-contracts";
import {
  chainTokenKey,
  chainSymbolKey,
  getErrorCode,
  spokeKey,
  v4ReserveId,
  v4HubScopeKey,
  isWithinLookbackWindow,
  normalizeCampaignType,
} from "@internal/aave-shared-contracts";
import { resolveOffsetSymbolAddress } from "./merkl-symbol-resolver.js";
export type {
  MerklCampaignBreakdown,
  MerklOpportunityGroup,
  ForecastCampaignTypeLite,
  NormalizeCampaignTypeInput,
  MerklCampaignAccess,
  MerklBorrowHookProtocol,
  MerklHealthFactorHook,
} from "@internal/aave-shared-contracts";
export { normalizeCampaignType } from "@internal/aave-shared-contracts";
import {
  resolveUsdPriceWithPriority,
  type UsdPriceSource,
} from "./token-price-resolver.js";

const merklLimitedFetch = createMerklConcurrencyLimitedFetch(fetch);

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const RUNTIME_DATA_DIR = join(DATA_DIR, "runtime");
const DEBUG_DATA_DIR = join(DATA_DIR, "debug");
const MERKL_DEFAULT_OPPORTUNITIES_SOFT_TTL_MS = 1 * 60 * 1000;
const MERKL_DEFAULT_HARD_TTL_MS = 10 * 60 * 1000;

const OPPORTUNITIES_SOFT_TTL_MS = resolveCacheTtlMs(
  process.env.MERKL_OPPORTUNITIES_SOFT_TTL_MS,
  MERKL_DEFAULT_OPPORTUNITIES_SOFT_TTL_MS
);
const MERKL_HARD_TTL_MS = resolveCacheTtlMs(
  process.env.MERKL_HARD_TTL_MS,
  MERKL_DEFAULT_HARD_TTL_MS
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  const retryableCodes = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETRESET",
    "ECONNREFUSED",
  ]);
  const code = getErrorCode(error);
  return Boolean(code && retryableCodes.has(code));
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
      if (
        response.status >= 500 &&
        response.status < 600 &&
        attempt < merklFetchConfig.maxRetries
      ) {
        await response.text().catch(() => {});
        const delay =
          Math.min(
            merklFetchConfig.maxDelayMs,
            merklFetchConfig.baseDelayMs * Math.pow(2, attempt)
          ) +
          Math.random() * 250;
        logger.warn(
          `⚠️ ${label} HTTP ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${merklFetchConfig.maxRetries})`
        );
        await sleep(delay);
        attempt++;
        continue;
      }
      // Non-retryable HTTP error — drain body so keep-alive socket can return to pool
      await response.text().catch(() => {});
      return response;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= merklFetchConfig.maxRetries) {
        throw error;
      }
      const delay =
        Math.min(
          merklFetchConfig.maxDelayMs,
          merklFetchConfig.baseDelayMs * Math.pow(2, attempt)
        ) +
        Math.random() * 250;
      logger.warn(
        `⚠️ ${label} network error (${(error as Error).message}), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${merklFetchConfig.maxRetries})`
      );
      await sleep(delay);
      attempt++;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
    id: string;
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
      value?: number;
      token?: {
        address?: string;
        symbol?: string;
        name?: string;
        type?: string;
        chainId?: number;
        price?: number;
        icon?: string;
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
  distributionType?: string;
  parentCampaignId?: string;
  rootCampaignId?: string;
  rewardToken?: { symbol?: string; name?: string; id?: string };
}

export interface MerklCampaignDetails {
  startedAt: string;
  endedAt: string;
  /** Merkl Campaign Hash ID (hex). */
  id: string;
  /** Merkl Campaign Database ID (numeric). Used as input to /v4/campaigns/{databaseId} API. */
  databaseId?: string;
  /** Annual yield ratio; upstream `campaign.apr` is percent → divided by 100 when cached. */
  apr: number;
  whitelistOnly: boolean;
  /** V4 Spoke campaign's parent Hub campaign ID (top-level field on Merkl API response). */
  parentCampaignId?: string;
  /** Per-user position cap as native raw amount string, extracted from computeMethod=maxDeposit campaigns. */
  positionCapNative?: string;
  /** Whether the position cap is shared across supply+borrow sides. Merkl maxDeposit is always per-side (false). */
  isCombineCap?: boolean;
}

const hasEntries = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object")
    return Object.keys(value as Record<string, unknown>).length > 0;
  return Boolean(value);
};

export function isCampaignWhitelistOnly(campaign: any): boolean {
  const topLevelWhitelist = hasEntries(campaign?.params?.whitelist);
  if (topLevelWhitelist) return true;

  const composedCampaigns = campaign?.params?.composedCampaigns;
  if (!Array.isArray(composedCampaigns)) return false;

  return composedCampaigns.some((entry: any) =>
    hasEntries(entry?.campaignParameters?.whitelist)
  );
}

const toIsoFromUnixLike = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const numeric =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string"
        ? Number(value)
        : typeof value === "number"
          ? value
          : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
};

// Merkl 数据结构：NetPositionConstraint 已迁移到 @internal/aave-shared-contracts

export function inferVersionFromReserveId(
  reserveId: string
): "v3" | "v4" | null {
  const segments = reserveId.split(":").length;
  if (segments === 3) return "v3";
  if (segments >= 4) return "v4";
  return null;
}

export function extractPoolSpokePrefix(reserveId: string): string | null {
  const parts = reserveId.split(":");
  if (parts.length < 3) return null;
  return `${parts[0]}:${parts[1]}`;
}

export type OffsetLevel = "reserve" | "hub-cross-spoke";

export function resolveOffsetReserveIds(
  oppReserveId: string,
  offsetTokenAddress: string,
  reserveIdSet: Set<string>,
  offsetLevel: OffsetLevel = "reserve"
): string[] {
  const version = inferVersionFromReserveId(oppReserveId);
  const prefix = extractPoolSpokePrefix(oppReserveId);
  if (!prefix || !version) return [];

  const normalizedAddr = offsetTokenAddress.toLowerCase();

  if (version === "v3") {
    if (offsetLevel === "hub-cross-spoke") return [];
    const candidate = `${prefix}:${normalizedAddr}`;
    return reserveIdSet.has(candidate) ? [candidate] : [];
  }

  const parts = oppReserveId.split(":");
  const chainId = parts[0];
  const hubAddress = parts.length >= 4 ? parts[3] : "";

  if (offsetLevel === "hub-cross-spoke") {
    if (!hubAddress) return [];
    const results: string[] = [];
    const target = `:${normalizedAddr}:${hubAddress}`;
    for (const rid of reserveIdSet) {
      if (
        rid.startsWith(`${chainId}:`) &&
        rid.endsWith(target) &&
        rid.split(":").length >= 4
      ) {
        results.push(rid);
      }
    }
    return results;
  }

  if (offsetLevel === "reserve") {
    const spokePrefix = `${parts[0]}:${parts[1]}`;
    const base = `${spokePrefix}:${normalizedAddr}`;
    const hubSuffix = parts.length >= 4 ? `:${parts[3]}` : "";
    const exact = `${base}${hubSuffix}`;
    return reserveIdSet.has(exact) ? [exact] : [];
  }

  return [];
}

export interface ComposedSubCampaign {
  underlyingToken?: string;
  campaignType?: number;
  composedType?: string;
  composedMultiplier?: number;
  composedIndex?: number;
  mainParameter?: string;
  symbolTargetToken?: string;
}

export interface MerklOpportunityData {
  supply: MerklCampaignBreakdown[];
  borrow: MerklCampaignBreakdown[];
  hold: MerklCampaignBreakdown[];
  marketName: string;
  chainId: number;
  /** Protocol version derived from Merkl opportunity type (e.g. AAVE_V4_HUB_SUPPLY = v4). */
  protocolVersion: "v3" | "v4";
  opportunityId?: string;
  name?: string;
  description?: string;
  opportunityType?: string;
  distributionType?: string;
  offsetTokenAddresses?: string[];
  composedCampaignsCompute?: string;
  composedSubCampaigns?: ComposedSubCampaign[];
  borrowBlacklist?: boolean;
  /** Pre-computed reserve ID for V4 Spoke matching (chainId:spoke:token:hub via v4ReserveId). */
  campaignReserveId?: string;
  /** Pre-computed hub scope key for V4 Hub matching (chainId:token:hub via v4HubScopeKey). */
  hubScopeKey?: string;
  /** Opportunity explorerAddress (used for source sub identification in cross-asset pairing). */
  explorerAddress?: string;
}

/**
 * Build protocol version lookup tables from baseDataset.
 *
 * Unambiguous lookup: chainId + aToken/vToken/spoke address → version.
 *   - V3 reserves contribute aToken/vToken
 *   - V4 reserves contribute aToken/vToken + spokeAddress
 *
 * V4 underlying lookup: chainId + underlying token → true (V4 only).
 *   - V3 reserves are excluded because V3 never uses underlying token as explorerAddress.
 *   - This handles V4 Hub Supply where explorerAddress = underlying token.
 */
export function buildProtocolVersionLookup(baseDataset: RuntimeReserveData[]): {
  unambiguous: Map<string, "v3" | "v4">;
  v4Underlying: Map<string, true>;
} {
  const unambiguous = new Map<string, "v3" | "v4">();
  const v4Underlying = new Map<string, true>();

  for (const r of baseDataset) {
    const isV4 = r.marketName.startsWith("AaveV4");
    const version: "v3" | "v4" = isV4 ? "v4" : "v3";
    const chainId = r.chainId;

    if (r.aTokenAddress) {
      unambiguous.set(chainTokenKey(chainId, r.aTokenAddress), version);
    }
    if (r.vTokenAddress) {
      unambiguous.set(chainTokenKey(chainId, r.vTokenAddress), version);
    }
    if (r.spokeAddress) {
      unambiguous.set(spokeKey(chainId, r.spokeAddress), version);
    }

    // V4 underlying token → separate lookup (shared with V3, so unambiguous lookup can't use it)
    if (isV4 && r.tokenAddress) {
      v4Underlying.set(chainTokenKey(chainId, r.tokenAddress), true);
    }
  }

  return { unambiguous, v4Underlying };
}

export function buildReserveUnderlyingLookup(
  baseDataset: RuntimeReserveData[]
): Set<string> {
  const set = new Set<string>();
  for (const r of baseDataset) {
    if (r.aTokenAddress) {
      set.add(chainTokenKey(r.chainId, r.aTokenAddress.toLowerCase()));
    }
    if (r.tokenAddress) {
      set.add(chainTokenKey(r.chainId, r.tokenAddress.toLowerCase()));
    }
  }
  return set;
}

/**
 * Derive protocol version from Merkl opportunity data.
 *
 * Priority (ADR-0018):
 *   1. type starts with AAVE_V4_           → v4  (zero-cost: Merkl naming convention)
 *   2. Unambiguous address lookup (aToken/vToken/spoke) → v3/v4
 *   3. V4 underlying token lookup           → v4  (safe: V3 never uses underlying as explorerAddress)
 *   4. Default                               → v3  (conservative)
 */
export function isV4SpokeOpportunity(type: string | undefined): boolean {
  return !!type?.startsWith("AAVE_V4_SPOKE_");
}

export function deriveProtocolVersion(
  opportunityType: string | undefined,
  explorerAddress: string | undefined,
  chainId: number,
  unambiguousLookup: Map<string, "v3" | "v4">,
  v4UnderlyingLookup: Map<string, true>
): "v3" | "v4" {
  // Step 1: type prefix check (fastest, catches all current V4 types)
  if (opportunityType && opportunityType.toUpperCase().startsWith("AAVE_V4_")) {
    return "v4";
  }

  if (!explorerAddress) {
    return "v3";
  }

  const key = chainTokenKey(chainId, explorerAddress);

  // Step 2: unambiguous address lookup
  const version = unambiguousLookup.get(key);
  if (version) return version;

  // Step 3: V4 underlying token lookup
  if (v4UnderlyingLookup.has(key)) return "v4";

  // Step 4: default
  return "v3";
}

interface CampaignSnapshotLiteForForecastFile {
  id: string;
  amount?: unknown;
  startTimestamp?: unknown;
  endTimestamp?: unknown;
  rewardToken?: {
    address?: unknown;
    symbol?: unknown;
    price?: unknown;
    decimals?: unknown;
  };
  params?: {
    decimalsRewardToken?: unknown;
    distributionMethodParameters?: {
      distributionSettings?: {
        apr?: unknown;
        targetAPR?: unknown;
      };
    };
  };
}

interface ForecastCampaignMetaLite {
  chainId: number;
  tvl: number;
  campaignTypeHint: ForecastCampaignTypeLite;
  campaignSnapshot: CampaignSnapshotLiteForForecastFile | null;
  useTokenRateInMetrics: boolean;
  rawDistributionType?: string;
  rawMode?: string;
}

interface ProcessMerklDataOptions {
  reserveTokenPriceByChainAndAddress?: Map<string, number>;
  reserveUnderlyingLookup?: Set<string>;
  priceSourceStats?: Record<UsdPriceSource, number>;
  reserveIdSet?: Set<string>;
  baseDataset?: RuntimeReserveData[];
}

interface MerklStaleStatus {
  stale: boolean;
  reason?: string;
  fallbackSource?: "memory" | "disk";
  lastSuccessfulAt?: string;
  lastFetchError?: string;
  fetchedOpportunities: number;
  usedOpportunities: number;
}

interface MerklArtifactsPayload {
  rawOpportunities: MerklOpportunity[];
  liveOpportunities: MerklOpportunity[];
  processedData: MerklOpportunityData[];
  index: Record<string, MerklOpportunityData[]>;
  forecastCampaignMetaLite: Record<string, ForecastCampaignMetaLite>;
  staleStatus: MerklStaleStatus;
}

interface MerklFallbackSnapshot {
  source: "memory" | "disk";
  rawOpportunities: MerklOpportunity[];
  liveOpportunities: MerklOpportunity[];
  processedData: MerklOpportunityData[];
  index: Record<string, MerklOpportunityData[]>;
  forecastCampaignMetaLite: Record<string, ForecastCampaignMetaLite>;
  lastSuccessfulAt?: string;
}

interface MerklSuccessfulSnapshot {
  processedData: MerklOpportunityData[];
  index: Record<string, MerklOpportunityData[]>;
  forecastCampaignMetaLite: Record<string, ForecastCampaignMetaLite>;
  liveOpportunityCount: number;
  lastSuccessfulAt?: string;
}

const _merklState = {
  lastSuccessfulSnapshot: null as MerklSuccessfulSnapshot | null,
  lastFetchError: null as string | null,
};

/** @internal test-only hook to reset all mutable state */
export function resetMerklState(): void {
  _merklState.lastSuccessfulSnapshot = null;
  _merklState.lastFetchError = null;
}

const getRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const isNonEmptyIndex = (
  value: unknown
): value is Record<string, MerklOpportunityData[]> => {
  const record = getRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
};

const readDiskFallbackSnapshot =
  async (): Promise<MerklFallbackSnapshot | null> => {
    try {
      const merklRawDataPath = join(DEBUG_DATA_DIR, "merkl-raw-data.json");
      const rawJson = JSON.parse(
        await readFile(merklRawDataPath, "utf-8")
      ) as Record<string, unknown>;
      const indexRaw = rawJson.index;
      if (!isNonEmptyIndex(indexRaw)) return null;
      const index = indexRaw as Record<string, MerklOpportunityData[]>;

      const rawOpportunities = Array.isArray(rawJson.rawOpportunities)
        ? (rawJson.rawOpportunities as MerklOpportunity[])
        : [];
      const liveOpportunities = Array.isArray(rawJson.liveOpportunities)
        ? (rawJson.liveOpportunities as MerklOpportunity[])
        : rawOpportunities;
      const processedData = Array.isArray(rawJson.processedData)
        ? (rawJson.processedData as MerklOpportunityData[])
        : Object.values(index).flat();

      let forecastCampaignMetaLite: Record<string, ForecastCampaignMetaLite> =
        {};
      try {
        const merklForecastLitePath = join(
          RUNTIME_DATA_DIR,
          "merkl-opportunity-meta-lite.json"
        );
        const liteJson = JSON.parse(
          await readFile(merklForecastLitePath, "utf-8")
        ) as Record<string, unknown>;
        const campaigns = getRecord(liteJson.campaigns);
        if (campaigns) {
          forecastCampaignMetaLite = campaigns as unknown as Record<
            string,
            ForecastCampaignMetaLite
          >;
        }
      } catch {
        forecastCampaignMetaLite =
          buildForecastCampaignMetaLiteMap(liveOpportunities);
      }

      return {
        source: "disk",
        rawOpportunities,
        liveOpportunities,
        processedData,
        index,
        forecastCampaignMetaLite,
        lastSuccessfulAt:
          typeof rawJson.timestamp === "string" ? rawJson.timestamp : undefined,
      };
    } catch {
      return null;
    }
  };

const resolveMerklFallbackSnapshot =
  async (): Promise<MerklFallbackSnapshot | null> => {
    const memorySnapshot = _merklState.lastSuccessfulSnapshot;
    if (
      memorySnapshot !== null &&
      Object.keys(memorySnapshot.index).length > 0
    ) {
      return {
        source: "memory" as const,
        rawOpportunities: [],
        liveOpportunities: [], // empty: memory fallback skips raw debug rewrite; count preserved via liveOpportunityCount
        processedData: memorySnapshot.processedData,
        index: memorySnapshot.index,
        forecastCampaignMetaLite: memorySnapshot.forecastCampaignMetaLite,
        lastSuccessfulAt: memorySnapshot.lastSuccessfulAt,
      };
    }
    return readDiskFallbackSnapshot();
  };

const getSnapshotAgeMs = (iso?: string): number | null => {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return Math.max(0, Date.now() - ts);
};

const isFallbackSnapshotFreshEnough = (
  snapshot: MerklFallbackSnapshot
): boolean => {
  const ageMs = getSnapshotAgeMs(snapshot.lastSuccessfulAt);
  if (ageMs === null) return false;
  return ageMs <= MERKL_HARD_TTL_MS;
};

const persistMerklArtifacts = async (
  payload: MerklArtifactsPayload
): Promise<void> => {
  await mkdir(DEBUG_DATA_DIR, { recursive: true });
  await mkdir(RUNTIME_DATA_DIR, { recursive: true });

  const merklRawDataPath = join(DEBUG_DATA_DIR, "merkl-raw-data.json");
  await writeJsonAtomic(merklRawDataPath, {
    timestamp: new Date().toISOString(),
    stale: payload.staleStatus,
    rawOpportunities: payload.rawOpportunities,
    liveOpportunities: payload.liveOpportunities,
    processedData: payload.processedData,
    index: payload.index,
  });
  logger.info(
    `💾 Merkl raw data saved to ${merklRawDataPath}${payload.staleStatus.stale ? " (stale fallback)" : ""}`
  );

  const merklForecastLitePath = join(
    RUNTIME_DATA_DIR,
    "merkl-opportunity-meta-lite.json"
  );
  await writeJsonAtomic(
    merklForecastLitePath,
    {
      timestamp: new Date().toISOString(),
      stale: payload.staleStatus,
      campaigns: payload.forecastCampaignMetaLite,
    },
    { space: 0 }
  );
  logger.info(
    `💾 Merkl forecast lite data saved to ${merklForecastLitePath}${payload.staleStatus.stale ? " (stale fallback)" : ""}`
  );
};

const buildCampaignSnapshotLiteForForecastFile = (
  campaign: any
): CampaignSnapshotLiteForForecastFile | null => {
  const hashId =
    typeof campaign?.campaignId === "string"
      ? campaign.campaignId
      : String(campaign?.campaignId || "").trim();
  const dbId =
    typeof campaign?.id === "string"
      ? campaign.id
      : String(campaign?.id || "").trim();
  const id = hashId || dbId;
  if (!id) return null;

  const snapshot: CampaignSnapshotLiteForForecastFile = { id };
  if (campaign?.amount !== undefined) snapshot.amount = campaign.amount;
  if (campaign?.startTimestamp !== undefined)
    snapshot.startTimestamp = campaign.startTimestamp;
  if (campaign?.endTimestamp !== undefined)
    snapshot.endTimestamp = campaign.endTimestamp;
  if (campaign?.rewardToken) {
    const rewardToken: CampaignSnapshotLiteForForecastFile["rewardToken"] = {};
    if (campaign.rewardToken.address !== undefined)
      rewardToken.address = campaign.rewardToken.address;
    if (campaign.rewardToken.symbol !== undefined)
      rewardToken.symbol = campaign.rewardToken.symbol;
    if (campaign.rewardToken.price !== undefined)
      rewardToken.price = campaign.rewardToken.price;
    if (campaign.rewardToken.decimals !== undefined)
      rewardToken.decimals = campaign.rewardToken.decimals;
    if (Object.keys(rewardToken).length > 0) snapshot.rewardToken = rewardToken;
  }
  if (campaign?.params) {
    const params: CampaignSnapshotLiteForForecastFile["params"] = {};
    if (campaign.params.decimalsRewardToken !== undefined) {
      params.decimalsRewardToken = campaign.params.decimalsRewardToken;
    }
    const apr =
      campaign.params?.distributionMethodParameters?.distributionSettings?.apr;
    const targetAPR =
      campaign.params?.distributionMethodParameters?.distributionSettings
        ?.targetAPR;
    if (apr !== undefined || targetAPR !== undefined) {
      params.distributionMethodParameters = {
        distributionSettings: {
          ...(apr !== undefined ? { apr } : {}),
          ...(targetAPR !== undefined ? { targetAPR } : {}),
        },
      };
    }
    if (Object.keys(params).length > 0) snapshot.params = params;
  }
  return snapshot;
};

export const buildForecastCampaignMetaLiteMap = (
  opportunities: MerklOpportunity[]
): Record<string, ForecastCampaignMetaLite> => {
  const result: Record<string, ForecastCampaignMetaLite> = {};

  for (const opp of opportunities) {
    const tvl = Number(opp?.tvl);
    if (!Number.isFinite(tvl) || tvl < 0) continue;

    const breakdowns = opp?.rewardsRecord?.breakdowns;
    if (!Array.isArray(breakdowns) || breakdowns.length === 0) continue;

    const campaignSnapshotById = new Map<
      string,
      CampaignSnapshotLiteForForecastFile
    >();
    const localDbIdToCacheKey = new Map<string, string>();
    if (Array.isArray(opp.campaigns)) {
      for (const campaign of opp.campaigns) {
        const snapshot = buildCampaignSnapshotLiteForForecastFile(campaign);
        if (snapshot) {
          const rawCampaignId = String(campaign.campaignId || "").trim();
          const campaignHashId =
            rawCampaignId && rawCampaignId.startsWith("0x")
              ? rawCampaignId
              : "";
          const dbId = String(campaign.id || "").trim();
          const cacheKey = campaignHashId || dbId;
          if (cacheKey) {
            campaignSnapshotById.set(cacheKey, snapshot);
            if (dbId) localDbIdToCacheKey.set(dbId, cacheKey);
          }
        }
      }
    }

    for (const breakdown of breakdowns) {
      const breakdownDbId = String(breakdown?.campaignId || "").trim();
      if (!breakdownDbId) continue;

      const cacheKey = localDbIdToCacheKey.get(breakdownDbId) || breakdownDbId;

      const breakdownDistributionType =
        (typeof breakdown?.distributionType === "string" &&
          breakdown.distributionType) ||
        (typeof opp?.distributionType === "string" && opp.distributionType) ||
        undefined;
      const campaignObj = opp.campaigns?.find(
        (c: any) => String(c?.id || "") === breakdownDbId
      );
      const mode =
        campaignObj?.params?.distributionMethodParameters?.distributionSettings
          ?.mode || undefined;
      const targetAPR =
        campaignObj?.params?.distributionMethodParameters?.distributionSettings
          ?.targetAPR ?? undefined;

      const campaignTypeHint = normalizeCampaignType({
        distributionType: breakdownDistributionType,
        targetAPR,
      });
      if (!campaignTypeHint) continue;

      const existing = result[cacheKey];
      const campaignSnapshot = campaignSnapshotById.get(cacheKey) ?? null;
      const useTokenRateInMetrics = !(
        typeof breakdown?.token?.price === "number" &&
        Number.isFinite(breakdown.token.price) &&
        breakdown.token.price > 0
      );

      if (!existing) {
        result[cacheKey] = {
          chainId: opp.chainId,
          tvl,
          campaignTypeHint,
          campaignSnapshot,
          useTokenRateInMetrics,
          rawDistributionType: breakdownDistributionType,
          rawMode: typeof mode === "string" ? mode : undefined,
        };
        continue;
      }

      result[cacheKey] = {
        chainId: existing.chainId > 0 ? existing.chainId : opp.chainId,
        tvl: existing.tvl > 0 ? existing.tvl : tvl,
        campaignTypeHint: existing.campaignTypeHint,
        campaignSnapshot: existing.campaignSnapshot ?? campaignSnapshot,
        useTokenRateInMetrics:
          existing.useTokenRateInMetrics || useTokenRateInMetrics,
        rawDistributionType:
          existing.rawDistributionType ?? breakdownDistributionType,
        rawMode:
          existing.rawMode ?? (typeof mode === "string" ? mode : undefined),
      };
    }
  }

  return result;
};

const toFiniteNumberForForecast = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

interface ForecastFieldsFlat {
  campaignType: ForecastCampaignTypeLite;
  totalBudget: number;
  aprCap?: number;
  latestTvl: number;
  plannedDaily: number;
}

/**
 * Compute opportunity-only forecast fields for a campaign.
 * Uses only data available from the opportunity snapshot (no metrics API needed).
 */
const buildForecastFieldsFromOpportunity = async (
  meta: ForecastCampaignMetaLite,
  options?: ProcessMerklDataOptions
): Promise<ForecastFieldsFlat | null> => {
  const snapshot = meta.campaignSnapshot;
  if (!snapshot) return null;

  const startTs = toFiniteNumberForForecast(snapshot.startTimestamp);
  const endTs = toFiniteNumberForForecast(snapshot.endTimestamp);
  if (startTs === null || endTs === null || endTs <= startTs) return null;

  const rawPrice =
    snapshot.rewardToken?.price !== undefined
      ? Number(snapshot.rewardToken.price)
      : undefined;
  const normalizedPrice =
    Number.isFinite(rawPrice) && rawPrice! > 0 ? rawPrice : undefined;
  if (
    !meta.useTokenRateInMetrics &&
    normalizedPrice !== undefined &&
    options?.priceSourceStats
  ) {
    options.priceSourceStats.snapshot += 1;
  }

  let effectiveSnapshot = snapshot;
  if (!meta.useTokenRateInMetrics && normalizedPrice === undefined) {
    const reserveTokenAddress =
      typeof snapshot.rewardToken?.address === "string"
        ? snapshot.rewardToken.address.toLowerCase()
        : "";
    const reservePriceKey = chainTokenKey(meta.chainId, reserveTokenAddress);
    const reserveTokenPrice =
      reserveTokenAddress && options?.reserveTokenPriceByChainAndAddress
        ? options.reserveTokenPriceByChainAndAddress.get(reservePriceKey)
        : undefined;
    const normalizedReserveTokenPrice =
      typeof reserveTokenPrice === "number" &&
      Number.isFinite(reserveTokenPrice) &&
      reserveTokenPrice > 0
        ? reserveTokenPrice
        : undefined;

    if (normalizedReserveTokenPrice !== undefined) {
      effectiveSnapshot = {
        ...snapshot,
        rewardToken: {
          ...(snapshot.rewardToken ?? {}),
          price: normalizedReserveTokenPrice,
        },
      };
    }
  }

  if (!meta.useTokenRateInMetrics && normalizedPrice === undefined) {
    const resolved = await resolveUsdPriceWithPriority({
      chainId: meta.chainId,
      tokenAddress:
        typeof snapshot.rewardToken?.address === "string"
          ? snapshot.rewardToken.address
          : undefined,
      tokenSymbol:
        typeof snapshot.rewardToken?.symbol === "string"
          ? snapshot.rewardToken.symbol
          : undefined,
      snapshotPrice: undefined,
      reservePrice:
        typeof effectiveSnapshot.rewardToken?.price === "number" &&
        Number.isFinite(effectiveSnapshot.rewardToken.price) &&
        effectiveSnapshot.rewardToken.price > 0
          ? effectiveSnapshot.rewardToken.price
          : undefined,
    });
    if (options?.priceSourceStats) {
      options.priceSourceStats[resolved.source] += 1;
    }

    if (resolved.price !== undefined && resolved.price > 0) {
      effectiveSnapshot = {
        ...snapshot,
        rewardToken: {
          ...(snapshot.rewardToken ?? {}),
          price: resolved.price,
        },
      };
    }
  }

  const totalBudget = normalizeMerklCampaignTotalBudget(effectiveSnapshot);
  if (totalBudget === null) return null;
  if (totalBudget <= 0) return null;

  // For campaigns with rewardTokenPrice (USD path), do not emit token-unit fallback values.
  if (!meta.useTokenRateInMetrics) {
    const resolvedPrice = Number(effectiveSnapshot.rewardToken?.price);
    if (!Number.isFinite(resolvedPrice) || resolvedPrice <= 0) {
      logger.warn(
        `⚠️ Skipping forecast budget fields for campaign ${snapshot.id}: missing USD price (chainId=${meta.chainId}, token=${String(
          effectiveSnapshot.rewardToken?.symbol || ""
        )})`
      );
      return null;
    }
  }

  const totalDays = Math.max((endTs - startTs) / 86400, 0.0001);
  const plannedDaily = totalBudget / totalDays;

  const fields: ForecastFieldsFlat = {
    campaignType: meta.campaignTypeHint,
    totalBudget,
    latestTvl: meta.tvl,
    plannedDaily,
  };

  // APR cap (for MAX/FIX reward types + TARGET_TOTAL_APR)
  if (
    meta.campaignTypeHint === "MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE" ||
    meta.campaignTypeHint === "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE"
  ) {
    const rawApr =
      snapshot.params?.distributionMethodParameters?.distributionSettings?.apr;
    const aprValue = toFiniteNumberForForecast(rawApr);
    if (aprValue !== null && aprValue > 0) {
      fields.aprCap = aprValue;
    }
  } else if (meta.campaignTypeHint === "TARGET_TOTAL_APR") {
    const rawTargetAPR =
      snapshot.params?.distributionMethodParameters?.distributionSettings
        ?.targetAPR;
    const targetAPRValue = toFiniteNumberForForecast(rawTargetAPR);
    if (targetAPRValue !== null && targetAPRValue > 0) {
      fields.aprCap = targetAPRValue;
    }
  }

  return fields;
};

/**
 * 获取 Merkl opportunities（使用 mainProtocolId 参数，返回 Aave 和 Tydro 相关的数据）
 */
export async function fetchMerklOpportunities(): Promise<MerklOpportunity[]> {
  try {
    logger.info(
      "🔄 Fetching Merkl opportunities for Aave + Tydro (LIVE, campaigns=true, short-page pagination)..."
    );
    const opportunities = (await fetchMerklOpportunitiesSnapshot({
      baseUrl: "https://api.merkl.xyz/v4",
      ttlMs: OPPORTUNITIES_SOFT_TTL_MS,
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    })) as MerklOpportunity[];

    _merklState.lastFetchError = null;
    logger.info(
      `✅ Fetched ${opportunities.length} live opportunities from Merkl`
    );
    return opportunities;
  } catch (error) {
    logger.error("❌ Error fetching Merkl opportunities:", error);
    _merklState.lastFetchError =
      error instanceof Error ? error.message : String(error);
    return [];
  }
}

export interface ResolvedCampaignApr {
  apr: number;
}

const AMOUNT_VARIANT_TYPES: Set<ForecastCampaignTypeLite> = new Set([
  "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE",
  "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT",
  "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT",
]);

function isAmountVariant(type?: ForecastCampaignTypeLite | null): boolean {
  return type ? AMOUNT_VARIANT_TYPES.has(type) : false;
}

export interface PositionCapExtraction {
  positionCapNative?: string;
  isCombineCap?: boolean;
}

export function extractPositionCapFromCampaign(
  campaign: any
): PositionCapExtraction {
  const computeMethod = campaign?.params?.computeScoreParameters?.computeMethod;
  if (computeMethod !== "maxDeposit") return {};

  const rawMaxDeposit =
    campaign?.params?.computeScoreParameters?.computeSettings?.maxDeposit;
  if (rawMaxDeposit == null) return {};

  const rawString = String(rawMaxDeposit);
  const nativeAmount = Number(rawString);
  if (!Number.isFinite(nativeAmount) || nativeAmount <= 0) return {};

  return { positionCapNative: rawString, isCombineCap: false };
}

function extractDistributionSettingsApr(campaign: any): number {
  const dsApr =
    campaign?.params?.distributionMethodParameters?.distributionSettings?.apr ??
    campaign?.distributionMethodParameters?.distributionSettings?.apr ??
    campaign?.distributionSettings?.apr;
  return Number(dsApr || 0);
}

export const resolveCampaignApr = (
  campaign: any,
  distributionType?: string,
  rewardTokenPrice?: number,
  targetTokenPrice?: number
): ResolvedCampaignApr => {
  if (!campaign) return { apr: 0 };
  const topApr = Number(campaign.apr || 0);
  const targetAPR =
    campaign?.params?.distributionMethodParameters?.distributionSettings
      ?.targetAPR ??
    campaign?.distributionMethodParameters?.distributionSettings?.targetAPR ??
    undefined;
  const campaignType = normalizeCampaignType({
    distributionType,
    targetAPR,
  });

  if (isAmountVariant(campaignType)) {
    const dsApr = extractDistributionSettingsApr(campaign);
    if (dsApr <= 0) return { apr: 0 };

    if (campaignType === "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE") {
      if (!rewardTokenPrice) return { apr: 0 };
      return { apr: dsApr * rewardTokenPrice };
    }

    if (
      campaignType === "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT" ||
      campaignType === "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT"
    ) {
      if (!rewardTokenPrice) return { apr: 0 };
      if (!targetTokenPrice) return { apr: 0 };
      return { apr: dsApr * (rewardTokenPrice / targetTokenPrice) };
    }
  }

  if (topApr > 0) return { apr: topApr / 100 };

  return { apr: 0 };
};

/**
 * 获取 Merkl campaign 详情
 *
 * ID system (verified against Merkl V4 API):
 * - `campaign.id` = Database ID (always numeric, e.g. "15232182461795483137"). Used as /v4/campaigns/{id} input.
 * - `campaign.campaignId` in /v4/opportunities response = Hash ID when 0x-prefixed,
 *   or Merkl internal numeric ID (e.g. "10768955319320541400") when no on-chain hash exists.
 * - `campaign.campaignId` in /v4/campaigns/{id} response = same as above (0x hash or numeric).
 * - `breakdown.campaignId` = always Database ID (matches campaign.id).
 *
 * Hash ID determination uses field POSITION, not format:
 * - campaign.id → always DB ID
 * - campaign.campaignId → hash ID if 0x-prefixed, otherwise internal ID (not usable as hash)
 */
export async function fetchMerklCampaignDetails(
  databaseId: string
): Promise<MerklCampaignDetails | null> {
  try {
    const response = await fetchWithRetry(
      `https://api.merkl.xyz/v4/campaigns/${databaseId}`,
      `Merkl campaign ${databaseId}`
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const campaign = (await response.json()) as any;

    const startedAt = campaign.startTimestamp
      ? new Date(campaign.startTimestamp * 1000).toISOString()
      : "";
    const endedAt = campaign.endTimestamp
      ? new Date(campaign.endTimestamp * 1000).toISOString()
      : "";

    const campaignType = normalizeCampaignType({
      distributionType: campaign.distributionType,
    });
    let rewardTokenPrice: number | undefined;
    let targetTokenPrice: number | undefined;
    if (isAmountVariant(campaignType)) {
      const chainId = campaign.chainId ?? 0;
      const rewardAddr =
        typeof campaign?.rewardToken?.address === "string"
          ? campaign.rewardToken.address
          : undefined;
      const rewardSym =
        typeof campaign?.rewardToken?.symbol === "string"
          ? campaign.rewardToken.symbol
          : undefined;
      const rewardSnap = campaign?.rewardToken?.price;
      const resolved = await resolveUsdPriceWithPriority({
        chainId,
        tokenAddress: rewardAddr,
        tokenSymbol: rewardSym,
        snapshotPrice: rewardSnap,
      });
      rewardTokenPrice = resolved.price;
      if (
        campaignType === "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT" ||
        campaignType === "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT"
      ) {
        const targetAddr =
          typeof campaign?.targetToken?.address === "string"
            ? campaign.targetToken.address
            : undefined;
        const targetSym =
          typeof campaign?.targetToken?.symbol === "string"
            ? campaign.targetToken.symbol
            : undefined;
        if (targetAddr || targetSym) {
          const targetResolved = await resolveUsdPriceWithPriority({
            chainId,
            tokenAddress: targetAddr,
            tokenSymbol: targetSym,
          });
          targetTokenPrice = targetResolved.price;
        }
      }
    }

    const resolved = resolveCampaignApr(
      campaign,
      campaign.distributionType,
      rewardTokenPrice,
      targetTokenPrice
    );
    const parentCampaignId =
      typeof campaign.parentCampaignId === "string" && campaign.parentCampaignId
        ? campaign.parentCampaignId
        : undefined;
    const rawCampaignId =
      typeof campaign.campaignId === "string" && campaign.campaignId
        ? campaign.campaignId
        : undefined;
    const hashId =
      rawCampaignId && rawCampaignId.startsWith("0x") ? rawCampaignId : "";
    // positionCapNative extraction: since we no longer need reserve context (price/decimals),
    // we can extract directly from the campaign's computeMethod/maxDeposit.
    // Non-Aave maxDeposit campaigns may also be extracted; the frontend filters by reserve match.
    const positionCapExtraction = extractPositionCapFromCampaign(campaign);
    return {
      startedAt,
      endedAt,
      id: hashId || databaseId,
      databaseId,
      apr: resolved.apr,
      whitelistOnly: isCampaignWhitelistOnly(campaign),
      ...(parentCampaignId && { parentCampaignId }),
      ...(positionCapExtraction.positionCapNative !== undefined && {
        positionCapNative: positionCapExtraction.positionCapNative,
      }),
      ...(positionCapExtraction.isCombineCap !== undefined && {
        isCombineCap: positionCapExtraction.isCombineCap,
      }),
    };
  } catch (error) {
    logger.error(`❌ Error fetching campaign ${databaseId}:`, error);
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
export function generateMerklOpportunityLink(
  opportunity: MerklOpportunity
): string | null {
  // 需要 identifier、type 和 chain.name 字段来构建链接
  if (
    !opportunity.identifier ||
    !opportunity.type ||
    !opportunity.chain?.name
  ) {
    return null;
  }

  // 将链名称转换为小写（Merkl URL 使用小写链名称）
  const chainName = opportunity.chain.name.toLowerCase();
  const baseUrl = "https://app.merkl.xyz";
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
export function parseMarketNameFromOpportunityName(
  opportunityName: string | undefined,
  chainId: number
): string {
  if (!opportunityName) {
    // 如果没有 name，根据 chainId 返回默认值
    return chainId === 1 ? "AaveV3Ethereum" : "Unknown";
  }

  const nameLower = opportunityName.toLowerCase();

  // 只对 chainId 1 (Ethereum) 进行特殊市场解析
  if (chainId === 1) {
    if (nameLower.includes("horizon")) {
      return "AaveV3EthereumHorizon";
    } else if (nameLower.includes("prime")) {
      return "AaveV3EthereumLido";
    } else if (nameLower.includes("etherfi")) {
      return "AaveV3EthereumEtherFi";
    } else {
      return "AaveV3Ethereum";
    }
  }

  // 对于其他 chainId，返回默认值（可以根据需要扩展）
  return "Unknown";
}

/**
 * 处理 Merkl 数据，构建索引并返回
 * Merkl 索引：explorerAddress -> opportunities
 * 对于 chainId === 1，使用 marketName-chainId-explorerAddress 作为 key
 * 对于其他 chainId，使用 chainId-explorerAddress 作为 key
 */
/**
 * 当 Merkl breakdown 提供 `value` 且可解析为有限数时，推导每千刀 TVL 强度。
 * AMOUNT_PER_AMOUNT 变体的 TVL 是 target token 数量而非 USD，
 * 需要乘以 targetTokenPrice 转换为 USD 基准。
 */
export function merklPointsFieldsFromBreakdownValue(
  opp: MerklOpportunity,
  rewardsBreakdown: { value?: number },
  options?: {
    distributionType?: string;
    targetTokenPrice?: number;
    campaignApr?: number;
  }
): { pointsPerThousandUsd: number } | undefined {
  if (options?.campaignApr !== undefined && options.campaignApr > 0) {
    return undefined;
  }
  if (rewardsBreakdown.value === undefined) {
    return undefined;
  }
  const rewardUnits = Number(rewardsBreakdown.value);
  if (!Number.isFinite(rewardUnits)) {
    return undefined;
  }
  const tvl = Number(opp.tvl) || 0;
  const isPerAmount =
    options?.distributionType === "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT" ||
    options?.distributionType === "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT";
  const priceMultiplier = isPerAmount ? (options?.targetTokenPrice ?? 0) : 1;
  const pointsPerThousandUsd =
    tvl > 0 ? (rewardUnits / tvl) * 1000 * priceMultiplier : 0;
  return { pointsPerThousandUsd };
}

export type MerklRewardsBreakdownForIntensity = {
  token?: {
    type?: string;
    symbol?: string;
    name?: string;
    icon?: string;
    id?: string;
  };
};

export function extractRewardTokenFields(
  token?: MerklRewardsBreakdownForIntensity["token"]
): {
  rewardTokenSymbol?: string;
  rewardTokenIconUrl?: string;
  rewardTokenId?: string;
} {
  if (!token) return {};
  return {
    ...(typeof token.symbol === "string" && token.symbol
      ? { rewardTokenSymbol: token.symbol }
      : {}),
    ...(typeof token.icon === "string" && token.icon
      ? { rewardTokenIconUrl: token.icon }
      : {}),
    ...(typeof token.id === "string" && token.id
      ? { rewardTokenId: token.id }
      : {}),
  };
}

/**
 * 是否应为该 breakdown 输出 `pointsPerThousandUsd`（由 `value`÷TVL 推导）。
 * 启用条件：Merkl 在 breakdown 上把奖励标为 `token.type === 'PRETGE'`（pre-TGE 积分）
 * 或 `token.type === 'POINT'`（纯积分）。PRETGE 覆盖 Ink/Tydro 等场景，
 * POINT 覆盖 AMOUNT 变体（FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE 等）的 points token。
 *
 * 注意：这只决定是否输出 points/intensity 字段，不决定 forecast 的 token/USD 路径。
 * forecast 路径由 `useTokenRateInMetrics` 决定，后者基于 rewardTokenPrice 是否存在：
 * 有 price → useTokenRateInMetrics=false（USD 路径），无 price → true（token 路径）。
 */
export function merklBreakdownUsesPointsIntensityFields(
  breakdown: MerklRewardsBreakdownForIntensity
): boolean {
  const tokenType = String(breakdown.token?.type || "")
    .trim()
    .toUpperCase();
  return tokenType === "PRETGE" || tokenType === "POINT";
}

export async function processMerklData(
  options?: ProcessMerklDataOptions
): Promise<{
  index: Record<string, MerklOpportunityData[]>;
  campaignAccess: MerklCampaignAccess[];
}> {
  const priceSourceStats: Record<UsdPriceSource, number> = {
    snapshot: 0,
    reserve: 0,
    coingecko: 0,
    missing: 0,
  };
  const fetchedOpportunities = await fetchMerklOpportunities();
  const mergedOptions: ProcessMerklDataOptions = {
    ...options,
    priceSourceStats,
  };

  // Build protocol version lookup tables from baseDataset (ADR-0018)
  const protocolLookup = options?.baseDataset
    ? buildProtocolVersionLookup(options.baseDataset)
    : {
        unambiguous: new Map<string, "v3" | "v4">(),
        v4Underlying: new Map<string, true>(),
      };
  const reserveUnderlyingLookup = options?.baseDataset
    ? buildReserveUnderlyingLookup(options.baseDataset)
    : new Set<string>();
  const mergedOptionsWithLookup: ProcessMerklDataOptions = {
    ...mergedOptions,
    reserveUnderlyingLookup,
  };
  let opportunities = fetchedOpportunities;
  let staleStatus: MerklStaleStatus = {
    stale: false,
    fetchedOpportunities: fetchedOpportunities.length,
    usedOpportunities: fetchedOpportunities.length,
  };

  if (fetchedOpportunities.length === 0) {
    const fallback = await resolveMerklFallbackSnapshot();
    if (fallback && isFallbackSnapshotFreshEnough(fallback)) {
      const fallbackAgeMs = fallback.lastSuccessfulAt
        ? Date.now() - new Date(fallback.lastSuccessfulAt).getTime()
        : null;
      logger.warn(
        `⚠️ Merkl opportunities empty; reusing ${fallback.source} fallback snapshot (${Object.keys(fallback.index).length} token keys${
          fallbackAgeMs !== null && Number.isFinite(fallbackAgeMs)
            ? `, age=${Math.max(0, Math.round(fallbackAgeMs / 1000))}s`
            : ""
        })`
      );

      await persistMerklArtifacts({
        rawOpportunities: fallback.rawOpportunities,
        liveOpportunities: fallback.liveOpportunities,
        processedData: fallback.processedData,
        index: fallback.index,
        forecastCampaignMetaLite: fallback.forecastCampaignMetaLite,
        staleStatus: {
          stale: true,
          reason: "merkl-opportunities-empty",
          fallbackSource: fallback.source,
          lastSuccessfulAt: fallback.lastSuccessfulAt,
          ...(_merklState.lastFetchError
            ? { lastFetchError: _merklState.lastFetchError }
            : {}),
          fetchedOpportunities: fetchedOpportunities.length,
          usedOpportunities:
            fallback.source === "memory"
              ? (_merklState.lastSuccessfulSnapshot?.liveOpportunityCount ?? 0)
              : fallback.liveOpportunities.length,
        },
      });

      _merklState.lastSuccessfulSnapshot = {
        processedData: fallback.processedData,
        index: fallback.index,
        forecastCampaignMetaLite: fallback.forecastCampaignMetaLite,
        liveOpportunityCount:
          fallback.source === "memory"
            ? (_merklState.lastSuccessfulSnapshot?.liveOpportunityCount ??
              fallback.liveOpportunities.length)
            : fallback.liveOpportunities.length,
        lastSuccessfulAt: fallback.lastSuccessfulAt,
      };

      return { index: fallback.index, campaignAccess: [] };
    }

    if (fallback && !isFallbackSnapshotFreshEnough(fallback)) {
      const fallbackAgeMs = getSnapshotAgeMs(fallback.lastSuccessfulAt);
      logger.warn(
        `⚠️ Merkl fallback snapshot expired (max ${Math.round(MERKL_HARD_TTL_MS / 1000)}s, age=${
          fallbackAgeMs === null
            ? "unknown"
            : `${Math.round(fallbackAgeMs / 1000)}s`
        }); refusing stale fallback`
      );
    }

    logger.warn(
      "⚠️ Merkl opportunities empty and no fallback snapshot available; continuing with empty result"
    );
    staleStatus = {
      stale: true,
      reason: fallback
        ? "merkl-opportunities-empty-fallback-expired"
        : "merkl-opportunities-empty-no-fallback",
      ...(_merklState.lastFetchError
        ? { lastFetchError: _merklState.lastFetchError }
        : {}),
      fetchedOpportunities: fetchedOpportunities.length,
      usedOpportunities: 0,
    };
  }

  const merklData: Record<string, MerklOpportunityData[]> = {};
  logger.info("🔍 Processing Merkl opportunities...");
  // fetchMerklOpportunities 已在 API 层过滤 status=LIVE
  const liveOpportunities = opportunities;
  logger.info(
    `Processing ${liveOpportunities.length} live Merkl opportunities`
  );

  const campaignDetailsCache = new Map<string, MerklCampaignDetails | null>();
  const campaignAccessMap = new Map<string, MerklCampaignAccess>();

  type PriceLookupKey = `${number}:${string}:${string}`;
  const preResolvedPrices = new Map<PriceLookupKey, number | undefined>();

  const amountVariantEntries: Array<{
    campaignId: string;
    campaign: any;
    opp: MerklOpportunity;
    campaignType: ForecastCampaignTypeLite;
  }> = [];
  for (const opp of liveOpportunities) {
    if (!Array.isArray(opp.campaigns)) continue;
    for (const campaign of opp.campaigns) {
      const hashId = String(campaign.campaignId || "").trim();
      if (!hashId) continue;
      if (campaignDetailsCache.has(hashId)) continue;
      const campaignType = normalizeCampaignType({
        distributionType: campaign.distributionType,
      });
      if (isAmountVariant(campaignType) && campaignType) {
        amountVariantEntries.push({
          campaignId: hashId,
          campaign,
          opp,
          campaignType,
        });
      }
    }
  }

  const tokensToResolve = new Set<PriceLookupKey>();
  const snapshotPrices = new Map<PriceLookupKey, number | undefined>();
  for (const entry of amountVariantEntries) {
    const chainId = entry.opp.chainId ?? 0;
    const rewardBreakdown = entry.opp.rewardsRecord?.breakdowns?.[0];
    const rewardAddr =
      typeof rewardBreakdown?.token?.address === "string"
        ? rewardBreakdown.token.address
        : "";
    const rewardSym =
      typeof rewardBreakdown?.token?.symbol === "string"
        ? rewardBreakdown.token.symbol
        : "";
    if (rewardAddr || rewardSym) {
      const key = `${chainId}:${rewardAddr}:${rewardSym}` as PriceLookupKey;
      tokensToResolve.add(key);
      const snapPrice =
        typeof rewardBreakdown?.token?.price === "number" &&
        Number.isFinite(rewardBreakdown.token.price) &&
        rewardBreakdown.token.price > 0
          ? rewardBreakdown.token.price
          : undefined;
      if (snapPrice !== undefined && !snapshotPrices.has(key)) {
        snapshotPrices.set(key, snapPrice);
      }
    }
    if (
      entry.campaignType === "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT" ||
      entry.campaignType === "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT"
    ) {
      const targetToken =
        Array.isArray(entry.opp.tokens) && entry.opp.tokens.length > 0
          ? entry.opp.tokens[0]
          : undefined;
      const targetAddr =
        typeof targetToken?.address === "string" ? targetToken.address : "";
      const targetSym =
        typeof targetToken?.symbol === "string" ? targetToken.symbol : "";
      if (targetAddr || targetSym) {
        const key = `${chainId}:${targetAddr}:${targetSym}` as PriceLookupKey;
        tokensToResolve.add(key);
        const snapPrice =
          typeof targetToken?.price === "number" &&
          Number.isFinite(targetToken.price) &&
          targetToken.price > 0
            ? targetToken.price
            : undefined;
        if (snapPrice !== undefined && !snapshotPrices.has(key)) {
          snapshotPrices.set(key, snapPrice);
        }
      }
    }
  }

  for (const key of tokensToResolve) {
    const [chainIdStr, addr, sym] = key.split(":");
    const chainId = Number(chainIdStr);
    const snapshotPrice = snapshotPrices.get(key);
    const resolved = await resolveUsdPriceWithPriority({
      chainId,
      tokenAddress: addr || undefined,
      tokenSymbol: sym || undefined,
      snapshotPrice,
    });
    preResolvedPrices.set(key, resolved.price);
  }

  const amountVariantPriceMap = new Map<
    string,
    { rewardTokenPrice?: number; targetTokenPrice?: number }
  >();
  for (const entry of amountVariantEntries) {
    const chainId = entry.opp.chainId ?? 0;
    const rewardBreakdown = entry.opp.rewardsRecord?.breakdowns?.[0];
    const rewardAddr =
      typeof rewardBreakdown?.token?.address === "string"
        ? rewardBreakdown.token.address
        : "";
    const rewardSym =
      typeof rewardBreakdown?.token?.symbol === "string"
        ? rewardBreakdown.token.symbol
        : "";
    const rewardKey = `${chainId}:${rewardAddr}:${rewardSym}` as PriceLookupKey;
    const rewardTokenPrice = preResolvedPrices.get(rewardKey);

    let targetTokenPrice: number | undefined;
    if (
      entry.campaignType === "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT" ||
      entry.campaignType === "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT"
    ) {
      const targetToken =
        Array.isArray(entry.opp.tokens) && entry.opp.tokens.length > 0
          ? entry.opp.tokens[0]
          : undefined;
      const targetAddr =
        typeof targetToken?.address === "string" ? targetToken.address : "";
      const targetSym =
        typeof targetToken?.symbol === "string" ? targetToken.symbol : "";
      const targetKey =
        `${chainId}:${targetAddr}:${targetSym}` as PriceLookupKey;
      targetTokenPrice = preResolvedPrices.get(targetKey);
    }

    amountVariantPriceMap.set(entry.campaignId, {
      rewardTokenPrice,
      targetTokenPrice,
    });
  }

  // Build Database ID → Hash ID mapping from opp.campaigns FIRST,
  // so that parentCampaignId can be resolved to hash ID during cache population.
  // campaign.id = DB ID (always). campaign.campaignId = 0x hash ID or internal numeric ID.
  // Only store mappings where campaignId is a 0x hash ID — non-0x campaignId values
  // are Merkl internal IDs that don't correspond to on-chain campaign hashes.
  const dbIdToHashId = new Map<string, string>();
  for (const opp of liveOpportunities) {
    if (!Array.isArray(opp.campaigns)) continue;
    for (const campaign of opp.campaigns) {
      const dbId = String(campaign.id || "").trim();
      const rawCampaignId = String(campaign.campaignId || "").trim();
      const hashId = rawCampaignId.startsWith("0x") ? rawCampaignId : "";
      if (dbId && hashId) {
        dbIdToHashId.set(dbId, hashId);
      }
    }
  }

  const oppCampaignPromises: Promise<void>[] = [];
  for (const opp of liveOpportunities) {
    if (!Array.isArray(opp.campaigns)) continue;
    for (const campaign of opp.campaigns) {
      const rawCampaignId = String(campaign.campaignId || "").trim();
      const hashId =
        rawCampaignId && rawCampaignId.startsWith("0x") ? rawCampaignId : "";
      const databaseId = String(campaign.id || "").trim();
      if (!rawCampaignId) continue;
      const cacheKey = hashId || databaseId;
      if (campaignDetailsCache.has(cacheKey)) continue;
      oppCampaignPromises.push(
        (async () => {
          const campaignType = normalizeCampaignType({
            distributionType: campaign.distributionType,
          });
          let rewardTokenPrice: number | undefined;
          let targetTokenPrice: number | undefined;
          if (isAmountVariant(campaignType)) {
            const preResolved =
              amountVariantPriceMap.get(hashId) ||
              amountVariantPriceMap.get(databaseId);
            rewardTokenPrice = preResolved?.rewardTokenPrice;
            targetTokenPrice = preResolved?.targetTokenPrice;
          } else {
            rewardTokenPrice = undefined;
            targetTokenPrice = undefined;
          }
          const resolved = resolveCampaignApr(
            campaign,
            campaign.distributionType,
            rewardTokenPrice,
            targetTokenPrice
          );
          const rawParentId =
            typeof campaign.parentCampaignId === "string" &&
            campaign.parentCampaignId
              ? campaign.parentCampaignId
              : undefined;
          const parentCampaignId = rawParentId
            ? dbIdToHashId.get(rawParentId) || rawParentId
            : undefined;
          const cacheKey = hashId || databaseId;
          const explorerAddr =
            typeof opp.explorerAddress === "string"
              ? opp.explorerAddress.toLowerCase()
              : "";
          const isKnownReserve =
            explorerAddr && mergedOptionsWithLookup.reserveUnderlyingLookup
              ? mergedOptionsWithLookup.reserveUnderlyingLookup.has(
                  chainTokenKey(opp.chainId ?? 0, explorerAddr)
                )
              : false;
          const positionCapExtraction = isKnownReserve
            ? extractPositionCapFromCampaign(campaign)
            : {};
          campaignDetailsCache.set(cacheKey, {
            startedAt: toIsoFromUnixLike(campaign.startTimestamp),
            endedAt: toIsoFromUnixLike(campaign.endTimestamp),
            id: hashId || databaseId,
            ...(databaseId && { databaseId }),
            apr: resolved.apr,
            whitelistOnly: isCampaignWhitelistOnly(campaign),
            ...(parentCampaignId && { parentCampaignId }),
            ...(positionCapExtraction.positionCapNative !== undefined && {
              positionCapNative: positionCapExtraction.positionCapNative,
            }),
            ...(positionCapExtraction.isCombineCap !== undefined && {
              isCombineCap: positionCapExtraction.isCombineCap,
            }),
          });
          const params = campaign.params ?? {};
          // params.whitelist/blacklist are top-level Merkl API fields populated by various hookTypes:
          //   whitelist: hookType=22 (WHITELIST_ADDRESSES), hookType=26 (WHITELIST_KEY_VALUE_STORE), etc.
          //   blacklist: hookType=4 (SANCTIONED/OFAC), hookType=27 (BLACKLIST_KEY_VALUE_STORE), hookType=28 (BLACKLIST_PER_PROTOCOL), etc.
          const wl = Array.isArray(params.whitelist)
            ? (params.whitelist as string[]).filter(Boolean)
            : [];
          const bl = Array.isArray(params.blacklist)
            ? (params.blacklist as string[]).filter(Boolean)
            : [];
          const borrowHookProtocols = extractBorrowHookProtocols(params.hooks);
          const healthFactorHooks = extractHealthFactorHooks(params.hooks);
          if (
            wl.length > 0 ||
            bl.length > 0 ||
            borrowHookProtocols.length > 0 ||
            healthFactorHooks.length > 0
          ) {
            campaignAccessMap.set(cacheKey, {
              campaignId: cacheKey,
              chainId: opp.chainId ?? 0,
              whitelist: wl,
              blacklist: bl,
              ...(borrowHookProtocols.length > 0 && { borrowHookProtocols }),
              ...(healthFactorHooks.length > 0 && { healthFactorHooks }),
            });
          }
        })()
      );
    }
  }
  await Promise.all(oppCampaignPromises);

  // 补拉少量未在 opportunities.campaigns 出现的 campaign（兼容上游数据缺口）
  // breakdown.campaignId is Database ID; lookup via dbIdToHashId or direct fetch
  const missingCampaignDbIds = new Set<string>();
  for (const opp of liveOpportunities) {
    if (!opp.rewardsRecord?.breakdowns) continue;
    for (const breakdown of opp.rewardsRecord.breakdowns) {
      const dbId = String(breakdown.campaignId || "").trim();
      if (!dbId) continue;
      const hashId = dbIdToHashId.get(dbId) || dbId;
      if (!campaignDetailsCache.has(hashId)) {
        missingCampaignDbIds.add(dbId);
      }
    }
  }

  if (missingCampaignDbIds.size > 0) {
    logger.info(
      `📦 Fetching ${missingCampaignDbIds.size} missing campaign details (fallback)...`
    );
    const campaignPromises = Array.from(missingCampaignDbIds).map(
      async (dbId) => {
        const details = await fetchMerklCampaignDetails(dbId);
        if (details) {
          const cacheKey = details.id || dbId;
          if (details.id && details.id !== dbId) {
            dbIdToHashId.set(dbId, details.id);
          }
          if (details.parentCampaignId) {
            details.parentCampaignId =
              dbIdToHashId.get(details.parentCampaignId) ||
              details.parentCampaignId;
          }
          campaignDetailsCache.set(cacheKey, details);
        }
        return { dbId, details };
      }
    );
    await Promise.all(campaignPromises);
  }
  logger.info(
    `✅ Campaign details cache ready: ${campaignDetailsCache.size} items`
  );

  // Build forecast meta map early so breakdowns can be enriched with opportunity-only forecast data
  const forecastCampaignMetaLite =
    buildForecastCampaignMetaLiteMap(liveOpportunities);

  // 处理所有 live opportunities（现在可以快速从缓存中获取数据）
  for (const opp of liveOpportunities) {
    if (!opp.explorerAddress) {
      logger.warn(`   ⚠️ No explorerAddress found for opportunity ${opp.id}`);
      continue;
    }

    // ADR-0030 (revised): V4 Spoke opportunities are now indexed alongside Hub.
    // Hub/Spoke deduplication happens at the breakdown level in enrichDatasetWithIncentiveData
    // (index.ts) using parentCampaignId — parent Hub breakdowns are removed when a
    // matching child Spoke exists. Spoke campaignApr = incentiveAPR (Dutch Auction result),
    // which needs no supplyApy-dependent TARGET_TOTAL_APR conversion.

    // Derive protocol version from opportunity (ADR-0018 4-step priority)
    const protocolVersion = deriveProtocolVersion(
      opp.type,
      opp.explorerAddress,
      opp.chainId,
      protocolLookup.unambiguous,
      protocolLookup.v4Underlying
    );
    const marketName =
      opp.chainId === 1
        ? parseMarketNameFromOpportunityName(opp.name, opp.chainId)
        : "Unknown";
    const explorerAddress = opp.explorerAddress.toLowerCase();

    const opportunityId = String(opp.id || "").trim();

    if (!opportunityId) {
      logger.warn(`   ⚠️ No opportunity ID found for opportunity ${opp.id}`);
    }

    const breakdowns: MerklCampaignBreakdown[] = [];
    const rewardsBreakdowns = opp.rewardsRecord?.breakdowns;
    if (!rewardsBreakdowns?.length) {
      continue;
    }

    let firstDistributionType: string | undefined;
    const oppLevelDistributionType =
      typeof opp.distributionType === "string"
        ? opp.distributionType
        : undefined;
    if (
      oppLevelDistributionType &&
      NET_DISTRIBUTION_TYPES.has(oppLevelDistributionType.toUpperCase())
    ) {
      firstDistributionType = oppLevelDistributionType;
    }
    for (const rewardBreakdown of rewardsBreakdowns) {
      const breakdownDbId = String(rewardBreakdown.campaignId || "").trim();
      if (!breakdownDbId) {
        logger.warn(
          `   ⚠️ Skipping breakdown without campaignId on opportunity ${opp.id}`
        );
        continue;
      }

      const resolvedHashId = dbIdToHashId.get(breakdownDbId) || "";
      const cacheKey = resolvedHashId || breakdownDbId;
      const campaignDetails = campaignDetailsCache.get(cacheKey);
      if (!campaignDetails) {
        continue;
      }

      if (!firstDistributionType && rewardBreakdown.distributionType) {
        firstDistributionType = rewardBreakdown.distributionType;
      }

      const useIntensity =
        merklBreakdownUsesPointsIntensityFields(rewardBreakdown);
      const amountVariantPrices = amountVariantPriceMap.get(
        resolvedHashId || breakdownDbId
      );
      const pointsFields = useIntensity
        ? merklPointsFieldsFromBreakdownValue(opp, rewardBreakdown, {
            distributionType: rewardBreakdown.distributionType,
            targetTokenPrice: amountVariantPrices?.targetTokenPrice,
            campaignApr: campaignDetails.apr,
          })
        : undefined;

      breakdowns.push({
        campaignApr: campaignDetails.apr,
        campaignStartedAt: campaignDetails.startedAt,
        campaignEndedAt: campaignDetails.endedAt,
        campaignId: campaignDetails.id || breakdownDbId,
        ...(campaignDetails.databaseId && {
          databaseId: campaignDetails.databaseId,
        }),
        whitelistOnly: campaignDetails.whitelistOnly,
        ...extractRewardTokenFields(rewardBreakdown.token),
        ...(pointsFields ?? {}),
        ...(campaignDetails.parentCampaignId && {
          parentCampaignId: campaignDetails.parentCampaignId,
        }),
        ...(campaignDetails.positionCapNative !== undefined && {
          positionCapNative: campaignDetails.positionCapNative,
        }),
        ...(campaignDetails.isCombineCap !== undefined && {
          isCombineCap: campaignDetails.isCombineCap,
        }),
      });
    }

    const coveredCampaignIds = new Set(breakdowns.map((b) => b.campaignId));
    if (Array.isArray(opp.campaigns)) {
      let embedCount = 0;
      let checkedCount = 0;
      const endedBySymbol = new Map<
        string,
        { endedAt: string; startedAt: string; campaignId: string }
      >();
      for (const campaign of opp.campaigns) {
        const cDbId = String(campaign.id || "").trim();
        const cRawCampaignId = String(campaign.campaignId || "").trim();
        const cHashId =
          cRawCampaignId && cRawCampaignId.startsWith("0x")
            ? cRawCampaignId
            : "";
        const cCacheKey = cHashId || cDbId;
        if (!cRawCampaignId || coveredCampaignIds.has(cCacheKey)) continue;
        const details = campaignDetailsCache.get(cCacheKey);
        checkedCount++;
        if (!details) continue;
        if (!isWithinLookbackWindow(details.endedAt)) continue;
        const rtSymbol =
          typeof campaign.rewardToken?.symbol === "string" &&
          campaign.rewardToken.symbol
            ? campaign.rewardToken.symbol.trim().toLowerCase()
            : "";
        if (!rtSymbol) continue;
        const existing = endedBySymbol.get(rtSymbol);
        if (!existing || details.endedAt > existing.endedAt) {
          endedBySymbol.set(rtSymbol, {
            endedAt: details.endedAt,
            startedAt: details.startedAt,
            campaignId: cCacheKey,
          });
        }
      }
      for (const breakdown of breakdowns) {
        const symbol = breakdown.rewardTokenSymbol?.trim().toLowerCase() || "";
        if (!symbol) continue;
        const ended = endedBySymbol.get(symbol);
        if (!ended) continue;
        breakdown.lastEndedCampaign = {
          startedAt: ended.startedAt,
          endedAt: ended.endedAt,
          campaignId: ended.campaignId,
        };
        embedCount++;
      }
      if (embedCount > 0) {
        logger.debug(
          `   Opp ${opp.id}: ${embedCount} recently-ended embedded into live breakdowns from ${checkedCount} uncovered`
        );
      }
    }

    const intensityCount = breakdowns.filter(
      (b) => b.pointsPerThousandUsd !== undefined
    ).length;
    if (intensityCount > 0) {
      const tvl = Number(opp.tvl) || 0;
      logger.debug(
        `   📊 Opportunity ${opp.id}: ${intensityCount} breakdown(s) with reward-intensity fields, TVL: ${tvl}`
      );
    }

    // Enrich breakdowns with opportunity-only forecast fields
    for (const bd of breakdowns) {
      const meta = forecastCampaignMetaLite[bd.campaignId];
      if (meta) {
        const fields = await buildForecastFieldsFromOpportunity(
          meta,
          mergedOptionsWithLookup
        );
        if (fields) Object.assign(bd, fields);
        if (meta.rawMode && meta.campaignTypeHint === "TARGET_TOTAL_APR") {
          bd.budgetBoundMode = meta.rawMode;
        }
      }
    }

    // 过滤已过期 campaign，每组仅保留最近一条过期
    const filteredBreakdowns = filterRecentExpiredCampaigns(breakdowns);

    // 记录过滤情况
    if (breakdowns.length > filteredBreakdowns.length) {
      const expiredCount = breakdowns.length - filteredBreakdowns.length;
      logger.info(
        `   🗑️ Filtered out ${expiredCount} expired campaign(s) for opportunity ${opp.id}`
      );
    }

    // 如果过滤后没有有效的 campaign，跳过这个 opportunity
    if (filteredBreakdowns.length === 0) {
      logger.info(
        `   ⏭️ Skipping opportunity ${opp.id}: all campaigns expired`
      );
      continue;
    }

    const offsetTokenAddresses = extractOffsetTokenAddresses(opp);
    const isBorrowBl =
      (opp.identifier?.includes("BORROW_BL") ?? false) ||
      hasBorrowExclusionHook(opp);

    const { composedCampaignsCompute, composedSubCampaigns } =
      extractComposedCampaignInfo(opp);

    // Pre-compute V4 reserve ID keys for precise matching in findMatchingMerklOpportunities.
    // Spoke: full 4-component (chainId:spoke:token:hub). Hub: 3-component (chainId:token:hub, no spoke).
    const firstParams = opp.campaigns?.[0]?.params;
    const ut =
      typeof firstParams?.underlyingToken === "string"
        ? firstParams.underlyingToken
        : undefined;
    const sa =
      typeof firstParams?.spokeAddress === "string"
        ? firstParams.spokeAddress
        : undefined;
    const ha =
      typeof firstParams?.hubAddress === "string"
        ? firstParams.hubAddress
        : undefined;
    const campaignReserveId =
      sa && ut && ha ? v4ReserveId(opp.chainId, sa, ut, ha) : undefined;
    const hubScopeKey =
      ut && ha ? v4HubScopeKey(opp.chainId, ut, ha) : undefined;

    // 创建 opportunity 数据对象，根据 action 直接设置对应数组
    const opportunityData: MerklOpportunityData = {
      supply: opp.action === "LEND" ? filteredBreakdowns : [],
      borrow: opp.action === "BORROW" ? filteredBreakdowns : [],
      hold: opp.action === "HOLD" ? filteredBreakdowns : [],
      marketName,
      chainId: opp.chainId,
      protocolVersion,
      ...(opportunityId && { opportunityId }),
      ...(opp.name && { name: opp.name }),
      ...(opp.description && { description: opp.description }),
      ...(opp.type && { opportunityType: opp.type }),
      ...(firstDistributionType && { distributionType: firstDistributionType }),
      ...(offsetTokenAddresses.length > 0 && { offsetTokenAddresses }),
      ...(isBorrowBl && { borrowBlacklist: true }),
      ...(composedCampaignsCompute && { composedCampaignsCompute }),
      ...(composedSubCampaigns &&
        composedSubCampaigns.length > 0 && { composedSubCampaigns }),
      ...(campaignReserveId && { campaignReserveId }),
      ...(hubScopeKey && { hubScopeKey }),
      ...(explorerAddress && { explorerAddress }),
    };

    // 创建索引键：chainId + explorerAddress
    // V4 Spoke opportunities are indexed by explorerAddress (spoke pool), same as before.
    // Precise reserve ID matching is done in findMatchingMerklOpportunities using campaign params.
    const indexKey = `${opp.chainId}-${explorerAddress}`;

    if (!merklData[indexKey]) {
      merklData[indexKey] = [];
    }
    merklData[indexKey]!.push(opportunityData);
  }

  // 从索引中提取所有 opportunities 用于保存
  const processedData = Object.values(merklData).flat();

  logger.info(`✅ Processed ${processedData.length} Merkl opportunities`);
  logger.info(
    `📊 Created index with ${Object.keys(merklData).length} token keys`
  );
  logger.info(
    `📈 Merkl budget price source usage (non-PRETGE): snapshot=${priceSourceStats.snapshot}, reserve=${priceSourceStats.reserve}, coingecko=${priceSourceStats.coingecko}, missing=${priceSourceStats.missing}`
  );

  const freshTimestamp = new Date().toISOString();
  staleStatus = {
    ...staleStatus,
    stale: staleStatus.stale,
    fetchedOpportunities: fetchedOpportunities.length,
    usedOpportunities: liveOpportunities.length,
  };

  await persistMerklArtifacts({
    rawOpportunities: opportunities,
    liveOpportunities,
    processedData,
    index: merklData,
    forecastCampaignMetaLite,
    staleStatus,
  });

  if (!staleStatus.stale && Object.keys(merklData).length > 0) {
    _merklState.lastSuccessfulSnapshot = {
      processedData,
      index: merklData,
      forecastCampaignMetaLite,
      liveOpportunityCount: liveOpportunities.length,
      lastSuccessfulAt: freshTimestamp,
    };
  }

  const campaignAccessArr = Array.from(campaignAccessMap.values());
  if (campaignAccessArr.length > 0) {
    logger.debug(
      `📋 Campaign access: ${campaignAccessArr.length} campaigns with whitelist/blacklist data`
    );
  }

  return { index: merklData, campaignAccess: campaignAccessArr };
}

function extractComposedCampaignInfo(opp: MerklOpportunity): {
  composedCampaignsCompute?: string;
  composedSubCampaigns?: ComposedSubCampaign[];
} {
  if (!Array.isArray(opp.campaigns)) return {};
  for (const campaign of opp.campaigns) {
    const compute = campaign?.params?.composedCampaignsCompute;
    if (typeof compute !== "string" || !compute) continue;
    // Only the first campaign with composedCampaignsCompute is used;
    // in practice each MULTILOG_DUTCH opportunity has at most one.
    const rawSubs = campaign?.params?.composedCampaigns;
    const composedSubCampaigns: ComposedSubCampaign[] = [];
    if (Array.isArray(rawSubs)) {
      for (const sub of rawSubs) {
        const underlyingToken = sub?.campaignParameters?.underlyingToken;
        const rawMultiplier = sub?.composedMultiplier;
        const parsedMultiplier =
          typeof rawMultiplier === "string" && rawMultiplier
            ? Number(rawMultiplier) / 1e9
            : typeof rawMultiplier === "number"
              ? rawMultiplier
              : undefined;
        composedSubCampaigns.push({
          underlyingToken:
            typeof underlyingToken === "string"
              ? underlyingToken.toLowerCase()
              : undefined,
          campaignType:
            typeof sub?.campaignType === "number"
              ? sub.campaignType
              : undefined,
          composedType:
            typeof sub?.composedType === "string"
              ? sub.composedType
              : undefined,
          composedMultiplier:
            parsedMultiplier !== undefined &&
            Number.isFinite(parsedMultiplier) &&
            parsedMultiplier >= 0
              ? parsedMultiplier
              : undefined,
          composedIndex:
            typeof sub?.composedIndex === "number"
              ? sub.composedIndex
              : undefined,
          mainParameter:
            typeof sub?.mainParameter === "string"
              ? sub.mainParameter.toLowerCase()
              : undefined,
          symbolTargetToken:
            typeof sub?.symbolTargetToken === "string"
              ? sub.symbolTargetToken
              : undefined,
        });
      }
    }
    return { composedCampaignsCompute: compute, composedSubCampaigns };
  }
  return {};
}

export function filterRecentExpiredCampaigns(
  breakdowns: MerklCampaignBreakdown[]
): MerklCampaignBreakdown[] {
  const nowMs = Date.now();
  return breakdowns.filter(
    (b) => !b.campaignEndedAt || new Date(b.campaignEndedAt).getTime() >= nowMs
  );
}

/**
 * Merkl HookType constants from official schema (https://api.merkl.xyz/v4/schemas/hookType).
 *
 * hookType=14 (BORROW_BL): Unconditional borrow exclusion —
 *   "Exclude addresses that have borrowed from the specified lending protocol markets from rewards."
 *   Fields: protocol (0-3), borrowBytesLike (market addresses), computeChainId.
 *
 * hookType=17 (HEALTH_FACTOR): Conditional borrow exclusion —
 *   "Blacklist users whose health factor is above a threshold."
 *   Fields: protocol (0=Aave only), healthFactorThreshold (string, e.g. "0.9"),
 *   targetBytesLike (pool address), chainId.
 *   Unlike hookType=14, this does NOT unconditionally exclude all borrowers —
 *   only those whose health factor exceeds the threshold. However, in practice
 *   any user with a borrow position may be affected, so we mark borrowBlacklist=true
 *   and store the threshold details for frontend fine-grained display.
 */
const HOOK_TYPE_BORROW_BL = 14 as const;
const HOOK_TYPE_HEALTH_FACTOR = 17 as const;

const BORROW_EXCLUSION_HOOK_TYPES = new Set([
  HOOK_TYPE_BORROW_BL,
  HOOK_TYPE_HEALTH_FACTOR,
]);

function isBorrowExclusionHookType(hookType: number): boolean {
  return BORROW_EXCLUSION_HOOK_TYPES.has(hookType as 14 | 17);
}

/** @deprecated Use hasBorrowExclusionHook instead. Kept for backward-compatible test imports. */
export function hasHookType14(opp: MerklOpportunity): boolean {
  if (!Array.isArray(opp.campaigns)) return false;
  for (const c of opp.campaigns) {
    const hooks: unknown = c?.params?.hooks;
    if (Array.isArray(hooks)) {
      for (const h of hooks) {
        if (
          typeof h === "object" &&
          h !== null &&
          (h as any).hookType === HOOK_TYPE_BORROW_BL
        )
          return true;
      }
    }
  }
  return false;
}

/**
 * Returns true if any campaign in the opportunity contains a borrow-exclusion hook.
 * - hookType=14 (BORROW_BL): unconditional — any borrower is excluded.
 * - hookType=17 (HEALTH_FACTOR): conditional — borrowers with health factor > threshold are excluded.
 * Both justify marking the opportunity as borrowBlacklist=true, since any borrow position
 * risks exclusion. Detailed conditions are stored in MerklCampaignAccess for fine-grained display.
 */
export function hasBorrowExclusionHook(opp: MerklOpportunity): boolean {
  if (!Array.isArray(opp.campaigns)) return false;
  for (const c of opp.campaigns) {
    const hooks: unknown = c?.params?.hooks;
    if (Array.isArray(hooks)) {
      for (const h of hooks) {
        if (
          typeof h === "object" &&
          h !== null &&
          isBorrowExclusionHookType((h as any).hookType)
        )
          return true;
      }
    }
  }
  return false;
}

export function extractBorrowHookProtocols(
  hooks: unknown
): MerklBorrowHookProtocol[] {
  if (!Array.isArray(hooks)) return [];
  const protocols: MerklBorrowHookProtocol[] = [];
  for (const h of hooks) {
    if (
      typeof h === "object" &&
      h !== null &&
      (h as any).hookType === HOOK_TYPE_BORROW_BL
    ) {
      const hook = h as { protocol?: number; borrowBytesLike?: unknown };
      const borrowBytesLike: string[] = [];
      if (Array.isArray(hook.borrowBytesLike)) {
        for (const b of hook.borrowBytesLike) {
          if (typeof b === "string" && b.trim()) {
            borrowBytesLike.push(b);
          }
        }
      }
      if (borrowBytesLike.length > 0) {
        protocols.push({
          protocol: hook.protocol ?? -1,
          borrowBytesLike,
        });
      }
    }
  }
  return protocols;
}

export function extractHealthFactorHooks(
  hooks: unknown
): MerklHealthFactorHook[] {
  if (!Array.isArray(hooks)) return [];
  const result: MerklHealthFactorHook[] = [];
  for (const h of hooks) {
    if (
      typeof h === "object" &&
      h !== null &&
      (h as any).hookType === HOOK_TYPE_HEALTH_FACTOR
    ) {
      const hook = h as {
        protocol?: number;
        healthFactorThreshold?: unknown;
        targetBytesLike?: unknown;
        chainId?: unknown;
      };
      const threshold =
        typeof hook.healthFactorThreshold === "string" &&
        hook.healthFactorThreshold.trim()
          ? hook.healthFactorThreshold.trim()
          : undefined;
      const target =
        typeof hook.targetBytesLike === "string" && hook.targetBytesLike.trim()
          ? hook.targetBytesLike.trim()
          : undefined;
      const cid = typeof hook.chainId === "number" ? hook.chainId : undefined;
      if (threshold && target && cid) {
        result.push({
          protocol: hook.protocol ?? 0,
          healthFactorThreshold: threshold,
          targetBytesLike: target,
          chainId: cid,
        });
      }
    }
  }
  return result;
}

/**
 * Returns true if any campaign has a borrow-exclusion hook (hookType=14 or 17).
 *
 * Previously required `params.blacklist` co-occurrence as a confirmation signal.
 * After cross-referencing the official Merkl schema, hookType=14 (BORROW_BL) itself
 * is sufficient: "Exclude addresses that have borrowed from the specified lending
 * protocol markets from rewards." The `params.blacklist` field (populated by
 * hookType=4 SANCTIONED, hookType=27 BLACKLIST_KEY_VALUE_STORE, etc.) is an
 * independent mechanism — its presence is not required to confirm borrow exclusion.
 */
export function hasBlacklistWithBorrowHook(opp: MerklOpportunity): boolean {
  return hasBorrowExclusionHook(opp);
}

function extractOffsetTokenAddresses(opp: MerklOpportunity): string[] {
  if (!Array.isArray(opp.campaigns)) return [];
  const seen = new Set<string>();
  const results: string[] = [];
  for (const campaign of opp.campaigns) {
    const tokens: unknown = campaign?.params?.tokens;
    if (Array.isArray(tokens)) {
      for (const t of tokens) {
        const addr =
          typeof t === "string"
            ? t.toLowerCase()
            : typeof t === "object" &&
                t !== null &&
                typeof (t as any).underlyingToken === "string"
              ? (t as any).underlyingToken.toLowerCase()
              : null;
        if (addr && !seen.has(addr)) {
          seen.add(addr);
          results.push(addr);
        }
      }
    }
  }
  return results;
}

const SUPPLY_PATTERN = /\b(supply|lend|deposit|stake)\b/i;
const BORROW_PATTERN = /\b(borrow|loan|debt|repay)\b/i;
const NET_SUPPLY_PATTERN = /\bnet\s*(supply|lend|deposit|long)\b/i;
const NET_BORROW_PATTERN = /\bnet\s*(borrow|loan|debt|short)\b/i;
const BOTH_SIDES_PATTERN =
  /(?:supply|lend|deposit|stake).*(?:borrow|loan|debt|repay)|(?:borrow|loan|debt|repay).*(?:supply|lend|deposit|stake)/i;

export function regexNetPositionFallback(
  opp: MerklOpportunityData,
  oppReserveId?: string
): NetPositionConstraint | null {
  const text = `${opp.name ?? ""} ${opp.description ?? ""}`;
  const inferredBorrow = opp.borrow.length > 0;
  const inferredSupply = opp.supply.length > 0;

  if (
    NET_BORROW_PATTERN.test(text) ||
    (inferredBorrow && BOTH_SIDES_PATTERN.test(text))
  ) {
    return {
      sourceSide: "borrow",
      offsetReserveIds: oppReserveId ? [oppReserveId] : [],
    };
  }
  if (
    NET_SUPPLY_PATTERN.test(text) ||
    (inferredSupply && BOTH_SIDES_PATTERN.test(text))
  ) {
    return {
      sourceSide: "supply",
      offsetReserveIds: oppReserveId ? [oppReserveId] : [],
    };
  }

  return null;
}

export function composedNetPositionConstraint(
  opp: MerklOpportunityData,
  oppReserveId: string,
  reserveIdSet: Set<string>,
  offsetLevel: OffsetLevel = "reserve"
): NetPositionConstraint | null {
  if (opp.composedCampaignsCompute !== "1-2") return null;

  // Side inferred from action via breakdown arrays:
  // action=LEND → supply[], action=BORROW → borrow[], consistent with L0.
  const sourceSide: "supply" | "borrow" =
    opp.borrow.length > 0 ? "borrow" : "supply";

  const offsetReserveIds: string[] = [];
  const seen = new Set<string>();

  if (opp.composedSubCampaigns) {
    for (const sub of opp.composedSubCampaigns) {
      if (sub.underlyingToken) {
        const resolvedIds = resolveOffsetReserveIds(
          oppReserveId,
          sub.underlyingToken,
          reserveIdSet,
          offsetLevel
        );
        for (const rid of resolvedIds) {
          if (!seen.has(rid)) {
            seen.add(rid);
            offsetReserveIds.push(rid);
          }
        }
      }
    }
  }

  if (!seen.has(oppReserveId)) {
    offsetReserveIds.unshift(oppReserveId);
    seen.add(oppReserveId);
  }

  if (offsetReserveIds.length === 0) return null;

  return { sourceSide, offsetReserveIds };
}

/**
 * Detects cross-asset pairing constraint for Merkl min(1,2) opportunities.
 *
 * Unlike netPositionConstraint (subtraction: source - Σoffset),
 * cross-asset pairing uses min(): min(sourcePos, pairedPos × discountFactor).
 *
 * This is an independent constraint type — not a net position constraint.
 * min(1,2) and looping are parallel conditions that can coexist.
 *
 * Source sub identification: the sub whose mainParameter matches the opportunity's
 * explorerAddress is the source sub (multiplier always 1.0). The other sub is the
 * paired sub.
 *
 * Paired side direction: determined by campaignType — 60 (MAIN/supply aToken) → supply,
 * 61 (DEFAULT/borrow vToken) → borrow. Falls back to composedType if campaignType missing.
 */
export function detectCrossAssetPairing(
  opp: MerklOpportunityData,
  oppReserveId: string,
  reserveIdSet: Set<string>,
  offsetLevel: OffsetLevel = "reserve"
): CrossAssetPairing | null {
  if (opp.composedCampaignsCompute !== "min(1,2)") return null;
  if (!opp.composedSubCampaigns || opp.composedSubCampaigns.length < 2)
    return null;

  const explorerAddr = opp.explorerAddress?.toLowerCase();
  if (!explorerAddr) return null;

  let sourceSub: ComposedSubCampaign | undefined;
  let pairedSub: ComposedSubCampaign | undefined;

  for (const sub of opp.composedSubCampaigns) {
    if (sub.mainParameter?.toLowerCase() === explorerAddr) {
      sourceSub = sub;
    } else {
      pairedSub = sub;
    }
  }

  if (!sourceSub || !pairedSub) return null;

  if (
    !pairedSub.underlyingToken ||
    !sourceSub.underlyingToken ||
    pairedSub.underlyingToken === sourceSub.underlyingToken
  ) {
    return null;
  }

  if (
    pairedSub.composedMultiplier === undefined ||
    !Number.isFinite(pairedSub.composedMultiplier) ||
    pairedSub.composedMultiplier < 0
  ) {
    logger.warn(`⚠️ detectCrossAssetPairing: invalid composedMultiplier`, {
      oppId: opp.opportunityId,
      oppName: opp.name,
      pairedToken: pairedSub.underlyingToken,
    });
    return null;
  }

  const resolvedIds = resolveOffsetReserveIds(
    oppReserveId,
    pairedSub.underlyingToken,
    reserveIdSet,
    offsetLevel
  );

  if (resolvedIds.length === 0) {
    logger.warn(
      `⚠️ detectCrossAssetPairing: pairedReserveId not found in reserveIdSet`,
      {
        oppId: opp.opportunityId,
        oppName: opp.name,
        pairedToken: pairedSub.underlyingToken,
        oppReserveId,
      }
    );
    return null;
  }

  const sourceSide: "supply" | "borrow" =
    opp.borrow.length > 0 ? "borrow" : "supply";

  const pairedSide: "supply" | "borrow" = pairedSub.symbolTargetToken
    ?.toLowerCase()
    .includes("debt")
    ? "borrow"
    : "supply";

  return {
    sourceSide,
    pairedReserveId: resolvedIds[0],
    pairedSide,
    discountFactor: pairedSub.composedMultiplier,
  };
}

export async function detectNetPositionConstraint(
  opp: MerklOpportunityData,
  sourceTokenAddress: string,
  oppReserveId: string,
  reserveIdSet: Set<string>,
  symbolLookup: Map<string, string>,
  cachedConstraint?: NetPositionConstraint | null,
  llmFn?: () => Promise<import("./merklLlmClient.js").LlmOutcome>,
  offsetLevel: OffsetLevel = "reserve",
  offsetTokenAddresses?: string[],
  symbolLookupCI?: Map<string, string[]>,
  equivLookup?: Map<string, Set<string>>
): Promise<NetPositionConstraint | null> {
  const resolvedOffsetAddrs = offsetTokenAddresses ?? opp.offsetTokenAddresses;
  const layer0 = extractNetPositionConstraint(
    opp,
    sourceTokenAddress,
    oppReserveId,
    reserveIdSet,
    offsetLevel,
    resolvedOffsetAddrs
  );
  if (layer0) return layer0;

  const layer05 = composedNetPositionConstraint(
    opp,
    oppReserveId,
    reserveIdSet,
    offsetLevel
  );
  if (layer05) return layer05;

  const text = `${opp.name ?? ""} ${opp.description ?? ""}`.toLowerCase();
  if (text.includes("looping")) return null;

  if (cachedConstraint !== undefined) return cachedConstraint;

  let llmUnavailable = false;
  if (llmFn) {
    const outcome = await llmFn();
    if (outcome.tag === "result" && outcome.value) {
      const { sourceSide, offsetTokenSymbols } = outcome.value;
      if (offsetTokenSymbols && offsetTokenSymbols.length > 0) {
        const offsetReserveIds: string[] = [];
        const seen = new Set<string>();
        const ciMap = symbolLookupCI ?? new Map<string, string[]>();
        const equivMap = equivLookup ?? new Map<string, Set<string>>();
        for (const symbol of offsetTokenSymbols) {
          const tokenAddrs = resolveOffsetSymbolAddress(
            opp.chainId,
            symbol,
            symbolLookup,
            ciMap,
            equivMap
          );
          if (tokenAddrs.length === 0) {
            logger.warn(`⚠️ LLM offset symbol unresolvable`, {
              symbol,
              chainId: opp.chainId,
              oppId: opp.opportunityId,
              oppName: opp.name,
            });
            continue;
          }
          for (const addr of tokenAddrs) {
            const resolvedIds = resolveOffsetReserveIds(
              oppReserveId,
              addr.toLowerCase(),
              reserveIdSet,
              offsetLevel
            );
            for (const rid of resolvedIds) {
              if (!seen.has(rid)) {
                seen.add(rid);
                offsetReserveIds.push(rid);
              }
            }
          }
        }
        // Explicit self-add (align with L0 behavior — see ADR-0036)
        if (!seen.has(oppReserveId)) {
          offsetReserveIds.unshift(oppReserveId);
          seen.add(oppReserveId);
        }
        if (offsetReserveIds.length > 0)
          return { sourceSide, offsetReserveIds };
      }
    }
    llmUnavailable = outcome.tag === "unavailable";
  }

  if (llmUnavailable) {
    const regexResult = regexNetPositionFallback(opp, oppReserveId);
    if (regexResult) return regexResult;
  }

  return null;
}

const NET_DISTRIBUTION_TYPES = new Set(["AAVE_V4_NET_APR", "AAVE_NET_APR"]);

export function extractNetPositionConstraint(
  opp: MerklOpportunityData,
  sourceTokenAddress: string,
  oppReserveId: string,
  reserveIdSet: Set<string>,
  offsetLevel: OffsetLevel = "reserve",
  offsetTokenAddresses?: string[]
): NetPositionConstraint | null {
  const type = opp.opportunityType;
  const isNetType = type && type.startsWith("AAVE_NET_");
  const isNetDistribution =
    !isNetType &&
    opp.distributionType &&
    NET_DISTRIBUTION_TYPES.has(opp.distributionType.toUpperCase());

  if (!isNetType && !isNetDistribution) return null;

  let sourceSide: "supply" | "borrow";
  if (isNetType) {
    sourceSide = type === "AAVE_NET_BORROWING" ? "borrow" : "supply";
  } else {
    sourceSide = opp.borrow.length > 0 ? "borrow" : "supply";
  }

  const offsetReserveIds: string[] = [];
  const seen = new Set<string>();

  const debugMissing: string[] = [];

  for (const addr of offsetTokenAddresses ?? []) {
    const normalizedAddr = addr.toLowerCase();
    const resolvedIds = resolveOffsetReserveIds(
      oppReserveId,
      normalizedAddr,
      reserveIdSet,
      offsetLevel
    );
    for (const rid of resolvedIds) {
      if (!seen.has(rid)) {
        seen.add(rid);
        offsetReserveIds.push(rid);
      }
    }
    if (resolvedIds.length === 0) {
      debugMissing.push(normalizedAddr);
    }
  }

  if (!seen.has(oppReserveId)) {
    offsetReserveIds.unshift(oppReserveId);
    seen.add(oppReserveId);
  }

  if (offsetReserveIds.length === 0) {
    logger.warn(
      `⚠️ extractNetPositionConstraint: no offsetReserveIds for opp "${opp.name}" type=${type} dt=${opp.distributionType} chain=${opp.chainId} offsetAddrs=${JSON.stringify(offsetTokenAddresses)} missingAddrs=${JSON.stringify(debugMissing)} reserveIdSetSize=${reserveIdSet.size}`
    );
    return null;
  }

  return { sourceSide, offsetReserveIds };
}

/**
 * 根据 token 地址查找匹配的 Merkl opportunities。
 * 地址类型驱动匹配：V3 reserve 只查 aToken/vToken，V4 reserve 只查 underlying/spokeAddress。
 * 匹配本身天然隔离 V3/V4，无需后置版本过滤。
 */
export function findMatchingMerklOpportunities(
  item: {
    chainId: number;
    marketName: string;
    tokenAddress: string;
    aTokenAddress?: string | null;
    vTokenAddress?: string | null;
    spokeAddress?: string | null;
    hubAddress?: string | null;
    reserveId?: string;
  },
  merklData: Record<string, MerklOpportunityData[]>
): MerklOpportunityData[] {
  const matchedOpportunities: MerklOpportunityData[] = [];
  const seenOpportunities = new Set<MerklOpportunityData>();
  const isV4 = item.marketName.startsWith("AaveV4");

  const tokenAddressesToCheck: string[] = isV4
    ? [item.tokenAddress, item.spokeAddress].filter(
        (addr): addr is string => addr !== null && addr !== undefined
      )
    : [item.aTokenAddress, item.vTokenAddress].filter(
        (addr): addr is string => addr !== null && addr !== undefined
      );

  for (const tokenAddr of tokenAddressesToCheck) {
    const indexKey = `${item.chainId}-${tokenAddr.toLowerCase()}`;

    const matchingOpportunities = merklData[indexKey];
    if (matchingOpportunities?.length > 0) {
      for (const opp of matchingOpportunities) {
        if (seenOpportunities.has(opp)) continue;

        // V4 reserve ID matching: Spoke opps pre-computed campaignReserveId (full 4-component)
        // compared against the reserve's reserveId. Hub opps pre-computed hubScopeKey
        // (3-component: chainId:token:hub) compared against the reserve's hubScopeKey.
        // Falls through (kept) when no campaign params available.
        if (isV4 && item.reserveId) {
          if (opp.campaignReserveId) {
            if (opp.campaignReserveId !== item.reserveId) continue;
          } else if (opp.hubScopeKey) {
            if (
              opp.hubScopeKey !==
              v4HubScopeKey(
                item.chainId,
                item.tokenAddress,
                item.hubAddress ?? ""
              )
            )
              continue;
          }
        }

        seenOpportunities.add(opp);
        matchedOpportunities.push(opp);
      }
    }
  }

  return matchedOpportunities;
}

/**
 * V4 Hub/Spoke breakdown-level dedup (ADR-0030 revised).
 *
 * When a V4 Spoke campaign's parentCampaignId matches a V4 Hub campaign's campaignId
 * within the same reserve's matched opportunity groups, the parent Hub breakdown is
 * removed and the Spoke breakdown is kept. Spoke campaignApr = incentiveAPR (Dutch
 * Auction result) and needs no supplyApy-dependent TARGET_TOTAL_APR conversion.
 *
 * Independent Hub campaigns (non-parent) are preserved. Non-V4 groups pass through untouched.
 */
export function deduplicateHubSpokeBreakdowns(
  groups: MerklOpportunityGroup[]
): MerklOpportunityGroup[] {
  // 1. Collect parentCampaignIds from V4 Spoke groups
  const replacedHubIds = new Set<string>();
  for (const group of groups) {
    if (!isV4SpokeOpportunity(group.opportunityType)) continue;
    for (const bd of group.breakdowns) {
      if (bd.parentCampaignId) {
        replacedHubIds.add(bd.parentCampaignId);
      }
    }
  }
  if (replacedHubIds.size === 0) return groups;

  // 2. Remove Hub breakdowns whose campaignId is a parent of a matched Spoke
  const result: MerklOpportunityGroup[] = [];
  let removedCount = 0;
  for (const group of groups) {
    if (!group.opportunityType?.startsWith("AAVE_V4_HUB_")) {
      result.push(group);
      continue;
    }
    const filtered = group.breakdowns.filter((bd) => {
      if (
        replacedHubIds.has(bd.campaignId) ||
        (bd.databaseId && replacedHubIds.has(bd.databaseId))
      ) {
        removedCount++;
        return false;
      }
      return true;
    });
    if (filtered.length > 0) {
      result.push({ ...group, breakdowns: filtered });
    }
  }
  if (removedCount > 0) {
    logger.info(
      `   🔄 Hub/Spoke dedup: removed ${removedCount} parent Hub breakdown(s) replaced by Spoke`
    );
  }
  return result;
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
export function formatMerklBreakdown(
  breakdowns: Array<MerklCampaignBreakdown & { opportunityId?: string }>
): string {
  if (breakdowns.length === 0) {
    return "";
  }

  const groupedByOppId = new Map<
    string,
    Array<MerklCampaignBreakdown & { opportunityId?: string }>
  >();
  const noOppIdBreakdowns: Array<
    MerklCampaignBreakdown & { opportunityId?: string }
  > = [];

  for (const b of breakdowns) {
    if (b.opportunityId) {
      if (!groupedByOppId.has(b.opportunityId)) {
        groupedByOppId.set(b.opportunityId, []);
      }
      groupedByOppId.get(b.opportunityId)!.push(b);
    } else {
      noOppIdBreakdowns.push(b);
    }
  }

  // 格式化每个分组的 breakdowns
  const formatBreakdown = (b: MerklCampaignBreakdown): string => {
    let startDate = "N/A";
    if (b.campaignStartedAt) {
      const date = new Date(b.campaignStartedAt);
      startDate = date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    }
    let endDate = "N/A";
    if (b.campaignEndedAt) {
      const date = new Date(b.campaignEndedAt);
      endDate = date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    }
    return `${b.campaignApr * 100}% (${startDate} - ${endDate}, ${b.campaignId})`;
  };

  // 构建分组后的字符串
  const parts: string[] = [];

  // 处理有 oppId 的分组：每个分组的 breakdowns 后跟其 oppId
  for (const [oppId, groupBreakdowns] of groupedByOppId.entries()) {
    const breakdownsStr = groupBreakdowns.map(formatBreakdown).join("; ");
    parts.push(`${breakdownsStr}, oppId:${oppId}`);
  }

  // 处理没有 oppId 的 breakdowns
  if (noOppIdBreakdowns.length > 0) {
    parts.push(noOppIdBreakdowns.map(formatBreakdown).join("; "));
  }

  return parts.join("; ");
}
