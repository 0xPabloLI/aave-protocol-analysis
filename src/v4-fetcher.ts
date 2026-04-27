/**
 * Aave V4 Data Fetcher
 *
 * Fetches Aave V4 reserve data via the V4 SDK (Hub & Spoke model)
 * and maps it to the same FormattedReserveData shape used by V3,
 * so both versions can be served through a single unified API.
 *
 * Key V3 → V4 differences handled here:
 * - V3 `markets()` → V4 `reserves()` + `hubAssets()` (per Hub)
 * - V4 has no aToken / vToken — left as null
 * - V4 incentives are embedded in reserve.summary.rewards[]
 * - V4 rate params come from HubAsset.settings (baseBorrowRate, slopes, etc.)
 */

import { AaveClient, chainId as v4ChainId } from '@aave/client-v4';
import { chains, reserves, hubs, hubAssets } from '@aave/client-v4/actions';
import { logger } from './logger.js';

// Re-use types from V3 — we import only the type to avoid circular deps.
// The actual interface is defined in index.ts; we duplicate the minimal shape here.
interface V4FormattedReserveData {
  reserveId: string;
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  tokenPrice?: number;
  reserveSizeUsd?: number;
  utilizationPct?: number;
  aTokenAddress: string | null;
  vTokenAddress: string | null;
  supplyApy: number | undefined;
  supplyDisabled?: boolean;
  supplyCapUsd?: number;
  borrowApy: number | undefined;
  borrowDisabled?: boolean;
  borrowCapUsd?: number;
  supplyIncentives?: number[];
  borrowIncentives?: number[];
  decimals?: number;
  availableLiquidity?: string;
  totalVariableDebt?: string;
  reserveFactor?: string;
  variableRateSlope1?: string;
  variableRateSlope2?: string;
  optimalUsageRate?: string;
  baseVariableBorrowRate?: string;
  aaveProReserveId?: string;
  // V4 Hub & Spoke addresses for contract interaction
  hubId?: string;
  hubName?: string;
  hubAddress?: string;
  spokeId?: string;
  spokeName?: string;
  spokeAddress?: string;
}

// V4 uses its own client instance (points to the same api.aave.com/graphql)
const v4Client = AaveClient.create();

/**
 * Convert V4 SDK BigDecimal / PercentNumber / plain values to a finite number.
 * V4 SDK uses BigDecimal objects where String(bd) yields the numeric string.
 */
function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && value !== null) {
    // BigDecimal: String(bd) → numeric string (most reliable conversion)
    const str = String(value);
    if (str && str !== '[object Object]') {
      const parsed = parseFloat(str);
      if (Number.isFinite(parsed)) return parsed;
    }
    // Fallback: try .value property
    const maybeValue = (value as any).value;
    if (maybeValue !== undefined) {
      return toFiniteNumber(maybeValue);
    }
  }
  return null;
}

/**
 * Build an index of HubAsset data keyed by (chainId:tokenAddress:hubId)
 * so we can look up rate parameters (baseBorrowRate, slopes, liquidityFee, etc.)
 * for each reserve.
 *
 * Key includes hubId because the same token can have different HubAsset data
 * in different hubs on the same chain (e.g., Core vs Prime on Ethereum).
 */
interface HubAssetInfo {
  utilizationRate?: number;
  availableLiquidity?: string;
  totalBorrowed?: string;
  liquidityFee?: string; // V4 equivalent of V3 reserveFactor (4-decimal format, same as V3)
  baseBorrowRate?: string; // RAY format
  slopeBelowOptimal?: string; // V3 variableRateSlope1 (RAY format)
  slopeAboveOptimal?: string; // V3 variableRateSlope2 (RAY format)
  optimalUtilizationRate?: string; // RAY format
}

