import type {
  BaseCampaignBreakdown,
  CampaignGroup,
} from "@internal/aave-shared-config";

export {
  normalizeAddress,
  spokeKey,
  v4SpokeCacheKey,
  v3PriceKey,
  v4PriceKey,
  v3OnchainKey,
  v4OnchainKey,
  chainTokenKey,
  chainSymbolKey,
  topologySortKey,
  v4ReserveId,
  v4HubScopeKey,
  aaveProReserveIdBase64,
} from "./keys.js";

export {
  rayToRatio,
  rayToPercent,
  ratioToPercent,
  percentToRatio,
  FIELD_UNITS,
  SERIALIZER_RULES,
  RATIO_FIELDS,
  PERCENT_FIELDS,
} from "./units.js";
export type { FieldUnit } from "./units.js";

export { normalizeCampaignType } from "./campaign-type.js";
export type { NormalizeCampaignTypeInput } from "./campaign-type.js";

export function fifoEvict<K>(map: Map<K, unknown>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const { value: oldestKey, done } = map.keys().next();
    if (done) break;
    map.delete(oldestKey);
  }
}

// ============================================================
// Utility functions (shared across packages)
// ============================================================

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    if ("code" in error) {
      const code = (error as { code: unknown }).code;
      if (typeof code === "string") return code;
    }
    if ("cause" in error) {
      const cause = (error as { cause: unknown }).cause;
      if (typeof cause === "object" && cause !== null && "code" in cause) {
        const code = (cause as { code: unknown }).code;
        if (typeof code === "string") return code;
      }
    }
  }
  return undefined;
}

// ============================================================
// Lookback window for ended campaigns
// ============================================================

export const ENDED_CAMPAIGN_LOOKBACK_DAYS = 90;

export function isWithinLookbackWindow(
  campaignEndedAt: string | undefined,
  nowMs: number = Date.now(),
  lookbackDays: number = ENDED_CAMPAIGN_LOOKBACK_DAYS
): boolean {
  if (!campaignEndedAt) return false;
  const endMs = new Date(campaignEndedAt).getTime();
  if (!Number.isFinite(endMs) || endMs <= 0) return false;
  const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
  return endMs >= nowMs - lookbackMs && endMs < nowMs;
}

// ============================================================
// Incentive types
// ============================================================

export interface MeritCampaignBreakdown extends BaseCampaignBreakdown {
  campaignId: string;
  campaignType?: ForecastCampaignTypeLite;
  message?: string;
  aprCap?: number;
  rewardTokenSymbol?: string;
  totalBudget?: number;
  latestTvl?: number;
}

export type MeritCampaignGroup = CampaignGroup<MeritCampaignBreakdown>;

export type ForecastCampaignTypeLite =
  | "MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE"
  | "DUTCH_AUCTION"
  | "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE"
  | "TARGET_TOTAL_APR"
  | "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE"
  | "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT"
  | "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT";

export interface MerklCampaignBreakdown extends BaseCampaignBreakdown {
  /** Merkl Campaign Hash ID (hex, e.g. 0x0cf07a3891...). Used as Map key and in Merkl web UI URLs. */
  campaignId: string;
  /** Merkl Campaign Database ID (numeric). Used as input to /v4/campaigns/{databaseId} API endpoints (metrics, details). */
  databaseId?: string;
  whitelistOnly?: boolean;
  pointsPerThousandUsd?: number;
  rewardTokenSymbol?: string;
  rewardTokenIconUrl?: string;
  rewardTokenId?: string;
  campaignType?: ForecastCampaignTypeLite;
  totalBudget?: number;
  aprCap?: number | null;
  latestTvl?: number;
  plannedDaily?: number;
  budgetBoundMode?: string;
  /** V4 Spoke campaign's parent Hub campaign ID (for Hub/Spoke deduplication; stripped from API payload). */
  parentCampaignId?: string;
  /** Most recently ended campaign embedded into this live breakdown (matched by rewardTokenSymbol). */
  lastEndedCampaign?: {
    startedAt: string;
    endedAt: string;
    campaignId: string;
  };
}

export interface MerklOpportunityGroup extends CampaignGroup<MerklCampaignBreakdown> {
  opportunityId?: string;
  opportunityType?: string;
}

export interface BrevisCampaignBreakdown extends BaseCampaignBreakdown {
  campaignId: string;
  campaignType?: ForecastCampaignTypeLite;
  aprCap?: number;
  totalBudget?: number;
  latestTvl?: number;
  rewardTokenSymbol?: string;
}

export interface BrevisCampaignItem extends CampaignGroup<BrevisCampaignBreakdown> {}

export interface MerklBorrowHookProtocol {
  protocol: number;
  borrowBytesLike: string[];
}

