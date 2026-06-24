import type { BaseCampaignBreakdown, CampaignGroup } from '@internal/aave-shared-config';

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
  aaveProReserveId,
} from './keys.js';

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
  if (typeof error === 'object' && error !== null) {
    if ('code' in error) {
      const code = (error as { code: unknown }).code;
      if (typeof code === 'string') return code;
    }
    if ('cause' in error) {
      const cause = (error as { cause: unknown }).cause;
      if (typeof cause === 'object' && cause !== null && 'code' in cause) {
        const code = (cause as { code: unknown }).code;
        if (typeof code === 'string') return code;
      }
    }
  }
  return undefined;
}

// ============================================================
// Incentive types
// ============================================================

export interface MeritCampaignBreakdown extends BaseCampaignBreakdown {
  campaignId: string;
  campaignType?: ForecastCampaignTypeLite;
  positionCap?: number;
  message?: string;
  aprCap?: number;
  rewardTokenSymbol?: string;
  totalBudget?: number;
  latestTvl?: number;
}

export type MeritCampaignGroup = CampaignGroup<MeritCampaignBreakdown>;

export type ForecastCampaignTypeLite =
  | 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'DUTCH_AUCTION'
  | 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'TARGET_TOTAL_APR'
  | 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE'
  | 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT'
  | 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT';

export interface MerklCampaignBreakdown extends BaseCampaignBreakdown {
  campaignId: string;
  whitelistOnly?: boolean;
  pointsPerThousandUsd?: number;
  rewardTokenSymbol?: string;
  rewardTokenIconUrl?: string;
  campaignType?: ForecastCampaignTypeLite;
  totalBudget?: number;
  aprCap?: number | null;
  latestTvl?: number;
  plannedDaily?: number;
  budgetBoundMode?: string;
  /** V4 Spoke campaign's parent Hub campaign ID (for Hub/Spoke deduplication; stripped from API payload). */
  parentCampaignId?: string;
}

export interface MerklOpportunityGroup extends CampaignGroup<MerklCampaignBreakdown> {}

export interface BrevisCampaignBreakdown extends BaseCampaignBreakdown {
  campaignId: string;
  campaignType?: ForecastCampaignTypeLite;
  aprCap?: number;
  totalBudget?: number;
  latestTvl?: number;
  positionCap?: number;
  rewardTokenSymbol?: string;
}

export interface BrevisCampaignItem extends CampaignGroup<BrevisCampaignBreakdown> {}

export interface MerklCampaignAccess {
  campaignId: string;
  chainId: number;
  whitelist: string[];
  blacklist: string[];
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
}

// ============================================================
// API layer types (derived from runtime types)
// ============================================================

export type ApiMeritCampaignBreakdown = Pick<
  MeritCampaignBreakdown,
  'campaignApr' | 'campaignStartedAt' | 'campaignEndedAt' | 'campaignId'
  | 'campaignType' | 'positionCap' | 'message' | 'aprCap' | 'rewardTokenSymbol' | 'totalBudget' | 'latestTvl'
>;

export type ApiMeritCampaignGroup = CampaignGroup<ApiMeritCampaignBreakdown>;

export type ApiMerklBreakdown = MerklCampaignBreakdown;

export type ApiMerklOpportunityGroup = CampaignGroup<ApiMerklBreakdown>;

export type ApiBrevisBreakdown = Pick<
  BrevisCampaignBreakdown,
  'campaignApr' | 'campaignStartedAt' | 'campaignEndedAt' | 'campaignId'
  | 'campaignType' | 'aprCap' | 'totalBudget' | 'latestTvl' | 'positionCap' | 'rewardTokenSymbol'
>;

export type ApiBrevisCampaignItem = CampaignGroup<ApiBrevisBreakdown>;

export type FetchSource = 'sdk' | 'rpc' | 'stale' | 'none';

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
  sourceSide: 'supply' | 'borrow';
  offsetReserveIds: string[];
}

// ============================================================
// Runtime validation
// ============================================================

export const EXPECTED_RUNTIME_FIELDS = [
  'reserveId',
  'marketName',
  'chainName',
  'chainId',
  'tokenName',
  'tokenSymbol',
  'tokenAddress',
  'tokenPrice',
  'utilizationPct',
  'aTokenAddress',
  'vTokenAddress',
  'supplyApy',
  'supplyDisabled',
  'isFrozen',
  'isPaused',
  'isActive',
  'borrowApy',
  'borrowDisabled',
  'decimals',
  'supplyCap',
  'borrowCap',
  'deficit',
  'supplied',
  'borrowed',
  'liquidity',
  'protocolFee',
  'slopeBelowOptimal',
  'slopeAboveOptimal',
  'optimalUtilization',
  'baseBorrowRate',
  'aaveProReserveId',
  'meritSupplys',
  'meritBorrows',
  'merklSupplys',
  'merklBorrows',
  'merklHolds',
  'brevisSupplys',
  'brevisBorrows',
  'hubId',
  'hubName',
  'hubAddress',
  'spokeId',
  'spokeName',
  'spokeAddress',
  'collateralRisk',
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

type ExpectedField = typeof EXPECTED_RUNTIME_FIELDS[number];
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