/**
 * Convert a V4 PercentNumber's onChainValue to RAY (1e27) format.
 *
 * V4 SDK PercentNumber has a `decimals` field indicating the precision of onChainValue:
 *   - IR model params (slopes, optimal, liquidityFee, baseBorrowRate): decimals=4 (bps-like, 10000=100%)
 *   - APY/utilization: decimals=27 (RAY, 1e27=100%)
 *
 * V3 SDK PercentValue uses decimals=27 (RAY) for all IR model params (slopes, optimal).
 * To maintain consistency with V3 and the downstream fallback calculation
 * (calculateBaseRateFallback which expects RAY), we convert V4 4-decimal values
 * to RAY by multiplying by 10^(27-4) = 10^23.
 *
 * @param onChainValue - The raw integer string from PercentNumber.onChainValue
 * @param decimals - The decimals field from PercentNumber
 * @returns The value converted to RAY (1e27) precision as a string
 */
function percentOnChainValueToRay(onChainValue: string, decimals: number): string {
  if (!onChainValue || onChainValue === '0') return '0';
  const shift = 27 - decimals;
  if (shift === 0) return onChainValue;
  if (shift > 0) {
    // Pad with zeros: e.g., "400" with shift=23 → "400" + "0"*23
    return onChainValue + '0'.repeat(shift);
  }
  // shift < 0: shouldn't happen in practice (V4 uses decimals 4 or 27)
  // but handle gracefully by removing trailing zeros
  const absShift = Math.abs(shift);
  if (onChainValue.length <= absShift) return '0';
  return onChainValue.slice(0, -absShift);
}

async function fetchHubAssetIndex(chainIds: number[]): Promise<{ index: Map<string, HubAssetInfo>; rawAssets: any[] }> {
  const index = new Map<string, HubAssetInfo>();
  const rawAssets: any[] = [];

  if (chainIds.length === 0) return { index, rawAssets };

  // 1. Discover all hubs on supported chains
  const hubsResult = await hubs(v4Client, {
    query: { chainIds: chainIds.map((id) => v4ChainId(id)) },
  });
  if (hubsResult.isErr()) {
    logger.warn(`⚠️ V4: Failed to fetch hubs: ${hubsResult.error.message}`);
    return { index, rawAssets };
  }

  // 2. For each hub, fetch its assets
  for (const hub of hubsResult.value) {
    const hubChainId = Number(hub.chain?.chainId ?? 0);
    const assetsResult = await hubAssets(v4Client, {
      query: { hubId: hub.id },
    });
    if (assetsResult.isErr()) {
      logger.warn(`⚠️ V4: Failed to fetch hubAssets for hub ${hub.name}: ${assetsResult.error.message}`);
      continue;
    }

    rawAssets.push(...assetsResult.value);

    for (const asset of assetsResult.value) {
      const tokenAddress = (asset as any).underlying?.address?.toLowerCase?.() ?? '';
      if (!tokenAddress) continue;
      // Key includes hubId to handle multi-hub chains where the same token
      // has different HubAsset data in different hubs (e.g., Core vs Prime on Ethereum)
      const hubId = String(hub.id ?? '');
      const key = `${hubChainId}:${tokenAddress}:${hubId}`;

      const settings = (asset as any).settings;
      const summary = (asset as any).summary;

      // Convert V4 PercentNumber rate params to RAY (1e27) format for consistency with V3.
      // V4 IR model params use decimals=4 (bps-like), while V3 uses decimals=27 (RAY)
      // for slopes/optimal/baseBorrowRate. We convert these to RAY so the downstream
      // calculateBaseRateFallback() works correctly.
      // Exception: reserveFactor (liquidityFee) — V3 stores it in 4-decimal format (raw=2000 for 20%),
      // so we keep V4's liquidityFee in its native 4-decimal format for API consistency.
      // availableLiquidity/totalBorrowed are DecimalNumber (token-native precision) — no conversion needed.
      const baseBorrowRatePct = settings?.baseBorrowRate;
      const slopeBelowOptimalPct = settings?.slopeBelowOptimal;
      const slopeAboveOptimalPct = settings?.slopeAboveOptimal;
      const optimalUtilizationRatePct = settings?.optimalUtilizationRate;

      index.set(key, {
        utilizationRate: toFiniteNumber(summary?.utilizationRate?.value) ?? undefined,
        availableLiquidity: summary?.availableLiquidity?.amount?.onChainValue?.toString?.() ?? undefined,
        totalBorrowed: summary?.borrowed?.amount?.onChainValue?.toString?.() ?? undefined,
        // liquidityFee: keep in native 4-decimal format to match V3 reserveFactor (also 4-decimal)
        liquidityFee: settings?.liquidityFee?.onChainValue?.toString?.() ?? undefined,
        baseBorrowRate: baseBorrowRatePct?.onChainValue != null
          ? percentOnChainValueToRay(String(baseBorrowRatePct.onChainValue), Number(baseBorrowRatePct.decimals ?? 4))
          : undefined,
        slopeBelowOptimal: slopeBelowOptimalPct?.onChainValue != null
          ? percentOnChainValueToRay(String(slopeBelowOptimalPct.onChainValue), Number(slopeBelowOptimalPct.decimals ?? 4))
          : undefined,
        slopeAboveOptimal: slopeAboveOptimalPct?.onChainValue != null
          ? percentOnChainValueToRay(String(slopeAboveOptimalPct.onChainValue), Number(slopeAboveOptimalPct.decimals ?? 4))
          : undefined,
        optimalUtilizationRate: optimalUtilizationRatePct?.onChainValue != null
          ? percentOnChainValueToRay(String(optimalUtilizationRatePct.onChainValue), Number(optimalUtilizationRatePct.decimals ?? 4))
          : undefined,
      });
    }
  }

  return { index, rawAssets };
}

