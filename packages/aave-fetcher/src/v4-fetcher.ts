/**
 * Aave V4 Data Fetcher
 *
 * Fetches Aave V4 reserve data via the V4 SDK (Hub & Spoke model)
 * and maps it to the same RuntimeReserveData shape used by V3,
 * so both versions can be served through a single unified API.
 *
 * Key V3 → V4 differences handled here:
 * - V3 `markets()` → V4 `reserves()`. The reserve already embeds `asset.summary`
 *   (hub-level liquidity / utilization) and `asset.settings` (hub-level rate model),
 *   so a separate `hubAssets()` fetch is no longer required.
 * - V4 has no aToken / vToken — left as null.
 * - V4 incentives are embedded in reserve.summary.rewards[] but treated as Aave-internal
 *   points; we don't map them here (real Merkl incentives are merged downstream).
 * - All rate-model fields (utilization, slopes, optimal, baseRate, reserveFactor)
 *   are emitted as percent numbers (e.g., 9.0 means 9%) to match V3 after unification.
 */

import { AaveClient, chainId as v4ChainId } from '@aave/client-v4';
import { chains, reserves } from '@aave/client-v4/actions';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';
import { logger } from './logger.js';
import { toFiniteNumber, percentValueToPercent } from './utils/number.js';

type V4FormattedReserveData = RuntimeReserveData;

// V4 uses its own client instance (points to the same api.aave.com/graphql)
const v4Client = AaveClient.create();

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

// ts-prune-ignore-next
export interface V4FetchResult {
  mapped: V4FormattedReserveData[];
  /** Raw SDK response (reserves only — hubAssets is no longer fetched). */
  raw: { reserves: any[] };
}

