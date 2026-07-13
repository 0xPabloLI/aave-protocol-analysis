/**
 * Oracle Price Service - Fetches AaveOracle prices for V3 and V4 reserves
 *
 * Architecture:
 * - V3: 24 oracle instances across 14 independent chains (Ethereum has 4)
 * - V4: 10 spoke-level oracle instances on Ethereum only (per-spoke prices)
 * - Cron-write / API-read-only pattern (same as onchainDataService)
 * - Memory cache with 30s TTL (oracle prices update ~every block)
 * - Debug output: data/debug/oracle-prices.json
 */

import { Contract, providers, utils, BigNumber } from 'ethers';
import { providerPool, withTimeout } from '@internal/aave-rpc-infra';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { V3_ENTRIES, V4_SPOKE_ENTRIES } from './addressBookRegistry.js';
import { IPool_ABI } from '@aave-dao/aave-address-book/abis/IPool';
import { IAaveOracle_ABI } from '@aave-dao/aave-address-book/abis/IAaveOracle';
import { ISpokeV4_ABI } from '@aave-dao/aave-address-book/abis/ISpokeV4';
import { V4_ORACLE_PRICES_ABI } from '../abis/index.js';
import { spokeKey, v3PriceKey, v4PriceKey, fifoEvict } from '@internal/aave-shared-contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEBUG_FILE = resolve(REPO_ROOT, 'data', 'debug', 'oracle-prices.json');

const ORACLE_RPC_TIMEOUT_MS = 15_000;

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown,
): Promise<void> {
  const payload = JSON.stringify(value, replacer as (key: string, value: unknown) => unknown, 2);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, payload, 'utf-8');
  await rename(tempPath, filePath);
}

// ============================================================
// V3 Pool Configs (runtime-derived from address-book via registry)
// ============================================================
interface V3PoolConfig {
  poolKey: string;
  chainId: number;
  chainName: string;
  poolAddress: string;
  oracleAddress: string;
}

const CHAIN_NAME_BY_ID: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB',
  100: 'Gnosis',
  137: 'Polygon',
  146: 'Sonic',
  196: 'XLayer',
  324: 'zkSync',
  1088: 'Metis',
  1868: 'Soneium',
  4326: 'MegaETH',
  5000: 'Mantle',
  8453: 'Base',
  9745: 'Plasma',
  42161: 'Arbitrum',
  42220: 'Celo',
  43114: 'Avalanche',
  57073: 'Ink',
  59144: 'Linea',
  534352: 'Scroll',
  1666600000: 'Harmony',
};

const V3_POOL_CONFIGS: V3PoolConfig[] = V3_ENTRIES
  .filter((e) => !!e.oracleAddress)
  .map((e) => ({
    poolKey: e.poolKey,
    chainId: e.chainId,
    chainName: CHAIN_NAME_BY_ID[e.chainId] ?? `Chain${e.chainId}`,
    poolAddress: e.poolAddress,
    oracleAddress: e.oracleAddress!,
  }));

// ============================================================
// V4 Spoke Configs (runtime-derived from address-book via registry)
// spokeKey is the raw address-book key (e.g. MAIN_SPOKE) — used as spokeName.
// Multi-hub spokes (e.g. BLUECHIP_SPOKE) produce per-hub entries for onchain use,
// but oracle fetches per spoke — deduplicate by spokeAddress here.
// Non-market spokes (no oracle) are skipped with a warn log below.
// ============================================================
interface V4SpokeConfig {
  spokeName: string;
  chainId: number;
  chainName: string;
  spokeAddress: string;
  oracleAddress: string;
}

const V4_SPOKE_CONFIGS: V4SpokeConfig[] = (() => {
  const seen = new Set<string>();
  const result: V4SpokeConfig[] = [];
  for (const e of V4_SPOKE_ENTRIES) {
    if (!e.oracleAddress) {
      logger.warn(`Skipping V4 spoke ${e.spokeKey} (${e.spokeAddress}): no oracle address — non-market spoke (e.g. Treasury)`);
      continue;
    }
    // Deduplicate by spokeAddress: multi-hub spokes have same spokeAddress/oracleAddress
    if (seen.has(e.spokeAddress)) continue;
    seen.add(e.spokeAddress);
    result.push({
      spokeName: e.spokeKey,
      chainId: e.chainId,
      chainName: CHAIN_NAME_BY_ID[e.chainId] ?? `Chain${e.chainId}`,
      spokeAddress: e.spokeAddress,
      oracleAddress: e.oracleAddress,
    });
  }
  return result;
})();

