/**
 * Unit conversion utilities — single source of truth for all numeric unit
 * conversions in the Aave protocol analysis pipeline.
 *
 * ## Unit conventions
 *
 * `RuntimeReserveData` (in-memory / cron path):
 * - **ratio** fields: decimal fraction (0.04 = 4%). Serializer multiplies by 100.
 * - **percent** fields: whole-number percent (4 = 4%). Serializer passes through.
 * - **number** fields: dimensionless (tokenPrice, chainId, decimals). No conversion.
 * - **string** fields: raw on-chain amounts or addresses. No conversion.
 * - **boolean** fields: flags.
 *
 * `MarketWithSpread` (API output):
 * - All yield/rate fields are **percent** (4 = 4%).
 *
 * On-chain (Ethereum):
 * - RAY = 10^27 fixed-point. 1 RAY in ratio terms = 1.0 (= 100%).
 *
 * ## How to use
 *
 * When writing a new field into `RuntimeReserveData`:
 * 1. Add the field to `FIELD_UNITS` below with its correct unit.
 * 2. If it's a yield/rate field, decide: ratio or percent?
 *    - APY/APR fields that come from SDK `.value` → **ratio** (already a decimal fraction).
 *    - Rate-model fields that come from SDK `PercentValue` → **percent** (already ×100).
 *    - On-chain RAY values for APY → use `rayToRatio()` for ratio fields.
 *    - On-chain RAY values for rate-model → use `rayToPercent()` for percent fields.
 * 3. Update `SERIALIZER_RULES` to declare how the serializer should handle it.
 * 4. The invariant test (`units.test.ts`) will verify consistency.
 */

// ============================================================
// Core conversion functions
// ============================================================

/**
 * Convert a RAY string (10^27 fixed-point) to a **ratio** (0.04 = 4%).
 *
 * Use for fields declared as 'ratio' in FIELD_UNITS when the source is on-chain RAY.
 *
 * @example rayToRatio("40000000000000000000000000") → 0.04
 * @example rayToRatio("1000000000000000000000000000") → 1.0 (100%)
 */
export function rayToRatio(rayStr: string): number | undefined {
  if (!rayStr) return undefined;
  try {
    const big = BigInt(rayStr);
    // Divide by 10^21 to get micro-ratio (ratio × 10^6), then by 1e6.
    // This preserves 6 decimal places of precision via integer-first division.
    const microRatio = big / 10n ** 21n;
    return Number(microRatio) / 1e6;
  } catch {
    return undefined;
  }
}

/**
 * Convert a RAY string (10^27 fixed-point) to a **percent** (4 = 4%).
 *
 * Use for fields declared as 'percent' in FIELD_UNITS when the source is on-chain RAY.
 *
 * @example rayToPercent("40000000000000000000000000") → 4
 * @example rayToPercent("1000000000000000000000000000") → 100
 */
export function rayToPercent(rayStr: string): number | undefined {
  if (!rayStr) return undefined;
  try {
    const big = BigInt(rayStr);
    // Divide by 10^19 to get micro-percent (percent × 10^6), then by 1e6.
    const microPct = big / 10n ** 19n;
    return Number(microPct) / 1e6;
  } catch {
    return undefined;
  }
}

/**
 * Convert a ratio (0.04) to a percent (4).
 * @example ratioToPercent(0.04) → 4
 */
export function ratioToPercent(ratio: number): number {
  return ratio * 100;
}

/**
 * Convert a percent (4) to a ratio (0.04).
 * @example percentToRatio(4) → 0.04
 */
export function percentToRatio(percent: number): number {
  return percent / 100;
}

// ============================================================
// Field unit registry
// ============================================================

