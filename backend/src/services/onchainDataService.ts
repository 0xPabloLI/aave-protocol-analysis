/**
 * On-chain Data Service - Fetches data only available from on-chain RPC
 *
 * Fetches `deficit` and `baseVariableBorrowRate` from UiPoolDataProvider.getReservesHumanized()
 * for all pools (all address-book markets including same-chain variants e.g. Ethereum main, Lido, EtherFi, Horizon).
 *
 * Architecture:
 * - One config per address-book entry (per pool/market), not per chainId
 * - Cache key: poolAddress (unique per pool deployment)
 * - Merge key: reserveId = `${chainId}:${poolAddress}:${tokenAddress}` (matches SDK reserveId)
 * - Runs independently from markets fetch (async, non-blocking)
 * - Per-pool caching with 30-min TTL
 * - If RPC fails, cached data within TTL is used
 * - If no cached data, fields are absent (with fallback calculation for baseVariableBorrowRate)
 */

import { UiPoolDataProvider } from '@aave/contract-helpers';
import * as AaveAddressBook from '@aave-dao/aave-address-book';
import { getAaveRpcUrlsByChainId } from '@internal/aave-shared-config';
import { withTimeout } from '../lib/timeout.js';
import { ethProviderService } from './ethProviderService.js';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';

const ONCHAIN_PER_RPC_TIMEOUT_MS = 15_000;

export interface OnchainReserveData {
  deficit?: string;
  baseVariableBorrowRate?: number;
}

function rayStringToPercent(rayStr: string): number | undefined {
  if (!rayStr) return undefined;
  try {
    const big = BigInt(rayStr);
    const microPct = big / 10n ** 21n;
    return Number(microPct) / 1e6;
  } catch {
    return undefined;
  }
}

interface ChainCacheEntry {
  data: Map<string, OnchainReserveData>;
  updatedAt: number;
}

interface OnchainConfig {
  poolAddress: string;
  chainId: number;
  uiPoolDataProviderAddress: string;
  poolAddressesProvider: string;
  defaultRpcUrls: string[];
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase().trim();
}

function buildPoolConfigs(): Map<string, OnchainConfig> {
  const configs = new Map<string, OnchainConfig>();

  for (const [key, value] of Object.entries(AaveAddressBook)) {
    if (!key.startsWith('AaveV3')) continue;
    if (!value || typeof value !== 'object') continue;
    if (key.includes('Sepolia') || key.includes('Fuji')) continue;

    const chainId = Number((value as any).CHAIN_ID);
    const poolAddress = normalizeAddress(String((value as any).POOL || ''));
    const uiPoolDataProviderAddress = (value as any).UI_POOL_DATA_PROVIDER;
    const poolAddressesProvider = (value as any).POOL_ADDRESSES_PROVIDER;

    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    if (!poolAddress) continue;
    if (typeof uiPoolDataProviderAddress !== 'string') continue;
    if (typeof poolAddressesProvider !== 'string') continue;

    configs.set(poolAddress, {
      poolAddress,
      chainId,
      uiPoolDataProviderAddress,
      poolAddressesProvider,
      defaultRpcUrls: getAaveRpcUrlsByChainId(chainId),
    });
  }

  return configs;
}

const POOL_CONFIGS = buildPoolConfigs();

const poolCache = new Map<string, ChainCacheEntry>();

let refreshInProgress: Promise<void> | null = null;