// ============================================================
// Data Types
// ============================================================

export interface OraclePriceEntry {
  priceUsd: number;
}

export interface V3OraclePoolResult {
  poolKey: string;
  chainId: number;
  poolAddress: string;
  oracleAddress: string;
  assets: Record<string, OraclePriceEntry>; // key = assetAddress (lowercase)
}

export interface V4OracleSpokeResult {
  spokeName: string;
  chainId: number;
  spokeAddress: string;
  oracleAddress: string;
  reserves: Record<number, OraclePriceEntry>; // key = reserveId
  /** Mapping from reserveId (string) to underlying token address (lowercase) */
  reserveTokens: Record<string, string>;
}

export interface OraclePricesSnapshot {
  version: 'v3+v4';
  updatedAt: number;
  updatedAtISO: string;
  v3: V3OraclePoolResult[];
  v4: V4OracleSpokeResult[];
}

// ============================================================
// In-Memory Cache
// ============================================================

/** Full snapshot for debug output */
let cachedSnapshot: OraclePricesSnapshot | null = null;
/** Lean price lookup: "chainId:tokenAddr" → priceUsd (V3 + V4 merged) */
let leanPriceCache: Map<string, number> = new Map();
let leanPriceUpdatedAt = 0;
/** V4 reserveToken mapping cache: spokeKey → { tokens, updatedAt } (1h TTL) */
const V4_RESERVE_TOKEN_TTL_MS = 3_600_000; // 1 hour
const MAX_V4_RESERVE_TOKEN_ENTRIES = 100;
const MAX_LEAN_PRICE_ENTRIES = 500;
const V4_RESERVE_TOKEN_CACHE = new Map<string, { tokens: Record<string, string>; updatedAt: number }>();
let refreshInProgress: Promise<void> | null = null;

// ============================================================
// V3 Fetch
// ============================================================

async function fetchV3PoolPrices(
  config: V3PoolConfig,
  provider: providers.Provider,
): Promise<V3OraclePoolResult> {
  const poolContract = new Contract(config.poolAddress, IPool_ABI, provider);
  const oracleContract = new Contract(config.oracleAddress, IAaveOracle_ABI, provider);

  const assets: string[] = await withTimeout(
    poolContract.getReservesList(),
    ORACLE_RPC_TIMEOUT_MS,
    `V3 Pool getReservesList timeout for ${config.poolKey}`
  ) as string[];

  const rawPrices: string[] = (
    await withTimeout(
      oracleContract.getAssetsPrices(assets),
      ORACLE_RPC_TIMEOUT_MS,
      `V3 Oracle getAssetsPrices timeout for ${config.poolKey}`
    ) as BigNumber[]
  ).map((p) => p.toString());

  const priceMap: Record<string, OraclePriceEntry> = {};
  for (let i = 0; i < assets.length; i++) {
    const addr = assets[i].toLowerCase();
    const raw = rawPrices[i];
    priceMap[addr] = {
      priceUsd: Number(raw) / 1e8,
    };
  }

  return {
    poolKey: config.poolKey,
    chainId: config.chainId,
    poolAddress: config.poolAddress,
    oracleAddress: config.oracleAddress,
    assets: priceMap,
  };
}

// ============================================================
// V4 Fetch
// ============================================================

