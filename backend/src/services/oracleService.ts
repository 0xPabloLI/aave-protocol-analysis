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

import { Contract, providers } from 'ethers';
import { getAaveRpcUrlsByChainId } from '@internal/aave-shared-config';
import { withTimeout } from '../lib/timeout.js';
import { ethProviderService } from './ethProviderService.js';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { SYNCED_V3_POOL_CONFIGS, SYNCED_V4_SPOKE_CONFIGS, type SyncedV3PoolConfig, type SyncedV4SpokeConfig } from '../generated/oracle-pool-configs.js';

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
  const payload = JSON.stringify(value, replacer as any, 2);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, payload, 'utf-8');
  await rename(tempPath, filePath);
}

// ============================================================
// V3 Pool ABI (minimal: getReservesList)
// ============================================================
const V3_POOL_ABI = [
  {
    inputs: [],
    name: 'getReservesList',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// ============================================================
// V3 Oracle ABI (minimal: getAssetsPrices)
// ============================================================
const V3_ORACLE_ABI = [
  {
    inputs: [{ internalType: 'address[]', name: 'assets', type: 'address[]' }],
    name: 'getAssetsPrices',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// ============================================================
// V4 Spoke ABI (minimal: getReserveCount + getReserve)
// ============================================================
const V4_SPOKE_ABI = [
  {
    inputs: [],
    name: 'getReserveCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'reserveId', type: 'uint256' }],
    name: 'getReserve',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'underlying', type: 'address' },
          { internalType: 'address', name: 'hub', type: 'address' },
          { internalType: 'uint16', name: 'assetId', type: 'uint16' },
          { internalType: 'uint8', name: 'decimals', type: 'uint8' },
          { internalType: 'uint24', name: 'collateralRisk', type: 'uint24' },
          { internalType: 'uint8', name: 'flags', type: 'uint8' },
          { internalType: 'uint32', name: 'dynamicConfigKey', type: 'uint32' },
        ],
        internalType: 'struct ISpoke.Reserve',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

// ============================================================
// V4 Oracle ABI (minimal: getReservesPrices)
// ============================================================
const V4_ORACLE_ABI = [
  {
    inputs: [{ internalType: 'uint256[]', name: 'reserveIds', type: 'uint256[]' }],
    name: 'getReservesPrices',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// ============================================================
// V3 Pool Configs (auto-synced from @aave-dao/aave-address-book)
// Run `npm run sync:oracle-pool-configs` to refresh.
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

const V3_POOL_CONFIGS: V3PoolConfig[] = SYNCED_V3_POOL_CONFIGS.map((c: SyncedV3PoolConfig): V3PoolConfig => ({
  poolKey: c.poolKey,
  chainId: c.chainId,
  chainName: CHAIN_NAME_BY_ID[c.chainId] ?? `Chain${c.chainId}`,
  poolAddress: c.poolAddress,
  oracleAddress: c.oracleAddress,
}));

// ============================================================
// V4 Spoke Configs (auto-synced from @aave-dao/aave-address-book)
// Run `npm run sync:oracle-pool-configs` to refresh.
// Horizons/Treasury overridden manually — oracle not in address book.
// ============================================================
interface V4SpokeConfig {
  spokeName: string;
  chainId: number;
  chainName: string;
  spokeAddress: string;
  oracleAddress: string;
}

const SPOKE_NAME_MAP: Record<string, string> = {
  BLUECHIP: 'Bluechip',
  ETHENACORRELATED: 'Ethena',
  ETHENAECOSYSTEM: 'EthenaEcosystem',
  ETHERFI: 'EtherFi',
  FOREX: 'Forex',
  GOLD: 'Gold',
  KELP: 'Kelp',
  LIDO: 'Lido',
  LOMBARDBTC: 'Lombard',
  MAIN: 'Main',
};

const V4_SPOKE_CONFIGS: V4SpokeConfig[] = [
  ...SYNCED_V4_SPOKE_CONFIGS.map((c: SyncedV4SpokeConfig): V4SpokeConfig => ({
    spokeName: SPOKE_NAME_MAP[c.spokeName] ?? c.spokeName,
    chainId: c.chainId,
    chainName: CHAIN_NAME_BY_ID[c.chainId] ?? `Chain${c.chainId}`,
    spokeAddress: c.spokeAddress,
    oracleAddress: c.oracleAddress,
  })),
  // Manual override — TREASURY_SPOKE (Horizons) oracle not in address book
  { spokeName: 'Horizons', chainId: 1, chainName: 'Ethereum', spokeAddress: '0xb9b0b8616f6bf6841972a52058132be08d723155', oracleAddress: '0x3a0Eb5E08d2e8337C2972dA8EAcF5a7e74A187C6' },
];

// ============================================================
// Data Types
// ============================================================

export interface OraclePriceEntry {
  rawPrice: string;
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
const V4_RESERVE_TOKEN_CACHE = new Map<string, { tokens: Record<string, string>; updatedAt: number }>();
let refreshInProgress: Promise<void> | null = null;

// ============================================================
// V3 Fetch
// ============================================================

async function fetchV3PoolPrices(
  config: V3PoolConfig,
  provider: providers.Provider,
  rpcUrl: string
): Promise<V3OraclePoolResult> {
  const poolContract = new Contract(config.poolAddress, V3_POOL_ABI, provider);
  const oracleContract = new Contract(config.oracleAddress, V3_ORACLE_ABI, provider);

  const assets: string[] = await withTimeout(
    poolContract.getReservesList(),
    ORACLE_RPC_TIMEOUT_MS,
    `V3 Pool getReservesList timeout for ${config.poolKey} via ${rpcUrl}`
  ) as string[];

  const rawPrices: string[] = (
    await withTimeout(
      oracleContract.getAssetsPrices(assets),
      ORACLE_RPC_TIMEOUT_MS,
      `V3 Oracle getAssetsPrices timeout for ${config.poolKey} via ${rpcUrl}`
    ) as any[]
  ).map((p: any) => p.toString());

  const priceMap: Record<string, OraclePriceEntry> = {};
  for (let i = 0; i < assets.length; i++) {
    const addr = assets[i].toLowerCase();
    const raw = rawPrices[i];
    priceMap[addr] = {
      rawPrice: raw,
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
  rpcUrl: string
): Promise<V4OracleSpokeResult> {
  const spokeContract = new Contract(config.spokeAddress, V4_SPOKE_ABI, provider);
  const oracleContract = new Contract(config.oracleAddress, V4_ORACLE_ABI, provider);

  const reserveCountBN = await withTimeout(
    spokeContract.getReserveCount(),
    ORACLE_RPC_TIMEOUT_MS,
    `V4 Spoke getReserveCount timeout for ${config.spokeName} via ${rpcUrl}`
  ) as any;

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
      `V4 Oracle getReservesPrices timeout for ${config.spokeName} via ${rpcUrl}`
    ) as any[]
  ).map((p: any) => p.toString());

  const priceMap: Record<number, OraclePriceEntry> = {};
  for (let i = 0; i < reserveIds.length; i++) {
    const raw = rawPrices[i];
    priceMap[reserveIds[i]] = {
      rawPrice: raw,
      priceUsd: Number(raw) / 1e8,
    };
  }

  // Reserve token mapping: use cached version if fresh, else fetch on-chain
  const spokeKey = `${config.chainId}:${config.spokeAddress.toLowerCase()}`;
  const cachedMapping = V4_RESERVE_TOKEN_CACHE.get(spokeKey);
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
        ) as any
      )
    );
    reserveResults.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        reserveTokens[String(reserveIds[i])] = (r.value.underlying as string).toLowerCase();
      } else {
        logger.debug(`⚠️  Oracle V4: Failed to fetch reserve ${reserveIds[i]} details for ${config.spokeName}`);
      }
    });
    V4_RESERVE_TOKEN_CACHE.set(spokeKey, { tokens: reserveTokens, updatedAt: now });
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
        const rpcUrls = getAaveRpcUrlsByChainId(config.chainId);
        if (rpcUrls.length === 0) {
          logger.debug(`⏭️  Oracle V3: Skipping ${config.poolKey} (chain ${config.chainId}), no RPC URLs`);
          return null;
        }
        const candidates = ethProviderService.getProvidersForChain(config.chainId, rpcUrls);
        if (candidates.length === 0) {
          logger.warn(`⏭️  Oracle V3: Skipping ${config.poolKey} (chain ${config.chainId}), no healthy RPC`);
          return null;
        }
        for (const candidate of candidates) {
          try {
            const result = await fetchV3PoolPrices(config, candidate.provider, candidate.rpcUrl);
            ethProviderService.reportProviderSuccess(config.chainId, candidate.rpcUrl);
            logger.debug(`✅ Oracle V3: ${config.poolKey} - ${Object.keys(result.assets).length} assets via ${candidate.rpcUrl}`);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ethProviderService.reportProviderFailure(config.chainId, candidate.rpcUrl, message);
            logger.warn(`❌ Oracle V3: ${config.poolKey} failed via ${candidate.rpcUrl}: ${message}`);
          }
        }
        logger.warn(`❌ Oracle V3: ${config.poolKey} failed on all RPC candidates`);
        return null;
      }

      async function fetchV4WithRetry(config: V4SpokeConfig): Promise<V4OracleSpokeResult | null> {
        const rpcUrls = getAaveRpcUrlsByChainId(config.chainId);
        if (rpcUrls.length === 0) {
          logger.debug(`⏭️  Oracle V4: Skipping ${config.spokeName} (chain ${config.chainId}), no RPC URLs`);
          return null;
        }
        const candidates = ethProviderService.getProvidersForChain(config.chainId, rpcUrls);
        if (candidates.length === 0) {
          logger.warn(`⏭️  Oracle V4: Skipping ${config.spokeName} (chain ${config.chainId}), no healthy RPC`);
          return null;
        }
        for (const candidate of candidates) {
          try {
            const result = await fetchV4SpokePrices(config, candidate.provider, candidate.rpcUrl);
            ethProviderService.reportProviderSuccess(config.chainId, candidate.rpcUrl);
            logger.debug(`✅ Oracle V4: ${config.spokeName} - ${Object.keys(result.reserves).length} reserves via ${candidate.rpcUrl}`);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ethProviderService.reportProviderFailure(config.chainId, candidate.rpcUrl, message);
            logger.warn(`❌ Oracle V4: ${config.spokeName} failed via ${candidate.rpcUrl}: ${message}`);
          }
        }
        logger.warn(`❌ Oracle V4: ${config.spokeName} failed on all RPC candidates`);
        return null;
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
          newLean.set(`${pool.chainId}:${addr}`, entry.priceUsd);
        }
      }
      for (const spoke of v4Results) {
        for (const [ridStr, tokenAddr] of Object.entries(spoke.reserveTokens)) {
          const entry = spoke.reserves[Number(ridStr)];
          if (entry) {
            newLean.set(`${spoke.chainId}:${spoke.spokeAddress.toLowerCase()}:${tokenAddr}`, entry.priceUsd);
          }
        }
      }
      leanPriceCache = newLean;
      leanPriceUpdatedAt = now;

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
  return leanPriceCache.get(`${chainId}:${tokenAddress.toLowerCase()}`);
}

/** Get V4 token price by (chainId, spokeAddress, tokenAddress), O(1). Returns undefined if stale or not found. */
export function getV4OraclePrice(chainId: number, spokeAddress: string, tokenAddress: string): number | undefined {
  if (!isLeanCacheFresh()) return undefined;
  return leanPriceCache.get(`${chainId}:${spokeAddress.toLowerCase()}:${tokenAddress.toLowerCase()}`);
}

/**
 * Returns the most recent full oracle snapshot, or null if not yet warmed.
 * Read-only — never triggers a refresh.
 */
export function getCachedOraclePricesSnapshot(): OraclePricesSnapshot | null {
  return cachedSnapshot;
}