/**
 * Fetch all V4 reserves and map them to the RuntimeReserveData shape.
 * Also returns the raw SDK response for debug purposes.
 *
 * Internal implementation — use fetchV4ReservesData() for production callers.
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

  // 2. Fetch reserves. Each reserve already embeds `asset.summary` (hub-level liquidity /
  //    utilization) and `asset.settings` (hub-level rate model), so we don't need a
  //    separate hubAssets() pre-fetch.
  const reservesResult = await reserves(v4Client, {
    query: { chainIds: supportedChainIds.map((id: number) => v4ChainId(id)) },
  });

  if (reservesResult.isErr()) {
    throw new Error(`[V4] Failed to fetch reserves: ${reservesResult.error.message}`);
  }

  const v4Reserves = reservesResult.value;
  logger.info(`✅ [V4] Fetched ${v4Reserves.length} reserves`);

  // 3. Map each V4 Reserve → RuntimeReserveData
  const dataset: V4FormattedReserveData[] = [];

  for (const reserve of v4Reserves) {
    const r = reserve as any; // V4 types are deeply nested fragments

    const spokeName: string = r.spoke?.name ?? 'Unknown';
    const chainName: string = r.chain?.name ?? 'Unknown';
    const chainIdNum: number = Number(r.chain?.chainId ?? 0);
    const tokenAddress: string = r.asset?.underlying?.address ?? '';
    const tokenAddressLower = tokenAddress.toLowerCase();
    const tokenSymbol: string = r.asset?.underlying?.info?.symbol ?? 'Unknown';
    const tokenName: string = r.asset?.underlying?.info?.name ?? 'Unknown';
    const decimals: number | undefined = r.asset?.underlying?.info?.decimals ?? undefined;

    const hubName: string = r.asset?.hub?.name ?? 'Unknown';
    const spokeAddress: string = r.spoke?.address ?? '';
    if (!spokeAddress) continue;
    const spokeAddressLower = spokeAddress.toLowerCase();
    // V4 reserveId 格式: {chainId}:{spokeAddress}:{tokenAddress}:{hubName}
    // address-based，和 V3 (${chainId}:${poolAddress}:${tokenAddr}) 风格一致
    // hubName 确保唯一性：同一 spoke 内同一 token 可来自不同 hub
    const reserveId = `${chainIdNum}:${spokeAddressLower}:${tokenAddressLower}:${hubName}`;
    const marketName = `AaveV4${spokeName.replace(/\s+/g, '')}`;

    // Token price from exchange rate
    const exchangeRate = toFiniteNumber(r.summary?.supplied?.exchangeRate?.value)
      ?? toFiniteNumber(r.summary?.supplied?.exchangeRate);
    const tokenPrice = exchangeRate ?? undefined;

    // Supply / Borrow APY: use .value (ratio) — serializer applies ×100.
    const supplyApy = toFiniteNumber(r.summary?.supplyApy?.value) ?? undefined;
    const borrowApy = toFiniteNumber(r.summary?.borrowApy?.value) ?? undefined;

    // Disabled flags
    const isFrozen = r.status?.frozen === true;
    const isPaused = r.status?.paused === true;
    const isInactive = r.status?.active === false;
    const canSupply: boolean = r.canSupply ?? true;
    const canBorrow: boolean = r.canBorrow ?? true;
    const hasProtocolReason = isPaused || isInactive || isFrozen;
    const supplyDisabled = hasProtocolReason ? false : !canSupply;
    const borrowDisabled = hasProtocolReason ? false : !canBorrow;

    // Hub-level (shared across spokes) liquidity / utilization / rate model
    const a = r.asset;
    const utilizationPct = percentValueToPercent(a?.summary?.utilizationRate);
    const liquidity = a?.summary?.availableLiquidity?.amount?.onChainValue?.toString?.() ?? undefined;

    const protocolFee = percentValueToPercent(a?.settings?.liquidityFee);
    const slopeBelowOptimal = percentValueToPercent(a?.settings?.slopeBelowOptimal);
    const slopeAboveOptimal = percentValueToPercent(a?.settings?.slopeAboveOptimal);
    const optimalUtilization = percentValueToPercent(a?.settings?.optimalUtilizationRate);
    const baseBorrowRate = percentValueToPercent(a?.settings?.baseBorrowRate);

    // Reserve-level (per-spoke) sizes & caps in raw token units
    const supplied = r.summary?.supplied?.amount?.onChainValue?.toString?.() ?? undefined;
    const borrowed = r.summary?.borrowed?.amount?.onChainValue?.toString?.() ?? undefined;
    const supplyCap = r.settings?.supplyCap?.amount?.onChainValue?.toString?.() ?? undefined;
    const borrowCap = r.settings?.borrowCap?.amount?.onChainValue?.toString?.() ?? undefined;
    const collateralRisk = percentValueToPercent(r.settings?.collateralRisk);

    // V4 SDK embeds summary.rewards[] (MerklSupplyReward / MerklBorrowReward) but they
    // are internal Aave points (payout token "aglaMerklUSD") that don't exist in the
    // public Merkl API and aren't shown as APY on Aave Pro. Skip them; real Merkl
    // incentives are fetched separately via the Merkl API and attached downstream.

    // V4 Hub & Spoke info for contract interaction links
    const hub = r.asset?.hub;
    const spoke = r.spoke;

    dataset.push({
      reserveId,
      marketName,
      chainName,
      chainId: chainIdNum,
      tokenName,
      tokenSymbol,
      tokenAddress,
      ...(tokenPrice !== undefined ? { tokenPrice } : {}),
      ...(utilizationPct !== undefined ? { utilizationPct } : {}),
      aTokenAddress: null, // V4 has no aToken
      vTokenAddress: null, // V4 has no vToken
      supplyApy,
      ...(supplyDisabled ? { supplyDisabled: true } : {}),
      ...(isFrozen ? { isFrozen: true } : {}),
      ...(isPaused ? { isPaused: true } : {}),
      ...(isInactive ? { isActive: false } as const : {}),
      borrowApy,
      ...(borrowDisabled ? { borrowDisabled: true } : {}),
      ...(decimals !== undefined && decimals !== 18 ? { decimals } : {}),
      ...(liquidity ? { liquidity } : {}),
      ...(borrowed ? { borrowed } : {}),
      ...(supplied ? { supplied } : {}),
      ...(supplyCap ? { supplyCap } : {}),
      ...(borrowCap ? { borrowCap } : {}),
      ...(protocolFee !== undefined ? { protocolFee } : {}),
      ...(slopeBelowOptimal !== undefined ? { slopeBelowOptimal } : {}),
      ...(slopeAboveOptimal !== undefined ? { slopeAboveOptimal } : {}),
      ...(optimalUtilization !== undefined ? { optimalUtilization } : {}),
      ...(baseBorrowRate !== undefined ? { baseBorrowRate } : {}),
      ...(r.id ? { aaveProReserveId: String(r.id) } : {}),
      // V4 Hub & Spoke addresses
      ...(hub?.id ? { hubId: String(hub.id) } : {}),
      ...(hub?.name ? { hubName: hub.name } : {}),
      ...(hub?.address ? { hubAddress: hub.address } : {}),
      ...(spoke?.id ? { spokeId: String(spoke.id) } : {}),
      ...(spoke?.name ? { spokeName: spoke.name } : {}),
      ...(spoke?.address ? { spokeAddress: spoke.address } : {}),
      ...(collateralRisk !== undefined ? { collateralRisk } : {}),
    });
  }

  logger.info(`🎯 [V4] Mapped ${dataset.length} V4 reserves to unified format`);
  return {
    mapped: dataset,
    raw: { reserves: v4Reserves as any[] },
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
  return { mapped: [], raw: { reserves: [] } };
}