async function fetchV4SpokePrices(
  config: V4SpokeConfig,
  provider: providers.Provider,
): Promise<V4OracleSpokeResult> {
  const spokeContract = new Contract(config.spokeAddress, ISpokeV4_ABI, provider);
  const oracleContract = new Contract(config.oracleAddress, V4_ORACLE_PRICES_ABI, provider);

  const reserveCountBN = await withTimeout(
    spokeContract.getReserveCount(),
    ORACLE_RPC_TIMEOUT_MS,
    `V4 Spoke getReserveCount timeout for ${config.spokeName}`
  ) as BigNumber;

  const reserveCount = Number(reserveCountBN);
  if (reserveCount === 0) {
    return {
      spokeName: config.spokeName,
      chainId: config.chainId,
      spokeAddress: config.spokeAddress,
      oracleAddress: config.oracleAddress,
      reserves: {},
      reserveTokens: {},
    };
  }

  const reserveIds = Array.from({ length: reserveCount }, (_, i) => i);
  const rawPrices: string[] = (
    await withTimeout(
      oracleContract.getReservesPrices(reserveIds),
      ORACLE_RPC_TIMEOUT_MS,
      `V4 Oracle getReservesPrices timeout for ${config.spokeName}`
    ) as BigNumber[]
  ).map((p) => p.toString());

  const priceMap: Record<number, OraclePriceEntry> = {};
  for (let i = 0; i < reserveIds.length; i++) {
    const raw = rawPrices[i];
    priceMap[reserveIds[i]] = {
      priceUsd: Number(raw) / 1e8,
    };
  }

  // Reserve token mapping: use cached version if fresh, else fetch on-chain
  const spokeCacheKey = spokeKey(config.chainId, config.spokeAddress);
  const cachedMapping = V4_RESERVE_TOKEN_CACHE.get(spokeCacheKey);
  const now = Date.now();
  let reserveTokens: Record<string, string>;

  if (cachedMapping && (now - cachedMapping.updatedAt) < V4_RESERVE_TOKEN_TTL_MS) {
    reserveTokens = cachedMapping.tokens;
  } else {
    reserveTokens = {};
    const reserveResults = await Promise.allSettled(
      reserveIds.map((rid) =>
        withTimeout(
          spokeContract.getReserve(rid),
          ORACLE_RPC_TIMEOUT_MS,
          `V4 Spoke getReserve(${rid}) timeout for ${config.spokeName}`
        ) as Promise<utils.Result>
      )
    );
    reserveResults.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        reserveTokens[String(reserveIds[i])] = String(r.value.underlying ?? r.value[0]).toLowerCase();
      } else {
        logger.debug(`⚠️  Oracle V4: Failed to fetch reserve ${reserveIds[i]} details for ${config.spokeName}`);
      }
    });
    V4_RESERVE_TOKEN_CACHE.set(spokeCacheKey, { tokens: reserveTokens, updatedAt: now });
    for (const [k, v] of V4_RESERVE_TOKEN_CACHE) {
      if (now - v.updatedAt > 2 * V4_RESERVE_TOKEN_TTL_MS) {
        V4_RESERVE_TOKEN_CACHE.delete(k);
      }
    }
    fifoEvict(V4_RESERVE_TOKEN_CACHE, MAX_V4_RESERVE_TOKEN_ENTRIES);
  }

  return {
    spokeName: config.spokeName,
    chainId: config.chainId,
    spokeAddress: config.spokeAddress,
    oracleAddress: config.oracleAddress,
    reserves: priceMap,
    reserveTokens,
  };
}

// ============================================================
// Main Refresh
// ============================================================