/** Health factor exclusion hook (hookType=17) extracted from Merkl campaign params. */
export interface MerklHealthFactorHook {
  /** Protocol identifier. Currently only 0 (Aave) per Merkl schema. */
  protocol: number;
  /** Health factor threshold (string, e.g. "0.9" means 90%). Users above this are excluded. */
  healthFactorThreshold: string;
  /** Pool address (targetBytesLike) that this health factor check applies to. */
  targetBytesLike: string;
  /** Chain ID where the pool resides. */
  chainId: number;
}

export interface MerklCampaignAccess {
  /** Merkl Campaign Hash ID. */
  campaignId: string;
  chainId: number;
  whitelist: string[];
  blacklist: string[];
  borrowHookProtocols?: MerklBorrowHookProtocol[];
  /** Health factor exclusion hooks (hookType=17). Users with health factor above threshold are excluded. */
  healthFactorHooks?: MerklHealthFactorHook[];
}

// ============================================================
// Core data types
// ============================================================

export interface RuntimeReserveData {
  reserveId: string;
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  tokenPrice?: number;
  utilizationPct?: number;
  aTokenAddress?: string | null;
  vTokenAddress?: string | null;
  supplyApy?: number;
  supplyDisabled?: boolean;
  isFrozen?: boolean;
  isPaused?: boolean;
  isActive?: false;
  borrowApy?: number;
  borrowDisabled?: boolean;
  decimals?: number;
  supplyCap?: string;
  borrowCap?: string;
  deficit?: string;
  supplied?: string;
  borrowed?: string;
  hubBorrowed?: string;
  hubSupplied?: string;
  liquidity?: string;
  protocolFee?: number;
  slopeBelowOptimal?: number;
  slopeAboveOptimal?: number;
  optimalUtilization?: number;
  baseBorrowRate?: number;
  aaveProReserveId?: string;
  meritSupplys?: MeritCampaignGroup[];
  meritBorrows?: MeritCampaignGroup[];
  merklSupplys?: MerklOpportunityGroup[];
  merklBorrows?: MerklOpportunityGroup[];
  merklHolds?: MerklOpportunityGroup[];
  brevisSupplys?: BrevisCampaignItem[];
  brevisBorrows?: BrevisCampaignItem[];
  hubId?: string;
  hubName?: string;
  hubAddress?: string;
  spokeId?: string;
  spokeName?: string;
  spokeAddress?: string;
  collateralRisk?: number;
  /** Collateral LTV (percent: 80 = 80%). V3: supplyInfo.maxLTV, V4: settings.collateralFactor. */
  ltv?: number;
  /** Liquidation threshold (percent: 82.5 = 82.5%). V3: supplyInfo.liquidationThreshold, V4: = ltv (collateralFactor). */
  liquidationThreshold?: number;
}

// ============================================================
// API layer types (derived from runtime types)
// ============================================================

export type ApiMeritCampaignBreakdown = Pick<
  MeritCampaignBreakdown,
  | "campaignApr"
  | "campaignStartedAt"
  | "campaignEndedAt"
  | "campaignId"
  | "campaignType"
  | "positionCapNative"
  | "positionCapUsd"
  | "isCombineCap"
  | "message"
  | "aprCap"
  | "rewardTokenSymbol"
  | "totalBudget"
  | "latestTvl"
>;

export type ApiMeritCampaignGroup = CampaignGroup<ApiMeritCampaignBreakdown>;

export type ApiMerklBreakdown = MerklCampaignBreakdown;

export type ApiMerklOpportunityGroup = CampaignGroup<ApiMerklBreakdown> & {
  opportunityId?: string;
};

export type ApiBrevisBreakdown = Pick<
  BrevisCampaignBreakdown,
  | "campaignApr"
  | "campaignStartedAt"
  | "campaignEndedAt"
  | "campaignId"
  | "campaignType"
  | "aprCap"
  | "totalBudget"
  | "latestTvl"
  | "positionCapNative"
  | "positionCapUsd"
  | "isCombineCap"
  | "rewardTokenSymbol"
>;

export type ApiBrevisCampaignItem = CampaignGroup<ApiBrevisBreakdown>;

export type FetchSource = "sdk" | "rpc" | "stale" | "none";

export interface SideFetchResult {
  success: boolean;
  source: FetchSource;
}

export interface MarketsFetchResult {
  v3: SideFetchResult;
  v4: SideFetchResult;
}

export interface MarketsPayload {
  _metadata: {
    timestamp: string;
    version: string;
    dataCount: number;
    profile: string;
    /** Per-side fetch result envelope used by backend stale fallback and source tracking. */
    fetchResult?: MarketsFetchResult;
  };
  data: RuntimeReserveData[];
  campaignAccess?: MerklCampaignAccess[];
  spokeHubTopology?: SpokeHubTopology;
  /** Brevis distributedSoFarUsd per campaignId, populated by fetcher, consumed by backend side-data. */
  brevisDistributedSoFar?: Map<string, number | undefined>;
}

// ============================================================
// Net position constraint (shared across fetcher + backend)
// ============================================================