// ts-prune-ignore-next
export interface V4FetchResult {
  mapped: V4FormattedReserveData[];
  /** Raw SDK response (reserves + hubAssets), serializable with bigintReplacer */
  raw: { reserves: any[]; hubAssets: any[] };
}

/**
 * JSON replacer that converts BigInt and BigDecimal to strings
 * so the raw SDK response can be written to debug files.
 */
// ts-prune-ignore-next
export function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Fetch all V4 reserves and map them to the same FormattedReserveData shape.
 * Also returns the raw SDK response for debug purposes.
 *
 * Internal implementation — use fetchV4MarketsDataWithRetry() for production callers.
 */
async function fetchV4MarketsDataInner(): Promise<V4FetchResult> {
  logger.info('🔄 [V4] Fetching Aave V4 reserves data...');

  // 1. Discover supported chains
  const chainsResult = await chains(v4Client, { query: { filter: 'ALL' as any } });
  if (chainsResult.isErr()) {
    throw new Error(`[V4] Failed to fetch chains: ${chainsResult.error.message}`);
  }

  const supportedChainIds = chainsResult.value
    .filter((c: any) => !c.isTestnet)
    .map((c: any) => Number(c.chainId));

  logger.info(`🌐 [V4] Found ${supportedChainIds.length} mainnet chains`);

  // 2. Build HubAsset index for rate parameters (in parallel with reserves)
  const [hubAssetResult, reservesResult] = await Promise.all([
    fetchHubAssetIndex(supportedChainIds),
    reserves(v4Client, {
      query: { chainIds: supportedChainIds.map((id: number) => v4ChainId(id)) },
    }),
  ]);

  const hubAssetIndex = hubAssetResult.index;
  const rawHubAssets = hubAssetResult.rawAssets;

  if (reservesResult.isErr()) {
    throw new Error(`[V4] Failed to fetch reserves: ${reservesResult.error.message}`);
  }

  const v4Reserves = reservesResult.value;
  logger.info(`✅ [V4] Fetched ${v4Reserves.length} reserves, ${hubAssetIndex.size} hub assets indexed`);

  // 3. Map each V4 Reserve → FormattedReserveData
  const dataset: V4FormattedReserveData[] = [];

  for (const reserve of v4Reserves) {
    const r = reserve as any; // V4 types are deeply nested fragments

    const spokeName: string = r.spoke?.name ?? 'Unknown';
    // Match V3 pattern: "AaveV3Ethereum" → "AaveV4Main", "AaveV4EthenaEcosystem"
    const marketName = `AaveV4${spokeName.replace(/\s+/g, '')}`;
    const chainName: string = r.chain?.name ?? 'Unknown';
    const chainIdNum: number = Number(r.chain?.chainId ?? 0);
    const tokenAddress: string = r.asset?.underlying?.address ?? '';
    const tokenAddressLower = tokenAddress.toLowerCase();
    const tokenSymbol: string = r.asset?.underlying?.info?.symbol ?? 'Unknown';
    const tokenName: string = r.asset?.underlying?.info?.name ?? 'Unknown';
    const decimals: number | undefined = r.asset?.underlying?.info?.decimals ?? undefined;

    // V4 reserveId 格式: {marketName}:{chainId}:{tokenAddress}:{hubName}
    // 在 multi-hub 市场中，同一 token 可能出现在多个 hub，需要 hubName 确保唯一性
    const hubName: string = r.asset?.hub?.name ?? 'Unknown';
    const reserveId = `${marketName}:${chainIdNum}:${tokenAddressLower}:${hubName}`;

    // Token price from exchange rate
    const exchangeRate = toFiniteNumber(r.summary?.supplied?.exchangeRate);
    const tokenPrice = exchangeRate ?? undefined;

    // Reserve size in USD
    const reserveSizeUsd = toFiniteNumber(r.summary?.supplied?.exchange) ?? undefined;

    // Supply APY: use .value (ratio, e.g. 0.0043 = 0.43%), NOT .normalized (percentage)
    // to match V3 convention where serializer does * 100
    const supplyApyRaw = toFiniteNumber(r.summary?.supplyApy?.value);
    const supplyApy = supplyApyRaw ?? undefined;

    // Borrow APY: same — use .value (ratio)
    const borrowApyRaw = toFiniteNumber(r.summary?.borrowApy?.value);
    const borrowApy = borrowApyRaw ?? undefined;

    // Disabled flags
    const isFrozen = r.status?.frozen === true;
    const isPaused = r.status?.paused === true;
    const canSupply: boolean = r.canSupply ?? true;
    const canBorrow: boolean = r.canBorrow ?? true;
    const supplyDisabled = !canSupply;
    const borrowDisabled = !canBorrow;

    // Caps
    const supplyCapUsd = toFiniteNumber(r.settings?.supplyCap?.exchange) ?? undefined;
    const borrowCapUsd = toFiniteNumber(r.settings?.borrowCap?.exchange) ?? undefined;

    // Utilization from HubAsset (reserve-level doesn't have it)
    // Key includes hubId to match the correct HubAsset in multi-hub chains
    const reserveHubId = String(r.asset?.hub?.id ?? '');
    const hubAssetKey = `${chainIdNum}:${tokenAddressLower}:${reserveHubId}`;
    const hubInfo = hubAssetIndex.get(hubAssetKey);
    const utilizationPct = hubInfo?.utilizationRate !== undefined
      ? hubInfo.utilizationRate * 100
      : undefined;

    // V4 SDK embeds summary.rewards[] (MerklSupplyReward / MerklBorrowReward)
    // but these are internal Aave points (payout token "aglaMerklUSD") that
    // don't exist in the public Merkl API and aren't shown as APY on Aave Pro.
    // We skip them here; real Merkl incentives are fetched separately via
    // the Merkl API and attached downstream.

    // V4 Hub & Spoke info for contract interaction links
    const hub = r.asset?.hub;
    const spoke = r.spoke;

    // Rate-input fields from HubAsset
    dataset.push({
      reserveId,
      marketName,
      chainName,
      chainId: chainIdNum,
      tokenName,
      tokenSymbol,
      tokenAddress,
      tokenPrice,
      reserveSizeUsd,
      utilizationPct,
      aTokenAddress: null, // V4 has no aToken
      vTokenAddress: null, // V4 has no vToken
      supplyApy,
      ...(supplyDisabled ? { supplyDisabled: true } : {}),
      ...(isFrozen ? { isFrozen: true } : {}),
      ...(isPaused ? { isPaused: true } : {}),
      ...(supplyCapUsd !== undefined ? { supplyCapUsd } : {}),
      borrowApy,
      ...(borrowDisabled ? { borrowDisabled: true } : {}),
      ...(borrowCapUsd !== undefined ? { borrowCapUsd } : {}),
      ...(decimals !== undefined ? { decimals } : {}),
      ...(hubInfo?.availableLiquidity ? { availableLiquidity: hubInfo.availableLiquidity } : {}),
      ...(r.summary?.borrowed?.amount?.onChainValue ? { totalVariableDebt: r.summary.borrowed.amount.onChainValue.toString() } : {}),
      ...(hubInfo?.liquidityFee ? { reserveFactor: hubInfo.liquidityFee } : {}),
      ...(hubInfo?.slopeBelowOptimal ? { variableRateSlope1: hubInfo.slopeBelowOptimal } : {}),
      ...(hubInfo?.slopeAboveOptimal ? { variableRateSlope2: hubInfo.slopeAboveOptimal } : {}),
      ...(hubInfo?.optimalUtilizationRate ? { optimalUsageRate: hubInfo.optimalUtilizationRate } : {}),
      ...(hubInfo?.baseBorrowRate ? { baseVariableBorrowRate: hubInfo.baseBorrowRate } : {}),
      ...(r.id ? { aaveProReserveId: String(r.id) } : {}),
      // V4 Hub & Spoke addresses
      ...(hub?.id ? { hubId: String(hub.id) } : {}),
      ...(hub?.name ? { hubName: hub.name } : {}),
      ...(hub?.address ? { hubAddress: hub.address } : {}),
      ...(spoke?.id ? { spokeId: String(spoke.id) } : {}),
      ...(spoke?.name ? { spokeName: spoke.name } : {}),
      ...(spoke?.address ? { spokeAddress: spoke.address } : {}),
    });
  }

  logger.info(`🎯 [V4] Mapped ${dataset.length} V4 reserves to unified format`);
  return {
    mapped: dataset,
    raw: { reserves: v4Reserves as any[], hubAssets: rawHubAssets },
  };
}