export async function refreshOracleCache(): Promise<void> {
  if (refreshInProgress) {
    logger.debug('Oracle cache refresh already in progress, skipping');
    return;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();

      const v3Results: V3OraclePoolResult[] = [];
      const v4Results: V4OracleSpokeResult[] = [];

      // ============================================================
      // Fetch all V3 pools and V4 spokes in parallel, each with RPC retry
      // ============================================================

      async function fetchV3WithRetry(config: V3PoolConfig): Promise<V3OraclePoolResult | null> {
        try {
          const result = await providerPool.executeWithAutoRpc(
            config.chainId,
            { primary: (p: providers.Provider) => fetchV3PoolPrices(config, p) },
            { label: `Oracle V3:${config.poolKey}` },
          );
          if (!result) {
            logger.debug(`⏭️  Oracle V3: Skipping ${config.poolKey} (chain ${config.chainId}), no RPC URLs`);
            return null;
          }
          logger.debug(`✅ Oracle V3: ${config.poolKey} - ${Object.keys(result.assets).length} assets`);
          return result;
        } catch {
          logger.warn(`❌ Oracle V3: ${config.poolKey} failed on all RPC candidates`);
          return null;
        }
      }

      async function fetchV4WithRetry(config: V4SpokeConfig): Promise<V4OracleSpokeResult | null> {
        try {
          const result = await providerPool.executeWithAutoRpc(
            config.chainId,
            { primary: (p: providers.Provider) => fetchV4SpokePrices(config, p) },
            { label: `Oracle V4:${config.spokeName}` },
          );
          if (!result) {
            logger.debug(`⏭️  Oracle V4: Skipping ${config.spokeName} (chain ${config.chainId}), no RPC URLs`);
            return null;
          }
          logger.debug(`✅ Oracle V4: ${config.spokeName} - ${Object.keys(result.reserves).length} reserves`);
          return result;
        } catch {
          logger.warn(`❌ Oracle V4: ${config.spokeName} failed on all RPC candidates`);
          return null;
        }
      }

      const v3Settled = await Promise.allSettled(V3_POOL_CONFIGS.map(fetchV3WithRetry));
      for (const s of v3Settled) {
        if (s.status === 'fulfilled' && s.value) v3Results.push(s.value);
      }

      const v4Settled = await Promise.allSettled(V4_SPOKE_CONFIGS.map(fetchV4WithRetry));
      for (const s of v4Settled) {
        if (s.status === 'fulfilled' && s.value) v4Results.push(s.value);
      }

      const now = Date.now();
      cachedSnapshot = {
        version: 'v3+v4',
        updatedAt: now,
        updatedAtISO: new Date(now).toISOString(),
        v3: v3Results,
        v4: v4Results,
      };

      // Build lean price cache: "chainId:tokenAddr" → priceUsd
      const newLean = new Map<string, number>();
      for (const pool of v3Results) {
        for (const [addr, entry] of Object.entries(pool.assets)) {
          newLean.set(v3PriceKey(pool.chainId, addr), entry.priceUsd);
        }
      }
      for (const spoke of v4Results) {
        for (const [ridStr, tokenAddr] of Object.entries(spoke.reserveTokens)) {
          const entry = spoke.reserves[Number(ridStr)];
          if (entry) {
            newLean.set(v4PriceKey(spoke.chainId, spoke.spokeAddress, tokenAddr), entry.priceUsd);
          }
        }
      }
      leanPriceCache = newLean;
      leanPriceUpdatedAt = now;
      fifoEvict(leanPriceCache, MAX_LEAN_PRICE_ENTRIES);

      // Write debug file
      try {
        await writeJsonAtomic(DEBUG_FILE, cachedSnapshot, (_key: string, value: unknown) => {
          if (typeof value === 'bigint') return value.toString();
          return value;
        });
        logger.debug(`📄 Oracle prices written to ${DEBUG_FILE}`);
      } catch (fileError) {
        logger.warn(`⚠️  Failed to write oracle prices debug file: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
      }

      const elapsed = Date.now() - startTime;
      const totalV3Assets = v3Results.reduce((sum, r) => sum + Object.keys(r.assets).length, 0);
      const totalV4Reserves = v4Results.reduce((sum, r) => sum + Object.keys(r.reserves).length, 0);
      logger.info(`✅ Oracle cache refresh: ${v3Results.length} V3 pools (${totalV3Assets} assets), ${v4Results.length} V4 spokes (${totalV4Reserves} reserves) in ${elapsed}ms`);
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

// ============================================================
// Read Interface
// ============================================================

function isLeanCacheFresh(): boolean {
  if (!leanPriceUpdatedAt) return false;
  return (Date.now() - leanPriceUpdatedAt) < BACKEND_CACHE_TTL_MS.oracleTtlMs;
}

/** Get V3 token price by (chainId, tokenAddress), O(1). Returns undefined if stale or not found. */
export function getV3OraclePrice(chainId: number, tokenAddress: string): number | undefined {
  if (!isLeanCacheFresh()) return undefined;
  return leanPriceCache.get(v3PriceKey(chainId, tokenAddress));
}

/** Get V4 token price by (chainId, spokeAddress, tokenAddress), O(1). Returns undefined if stale or not found. */
export function getV4OraclePrice(chainId: number, spokeAddress: string, tokenAddress: string): number | undefined {
  if (!isLeanCacheFresh()) return undefined;
  return leanPriceCache.get(v4PriceKey(chainId, spokeAddress, tokenAddress));
}

/**
 * Returns the most recent full oracle snapshot, or null if not yet warmed.
 * Read-only — never triggers a refresh.
 */
export function getCachedOraclePricesSnapshot(): OraclePricesSnapshot | null {
  return cachedSnapshot;
}

export function getOracleCacheStats(): { leanPrice: number; v4ReserveToken: number } {
  return { leanPrice: leanPriceCache.size, v4ReserveToken: V4_RESERVE_TOKEN_CACHE.size };
}