/** Describes a net-position constraint detected for a Merkl opportunity. */
export interface NetPositionConstraint {
  sourceSide: "supply" | "borrow";
  offsetReserveIds: string[];
}

/**
 * Describes a cross-asset pairing constraint for Merkl min(1,2) opportunities.
 *
 * Unlike NetPositionConstraint (which uses subtraction: source - Σoffset),
 * cross-asset pairing uses min(): min(sourcePos, pairedPos × discountFactor).
 *
 * This is an independent constraint type — not a net position constraint.
 * min(1,2) and looping are parallel conditions that can coexist.
 */
export interface CrossAssetPairing {
  /** Source side direction (matches opportunity action: LEND→supply, BORROW→borrow). */
  sourceSide: "supply" | "borrow";
  /** Reserve ID of the paired token (resolved within same pool/spoke). */
  pairedReserveId: string;
  /** Paired side direction (determined by targetToken type: aToken→supply, vToken→borrow). */
  pairedSide: "supply" | "borrow";
  /** Paired-side multiplier from composedMultiplier / 1e9 (e.g. 0.823 for cbETH, 1.196 for sUSDe). */
  discountFactor: number;
}

// ============================================================
// Runtime validation
// ============================================================

export const EXPECTED_RUNTIME_FIELDS = [
  "reserveId",
  "marketName",
  "chainName",
  "chainId",
  "tokenName",
  "tokenSymbol",
  "tokenAddress",
  "tokenPrice",
  "utilizationPct",
  "aTokenAddress",
  "vTokenAddress",
  "supplyApy",
  "supplyDisabled",
  "isFrozen",
  "isPaused",
  "isActive",
  "borrowApy",
  "borrowDisabled",
  "decimals",
  "supplyCap",
  "borrowCap",
  "deficit",
  "supplied",
  "borrowed",
  "hubBorrowed",
  "hubSupplied",
  "liquidity",
  "protocolFee",
  "slopeBelowOptimal",
  "slopeAboveOptimal",
  "optimalUtilization",
  "baseBorrowRate",
  "aaveProReserveId",
  "meritSupplys",
  "meritBorrows",
  "merklSupplys",
  "merklBorrows",
  "merklHolds",
  "brevisSupplys",
  "brevisBorrows",
  "hubId",
  "hubName",
  "hubAddress",
  "spokeId",
  "spokeName",
  "spokeAddress",
  "collateralRisk",
  "ltv",
  "liquidationThreshold",
] as const;

export function validateRuntimeReserveShape(
  data: Record<string, unknown>
): string[] {
  const missing: string[] = [];
  for (const field of EXPECTED_RUNTIME_FIELDS) {
    if (!(field in data)) {
      missing.push(field);
    }
  }
  return missing;
}

type ExpectedField = (typeof EXPECTED_RUNTIME_FIELDS)[number];
type RuntimeKeys = keyof RuntimeReserveData;

type _AllFieldsCovered = Exclude<RuntimeKeys, ExpectedField>;
type _NoExtraFields = Exclude<ExpectedField, RuntimeKeys>;

const __allFieldsCovered: _AllFieldsCovered = null as never;
const __noExtraFields: _NoExtraFields = null as never;

/** One spoke→hub connection extracted from SDK `spoke.connectedHubs`. */
export interface SpokeHubTopologyEntry {
  chainId: number;
  spokeAddress: string;
  hubAddress: string;
}

/** Full spoke-hub topology snapshot, used to drive addressBookRegistry and RPC fallback. */
export type SpokeHubTopology = SpokeHubTopologyEntry[];

// ============================================================
// Side Data (GET /api/meta/side-data response)
// ============================================================

/** Sub-sources of the side-data endpoint, used for structured error reporting. */
export type SideDataSubSource =
  | "categories"
  | "fdv"
  | "forecast"
  | "campaignAccess";

/** Structured per-sub-source errors, replacing the removed `partial: boolean` field. */
export type SideDataSubSourceErrors = Partial<
  Record<SideDataSubSource, string>
>;

/** GET /api/meta/side-data response payload. */
export interface SideDataPayload {
  generatedAt: string;
  categories?: {
    uniqueSymbolsStablecoins: string[];
    uniqueSymbolsEth: string[];
    fetchedAt: string;
    staleTimeMs: number;
  };
  fdv?: {
    items: Array<{ symbol: string | null; fdvUsd: number | null }>;
    fetchedAt: string;
    staleTimeMs: number;
  };
  forecast?: {
    items: Array<{
      campaignId: string;
      requiredDaily?: number;
      distributedSoFar: number;
      endTimestamp: number;
    }>;
    errors: Array<{ campaignId: string; message: string }>;
    staleTimeMs: number;
  };
  campaignAccess?: {
    campaigns: Record<
      string,
      {
        chainId: number;
        whitelist: string[];
        blacklist: string[];
        borrowHookProtocols?: MerklBorrowHookProtocol[];
      }
    >;
    updatedAt: string;
  };
  errors?: SideDataSubSourceErrors;
}