async function fetchAndCacheChain(config: OnchainConfig): Promise<boolean> {
  const rpcCandidates = ethProviderService.getProvidersForChain(config.chainId, config.defaultRpcUrls);
  logger.debug(
    `On-chain RPC order for ${config.poolAddress}: ${rpcCandidates.map((c) => c.rpcUrl).join(' -> ')}`
  );

  for (const { rpcUrl, provider } of rpcCandidates) {
    try {
      const uiPoolDataProvider = new UiPoolDataProvider({
        uiPoolDataProviderAddress: config.uiPoolDataProviderAddress,
        provider,
        chainId: config.chainId,
      });

      const humanized = await withTimeout(
        uiPoolDataProvider.getReservesHumanized({
          lendingPoolAddressProvider: config.poolAddressesProvider,
        }),
        ONCHAIN_PER_RPC_TIMEOUT_MS,
        `On-chain fetch timeout for chain ${config.chainId} via ${rpcUrl}`
      );

      const reserves = (humanized as any).reservesData ?? [];
      const chainData = new Map<string, OnchainReserveData>();

      for (const reserve of reserves) {
        const addr = normalizeAddress(String(reserve.underlyingAsset || ''));
        if (!addr) continue;

        const data: OnchainReserveData = {};

        if (reserve.deficit !== undefined && reserve.deficit !== null) {
          data.deficit = reserve.deficit?.toString?.() ?? String(reserve.deficit);
        }

        if (reserve.baseVariableBorrowRate !== undefined && reserve.baseVariableBorrowRate !== null) {
          const rayStr = reserve.baseVariableBorrowRate?.toString?.() ?? String(reserve.baseVariableBorrowRate);
          const pct = rayStringToPercent(rayStr);
          if (pct !== undefined) data.baseVariableBorrowRate = pct;
        }

        if (Object.keys(data).length > 0) {
          chainData.set(addr, data);
        }
      }

      poolCache.set(config.poolAddress, {
        data: chainData,
        updatedAt: Date.now(),
      });

      ethProviderService.reportProviderSuccess(config.chainId, rpcUrl);
      logger.debug(`On-chain fetch succeeded for ${config.poolAddress} via ${rpcUrl}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ethProviderService.reportProviderFailure(config.chainId, rpcUrl, message);
      logger.debug(`On-chain fetch failed for ${config.poolAddress} via ${rpcUrl}: ${message}`);
    }
  }

  logger.warn(`All RPC endpoints failed for ${config.poolAddress}, using cached data if available`);
  return false;
}

export async function refreshOnchainCache(): Promise<void> {
  if (refreshInProgress) {
    logger.debug('On-chain cache refresh already in progress, skipping');
    return;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      const poolAddrs = Array.from(POOL_CONFIGS.keys());

      logger.info(`🔗 Refreshing on-chain cache for ${poolAddrs.length} pools (concurrent, no overall timeout)...`);

      const results = await Promise.allSettled(
        poolAddrs.map((poolAddr) => {
          const config = POOL_CONFIGS.get(poolAddr);
          if (!config) return Promise.resolve(false);
          return fetchAndCacheChain(config);
        })
      );

      let successCount = 0;
      let failCount = 0;
      let totalReserves = 0;

      for (let i = 0; i < results.length; i++) {
        const poolAddr = poolAddrs[i];
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
          successCount++;
          const entry = poolCache.get(poolAddr);
          if (entry) totalReserves += entry.data.size;
        } else {
          failCount++;
        }
      }

      const elapsed = Date.now() - startTime;
      logger.info(`✅ On-chain cache refresh: ${totalReserves} reserves from ${successCount}/${poolAddrs.length} pools in ${elapsed}ms`);
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

export function getOnchainDataFromCache(): Map<string, OnchainReserveData> {
  const result = new Map<string, OnchainReserveData>();
  const now = Date.now();
  const ttl = BACKEND_CACHE_TTL_MS.onchainTtlMs;

  for (const [poolAddress, entry] of poolCache) {
    const age = now - entry.updatedAt;
    if (age >= ttl) continue;
    const config = POOL_CONFIGS.get(poolAddress);
    if (!config) continue;
    for (const [tokenAddr, data] of entry.data) {
      const reserveId = `${config.chainId}:${poolAddress}:${tokenAddr}`;
      result.set(reserveId, data);
    }
  }

  return result;
}

export function getOnchainCacheStatus(): {
  poolCount: number;
  reserveCount: number;
  freshPools: number;
  stalePools: number;
  oldestUpdateMs: number | null;
} {
  const now = Date.now();
  const ttl = BACKEND_CACHE_TTL_MS.onchainTtlMs;
  let freshPools = 0;
  let stalePools = 0;
  let reserveCount = 0;
  let oldestUpdate: number | null = null;

  for (const [, entry] of poolCache) {
    const age = now - entry.updatedAt;
    if (age < ttl) {
      freshPools++;
      reserveCount += entry.data.size;
    } else {
      stalePools++;
    }
    if (oldestUpdate === null || entry.updatedAt < oldestUpdate) {
      oldestUpdate = entry.updatedAt;
    }
  }

  return {
    poolCount: poolCache.size,
    reserveCount,
    freshPools,
    stalePools,
    oldestUpdateMs: oldestUpdate ? now - oldestUpdate : null,
  };
}

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

function apyRatioToAprPercent(apyRatio: number): number {
  if (!Number.isFinite(apyRatio) || apyRatio <= -1) return 0;
  const aprDecimal = SECONDS_PER_YEAR * (Math.pow(1 + apyRatio, 1 / SECONDS_PER_YEAR) - 1);
  return Number.isFinite(aprDecimal) && aprDecimal >= 0 ? aprDecimal * 100 : 0;
}

export function calculateBaseRateFallback(
  borrowApyRatio: number | null | undefined,
  utilizationPct: number | null | undefined,
  optimalUsageRate: number | undefined,
  variableRateSlope1: number | undefined,
  variableRateSlope2?: number
): number | null {
  if (borrowApyRatio === null || borrowApyRatio === undefined) {
    return null;
  }

  const borrowRatePct = apyRatioToAprPercent(borrowApyRatio);

  if (
    utilizationPct !== null &&
    utilizationPct !== undefined &&
    Number.isFinite(utilizationPct) &&
    optimalUsageRate !== undefined &&
    Number.isFinite(optimalUsageRate) &&
    variableRateSlope1 !== undefined &&
    Number.isFinite(variableRateSlope1)
  ) {
    if (utilizationPct <= optimalUsageRate && optimalUsageRate > 0) {
      const slope1Contribution = variableRateSlope1 * (utilizationPct / optimalUsageRate);
      const baseRate = borrowRatePct - slope1Contribution;
      if (baseRate >= 0) return baseRate;
    } else if (
      utilizationPct > optimalUsageRate &&
      variableRateSlope2 !== undefined &&
      Number.isFinite(variableRateSlope2)
    ) {
      const denom = 100 - optimalUsageRate;
      if (denom <= 0) return 0;
      const excessRatio = (utilizationPct - optimalUsageRate) / denom;
      const slope2Contribution = variableRateSlope2 * excessRatio;
      const baseRate = borrowRatePct - variableRateSlope1 - slope2Contribution;
      if (baseRate >= 0) return baseRate;
    }
  }

  return 0;
}