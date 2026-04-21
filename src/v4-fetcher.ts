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
 * Build an index of HubAsset data keyed by underlying token address + chainId
 * so we can look up rate parameters (baseBorrowRate, slopes, liquidityFee, etc.)
 * for each reserve.
 */
interface HubAssetInfo {
  utilizationRate?: number;
  availableLiquidity?: string;
  totalBorrowed?: string;
  liquidityFee?: string; // V4 equivalent of V3 reserveFactor
  baseBorrowRate?: string;
  slopeBelowOptimal?: string; // V3 variableRateSlope1
  slopeAboveOptimal?: string; // V3 variableRateSlope2
  optimalUtilizationRate?: string;
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
      const key = `${hubChainId}:${tokenAddress}`;

      const settings = (asset as any).settings;
      const summary = (asset as any).summary;

      index.set(key, {
        utilizationRate: toFiniteNumber(summary?.utilizationRate?.value) ?? undefined,
        availableLiquidity: summary?.availableLiquidity?.amount?.onChainValue?.toString?.() ?? undefined,
        totalBorrowed: summary?.borrowed?.amount?.onChainValue?.toString?.() ?? undefined,
        liquidityFee: settings?.liquidityFee?.onChainValue?.toString?.() ?? undefined,
        baseBorrowRate: settings?.baseBorrowRate?.onChainValue?.toString?.() ?? undefined,
        slopeBelowOptimal: settings?.slopeBelowOptimal?.onChainValue?.toString?.() ?? undefined,
        slopeAboveOptimal: settings?.slopeAboveOptimal?.onChainValue?.toString?.() ?? undefined,
        optimalUtilizationRate: settings?.optimalUtilizationRate?.onChainValue?.toString?.() ?? undefined,
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
 */
// ts-prune-ignore-next
export async function fetchAaveV4Reserves(): Promise<V4FetchResult> {
  logger.info('🔄 [V4] Fetching Aave V4 reserves data...');

  // 1. Discover supported chains
  const chainsResult = await chains(v4Client, { query: { filter: 'ALL' as any } });
  if (chainsResult.isErr()) {
    logger.error(`❌ [V4] Failed to fetch chains: ${chainsResult.error.message}`);
    return { mapped: [], raw: { reserves: [], hubAssets: [] } };
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
    logger.error(`❌ [V4] Failed to fetch reserves: ${reservesResult.error.message}`);
    return { mapped: [], raw: { reserves: [], hubAssets: rawHubAssets } };
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

    // reserveId: use "AaveV4<spoke>" to match V3's "AaveV3<chain>" pattern
    const reserveId = `${marketName}:${chainIdNum}:${tokenAddressLower}`;

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
    const supplyDisabled = !canSupply || isFrozen || isPaused;
    const borrowDisabled = !canBorrow;

    // Caps
    const supplyCapUsd = toFiniteNumber(r.settings?.supplyCap?.exchange) ?? undefined;
    const borrowCapUsd = toFiniteNumber(r.settings?.borrowCap?.exchange) ?? undefined;

    // Utilization from HubAsset (reserve-level doesn't have it)
    const hubAssetKey = `${chainIdNum}:${tokenAddressLower}`;
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
      ...(supplyCapUsd !== undefined ? { supplyCapUsd } : {}),
      borrowApy,
      ...(borrowDisabled ? { borrowDisabled: true } : {}),
      ...(borrowCapUsd !== undefined ? { borrowCapUsd } : {}),
      ...(decimals !== undefined ? { decimals } : {}),
      ...(hubInfo?.availableLiquidity ? { availableLiquidity: hubInfo.availableLiquidity } : {}),
      ...(hubInfo?.totalBorrowed ? { totalVariableDebt: hubInfo.totalBorrowed } : {}),
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
