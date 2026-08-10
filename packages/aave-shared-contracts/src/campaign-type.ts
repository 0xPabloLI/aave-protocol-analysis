/**
 * Campaign type normalization — single source of truth.
 *
 * Unifies the previously duplicated `normalizeCampaignType` (backend
 * `merklForecastModel.ts`) and `normalizeForecastCampaignTypeLite` (fetcher
 * `merkl-api.ts`) into one function imported by both packages.
 *
 * See ADR-0024 for the multi-level mapping design.
 */

// Import the type (defined in index.ts, co-located with breakdown types).
import type { ForecastCampaignTypeLite } from "./index.js";

// Re-export the type so consumers can import everything from this module.
export type { ForecastCampaignTypeLite } from "./index.js";

/**
 * Input for campaign type normalization.
 *
 * - `distributionType`: Merkl API raw `distributionType` field (Level 2 exact match).
 * - `targetAPR`: Merkl API `distributionSettings.targetAPR` (Level 3 fallback).
 */
export interface NormalizeCampaignTypeInput {
  distributionType?: string;
  targetAPR?: number | string;
}

// ============================================================
// Internal helpers (not exported)
// ============================================================

/** 13-pattern mapping table: distributionType → canonical ForecastCampaignTypeLite. */
const DISTRIBUTION_TYPE_PATTERNS: Array<{
  pattern: string;
  result: ForecastCampaignTypeLite;
}> = [
  {
    pattern: "MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
    result: "MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
  },
  {
    pattern: "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT",
    result: "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT",
  },
  {
    pattern: "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
    result: "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
  },
  {
    pattern: "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE",
    result: "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE",
  },
  {
    pattern: "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT",
    result: "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT",
  },
  { pattern: "DUTCH_AUCTION", result: "DUTCH_AUCTION" },
  { pattern: "AAVE_NET_APR", result: "TARGET_TOTAL_APR" },
  { pattern: "AAVE_V4_NET_APR", result: "TARGET_TOTAL_APR" },
  { pattern: "ERC4626_APR", result: "TARGET_TOTAL_APR" },
  { pattern: "ERC4626_SPREAD_CAPPED", result: "TARGET_TOTAL_APR" },
  { pattern: "ERC4626_TARGET_APR_WITH_MERKL", result: "TARGET_TOTAL_APR" },
  { pattern: "SOFR_SPREAD_RATCHET", result: "TARGET_TOTAL_APR" },
  { pattern: "DEEL_DISTRIBUTION", result: "TARGET_TOTAL_APR" },
];

/**
 * Match `distributionType` against the known pattern table (Level 2).
 * Case-insensitive and whitespace-tolerant.
 */
function normalizeByDistributionType(
  value: string | undefined
): ForecastCampaignTypeLite | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  for (const { pattern, result } of DISTRIBUTION_TYPE_PATTERNS) {
    if (upper === pattern) return result;
  }
  return null;
}

/** Extract a finite positive number from unknown input (Level 3 helper). */
function toFinitePositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

// ============================================================
// Public API
// ============================================================

/**
 * Normalize a Merkl campaign's type information into a canonical
 * `ForecastCampaignTypeLite`.
 *
 * Priority:
 * 1. **Level 2** — `distributionType` exact match (case-insensitive, trimmed)
 *    against the 13-pattern table.
 * 2. **Level 3** — `targetAPR` exists and is a finite positive number →
 *    `'TARGET_TOTAL_APR'`.
 * 3. No match → `null` (unrecognized campaign is skipped).
 *
 * Level 1 (`distributionMethod`) was removed (always empty in Aave campaigns,
 * dead code). See ADR-0024.
 */
export function normalizeCampaignType(
  input: NormalizeCampaignTypeInput | unknown
): ForecastCampaignTypeLite | null {
  if (!input || typeof input !== "object") return null;
  const { distributionType, targetAPR } = input as NormalizeCampaignTypeInput;

  return (
    normalizeByDistributionType(distributionType) ??
    (toFinitePositiveNumber(targetAPR) !== null ? "TARGET_TOTAL_APR" : null)
  );
}
