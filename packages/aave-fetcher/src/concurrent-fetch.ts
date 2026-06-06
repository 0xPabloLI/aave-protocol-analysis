import type { RuntimeReserveData, SpokeHubTopology } from '@internal/aave-shared-contracts';
import { logger } from './logger.js';
import { toFiniteNumber, percentValueToPercent } from './utils/number.js';

export interface V4FetchResult {
  mapped: RuntimeReserveData[];
  raw: { reserves: any[] };
  spokeHubTopology: SpokeHubTopology;
}

export const FETCH_TIMEOUT_MS = 35_000;

export function buildV3BaseDataset(markets: any[]): RuntimeReserveData[] {
  const baseDataset: RuntimeReserveData[] = [];

  markets.forEach(market => {
    const poolAddress = (market.address || '').toLowerCase();
    const marketName = market.name || 'Unknown';
    const chainName = market.chain?.name || 'Unknown';
    const chainId = market.chain?.chainId || 0;

    if (market.supplyReserves && Array.isArray(market.supplyReserves)) {
      market.supplyReserves.forEach((reserve: any) => {
        const tokenSymbol = reserve.underlyingToken?.symbol || 'Unknown';
        const tokenAddress = reserve.underlyingToken?.address || '';
        const tokenAddressLower = tokenAddress.toLowerCase();
        const reserveId = `${chainId}:${poolAddress}:${tokenAddressLower}`;
        const tokenPrice =
          toFiniteNumber(reserve?.size?.usdPerToken) ??
          toFiniteNumber(reserve?.usdExchangeRate) ??
          undefined;
        const utilizationRaw = toFiniteNumber(reserve?.borrowInfo?.utilizationRate?.value);
        const utilizationPct =
          utilizationRaw !== null && utilizationRaw >= 0 ? utilizationRaw * 100 : undefined;
        const aTokenAddress = reserve.aToken?.address ?? null;
        const vTokenAddress = reserve.vToken?.address ?? null;

        const isFrozen = reserve.isFrozen === true;
        const isPaused = reserve.isPaused === true;
        const hasProtocolReason = isPaused || isFrozen;
        const supplyCapValue = reserve.supplyInfo?.supplyCap?.amount?.value;
        const supplyCapIsOne = supplyCapValue !== undefined && toFiniteNumber(supplyCapValue) === 1;
        const isSupplyDisabled = hasProtocolReason ? false : supplyCapIsOne;

        const supplyApyValue = reserve.supplyInfo?.apy?.value;
        const supplyApy = supplyCapIsOne || !supplyApyValue
          ? undefined
          : toFiniteNumber(supplyApyValue) ?? undefined;

        const isBorrowDisabledByState = reserve.borrowInfo?.borrowingState === "DISABLED" || reserve.borrowInfo === null;

        const borrowCapValue = reserve.borrowInfo?.borrowCap?.amount?.value;
        const borrowCapIsOne = borrowCapValue !== undefined && toFiniteNumber(borrowCapValue) === 1;
        const isBorrowDisabled = hasProtocolReason ? false : (isBorrowDisabledByState || borrowCapIsOne);

        const borrowApyValue = reserve.borrowInfo?.apy?.value;
        const borrowApy = toFiniteNumber(borrowApyValue) ?? undefined;

        const decimals = reserve.underlyingToken?.decimals ?? undefined;
        const liquidity = reserve.borrowInfo?.availableLiquidity?.amount?.raw ?? undefined;
        const borrowed = reserve.borrowInfo?.total?.amount?.raw ?? undefined;
        const supplied = reserve.size?.amount?.raw ?? undefined;
        const supplyCap = reserve.supplyInfo?.supplyCap?.amount?.raw ?? undefined;
        const borrowCap = reserve.borrowInfo?.borrowCap?.amount?.raw ?? undefined;
        const protocolFee = percentValueToPercent(reserve.borrowInfo?.reserveFactor);
        const slopeBelowOptimal = percentValueToPercent(reserve.borrowInfo?.variableRateSlope1);
        const slopeAboveOptimal = percentValueToPercent(reserve.borrowInfo?.variableRateSlope2);
        const optimalUtilization = percentValueToPercent(reserve.borrowInfo?.optimalUsageRate);

        baseDataset.push({
          reserveId,
          marketName,
          chainName,
          chainId,
          tokenName: reserve.underlyingToken?.name || 'Unknown',
          tokenSymbol,
          tokenAddress,
          tokenPrice,
          utilizationPct,
          aTokenAddress,
          vTokenAddress,
          supplyApy,
          ...(isSupplyDisabled ? { supplyDisabled: true } : {}),
          ...(isFrozen ? { isFrozen: true } : {}),
          ...(isPaused ? { isPaused: true } : {}),
          borrowApy,
          ...(isBorrowDisabled ? { borrowDisabled: true } : {}),
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
        });
      });
    }
  });

  return baseDataset;
}

export function buildMarketsBaseDataset(v3Markets: any[], v4Result: V4FetchResult): {
  baseDataset: RuntimeReserveData[];
  v3Count: number;
  v4Count: number;
  v4Dataset: RuntimeReserveData[];
  v4Raw: V4FetchResult['raw'];
  spokeHubTopology: SpokeHubTopology;
} {
  const v3Dataset = buildV3BaseDataset(v3Markets);
  const v4Dataset = v4Result.mapped;
  const v4Raw = v4Result.raw;
  const spokeHubTopology = v4Result.spokeHubTopology;
  const baseDataset = [...v3Dataset, ...v4Dataset];
  logger.info(`📊 Unified dataset: ${baseDataset.length} reserves (V3: ${v3Dataset.length}, V4: ${v4Dataset.length})`);
  return { baseDataset, v3Count: v3Dataset.length, v4Count: v4Dataset.length, v4Dataset, v4Raw, spokeHubTopology };
}

export async function fetchV3MarketsWithTimeout(options: {
  _fetchV3Fn: () => Promise<any>;
}): Promise<any> {
  const fetchPromise = options._fetchV3Fn();
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`V3 fetch timeout (timeout after ${FETCH_TIMEOUT_MS}ms)`));
    }, FETCH_TIMEOUT_MS);
  });
  return Promise.race([
    fetchPromise.finally(() => { if (timeoutId !== null) clearTimeout(timeoutId); }),
    timeoutPromise.finally(() => { if (timeoutId !== null) clearTimeout(timeoutId); }),
  ]);
}

export async function fetchV4ReservesWithTimeout(options: {
  _fetchV4Fn: () => Promise<V4FetchResult>;
}): Promise<V4FetchResult & { source: 'sdk' | 'timeout' }> {
  const fetchPromise = options._fetchV4Fn();
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`V4 fetch timeout (timeout after ${FETCH_TIMEOUT_MS}ms)`));
    }, FETCH_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      fetchPromise.finally(() => { if (timeoutId !== null) clearTimeout(timeoutId); }),
      timeoutPromise.finally(() => { if (timeoutId !== null) clearTimeout(timeoutId); }),
    ]);
    return { ...result, source: 'sdk' };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('timeout')) {
      throw new Error(`V4 fetch timeout (timeout after ${FETCH_TIMEOUT_MS}ms)`);
    }
    throw error;
  }
}