/**
 * Retry configuration for V4 data fetching.
 * Matches V3's retry pattern (3 attempts with exponential backoff).
 */
const V4_MAX_RETRIES = 3;
const V4_RETRY_BASE_DELAY_MS = 2000; // 2s base, then 4s, 6s

/**
 * Fetch V4 reserves data with retry logic (matches V3 reliability).
 *
 * Retry strategy:
 * - Up to 3 attempts total
 * - Exponential backoff: 2s, 4s, 6s between retries
 * - On final failure, returns empty result (non-fatal for callers that handle it)
 *
 * @param maxRetries - Maximum number of attempts (default: 3, matching V3)
 * @param throwOnFinalFailure - If true, throws on final failure instead of returning empty
 */
// ts-prune-ignore-next
export async function fetchV4ReservesData(
  options?: { maxRetries?: number; throwOnFinalFailure?: boolean }
): Promise<V4FetchResult> {
  const maxRetries = options?.maxRetries ?? V4_MAX_RETRIES;
  const throwOnFinalFailure = options?.throwOnFinalFailure ?? false;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchV4MarketsDataInner();

      if (result.mapped.length === 0) {
        throw new Error('[V4] Fetch succeeded but returned empty dataset');
      }

      if (attempt > 1) {
        logger.info(`✅ [V4] Retry attempt ${attempt}/${maxRetries} succeeded with ${result.mapped.length} reserves`);
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        logger.error(
          `❌ [V4] All ${maxRetries} attempts failed. Last error: ${lastError.message}`
        );
        break;
      }

      const delayMs = V4_RETRY_BASE_DELAY_MS * attempt; // 2s, 4s, 6s
      logger.warn(
        `⚠️ [V4] Attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms... ` +
        `(error: ${lastError.message})`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // All retries exhausted
  if (throwOnFinalFailure && lastError) {
    throw lastError;
  }

  logger.error(`❌ [V4] Returning empty dataset after ${maxRetries} failed attempts`);
  return { mapped: [], raw: { reserves: [], hubAssets: [] } };
}