/**
 * The in-memory unit of every field in `RuntimeReserveData`.
 *
 * This is the **single source of truth** for what unit each field uses
 * in the in-memory / cron-write path. The serializer (`marketsApiSerialize.ts`)
 * uses `SERIALIZER_RULES` (derived from this) to decide how to scale each field.
 *
 * Rules for adding new fields:
 * - APY/APR yield fields (supplyApy, borrowApy): **'ratio'** — SDK returns `.value` as decimal.
 * - Rate-model config fields (slopes, optimalUtilization, baseBorrowRate): **'percent'** — SDK returns `PercentValue` already ×100.
 * - Incentive campaignApr/aprCap: **'ratio'** — Merkl/Merit/Brevis APIs return decimal APR.
 * - Utilization: **'percent'** — convention from V3 SDK (utilizationRate.value × 100).
 * - Raw amounts (liquidity, supplied, etc.): **'string'** — on-chain base units.
 */
export const FIELD_UNITS = {
  // Identity & metadata
  reserveId: 'string',
  marketName: 'string',
  chainName: 'string',
  chainId: 'number',
  tokenName: 'string',
  tokenSymbol: 'string',
  tokenAddress: 'string',
  aaveProReserveId: 'string',
  // Token info
  tokenPrice: 'number',
  decimals: 'number',
  aTokenAddress: 'string',
  vTokenAddress: 'string',
  // Yield fields (ratio — serializer applies ×100)
  supplyApy: 'ratio',
  borrowApy: 'ratio',
  // Rate-model config (percent — serializer passes through)
  utilizationPct: 'percent',
  protocolFee: 'percent',
  slopeBelowOptimal: 'percent',
  slopeAboveOptimal: 'percent',
  optimalUtilization: 'percent',
  baseBorrowRate: 'percent',
  collateralRisk: 'percent',
  // Flags
  supplyDisabled: 'boolean',
  isFrozen: 'boolean',
  isPaused: 'boolean',
  isActive: 'boolean',
  borrowDisabled: 'boolean',
  // Raw on-chain amounts (string, base units)
  supplyCap: 'string',
  borrowCap: 'string',
  deficit: 'string',
  supplied: 'string',
  borrowed: 'string',
  hubBorrowed: 'string',
  hubSupplied: 'string',
  liquidity: 'string',
  // Hub & Spoke metadata
  hubId: 'string',
  hubName: 'string',
  hubAddress: 'string',
  spokeId: 'string',
  spokeName: 'string',
  spokeAddress: 'string',
  // Incentive campaign arrays — nested objects with ratio fields inside
  // (campaignApr, aprCap are ratio in memory; serializer applies ×100 per breakdown)
  meritSupplys: 'campaignArray',
  meritBorrows: 'campaignArray',
  merklSupplys: 'campaignArray',
  merklBorrows: 'campaignArray',
  merklHolds: 'campaignArray',
  brevisSupplys: 'campaignArray',
  brevisBorrows: 'campaignArray',
} as const;

export type FieldUnit = (typeof FIELD_UNITS)[keyof typeof FIELD_UNITS];

// ============================================================
// Serializer rules — how the API serializer should handle each field
// ============================================================

/**
 * How the serializer (`serializeReserveForApi`) should transform each field
 * from in-memory unit to API-output unit.
 *
 * - 'multiply100': field is ratio in memory, ×100 for API output.
 * - 'passthrough': field is already in the correct unit (percent, number, string, etc.).
 *
 * Derived from FIELD_UNITS: ratio → multiply100, everything else → passthrough.
 */
export const SERIALIZER_RULES: Record<string, 'multiply100' | 'passthrough'> = Object.fromEntries(
  Object.entries(FIELD_UNITS).map(([field, unit]) => [
    field,
    unit === 'ratio' ? 'multiply100' : 'passthrough',
  ]),
);

// ============================================================
// Convenience sets for testing
// ============================================================

/** All fields that are stored as ratio in memory (serializer must ×100). */
export const RATIO_FIELDS = Object.entries(FIELD_UNITS)
  .filter(([, unit]) => unit === 'ratio')
  .map(([field]) => field);

/** All fields that are stored as percent in memory (serializer passes through). */
export const PERCENT_FIELDS = Object.entries(FIELD_UNITS)
  .filter(([, unit]) => unit === 'percent')
  .map(([field]) => field);
