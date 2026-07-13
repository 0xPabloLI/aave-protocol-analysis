import { COINGECKO_PLATFORM_BY_CHAIN_ID_SYNCED } from './generated/coingecko-platform-by-chain-id.js';
import { toFiniteNumber } from './utils/number.js';
import { fifoEvict } from '@internal/aave-shared-contracts';

type AssetPlatform = { id?: string; chain_identifier?: number | null };

interface ResolveTokenPriceWithBackupParams {
  chainId: number;
  tokenAddress?: string;
  tokenSymbol?: string;
  snapshotPrice?: unknown;
}

export type UsdPriceSource = 'snapshot' | 'reserve' | 'coingecko' | 'missing';

interface ResolveUsdPriceWithPriorityParams {
  chainId: number;
  tokenAddress?: string;
  tokenSymbol?: string;
  snapshotPrice?: unknown;
  reservePrice?: number;
}

const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';
const COINGECKO_PLATFORM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Use only when synced map or live /asset_platforms is wrong for `simple/token_price/{platform}`. */
const COINGECKO_PLATFORM_BY_CHAIN_ID_OVERRIDES: Partial<Record<number, string>> = {};
const COINGECKO_COIN_ID_BY_SYMBOL: Record<string, string> = {
  usdt: 'tether',
  usdc: 'usd-coin',
  dai: 'dai',
  gho: 'gho',
  pyusd: 'paypal-usd',
  usde: 'ethena-usde',
  susde: 'ethena-staked-usde',
  usds: 'usds',
  eth: 'ethereum',
  weth: 'weth',
  btc: 'bitcoin',
  wbtc: 'wrapped-bitcoin',
  eurc: 'euro-coin',
};

let coingeckoPlatformCache:
  | {
      map: Map<number, string>;
      expiresAt: number;
    }
  | null = null;

let coingeckoPlatformInFlight: Promise<Map<number, string>> | null = null;

const COINGECKO_SUCCESS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const COINGECKO_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_TOKEN_PRICE_CACHE_ENTRIES = 2000;

type TokenPriceCacheEntry = {
  value: number | undefined;
  expiresAt: number;
};

// Memoize resolved prices (including short-lived "undefined" failures) per chain/address/symbol key.
const tokenPriceResolveCache = new Map<string, TokenPriceCacheEntry>();

// In-flight de-dupe: concurrent requests for the same key share one promise.
const tokenPriceResolveInFlight = new Map<string, Promise<number | undefined>>();

function pruneTokenPriceCache(now: number): void {
  for (const [key, entry] of tokenPriceResolveCache.entries()) {
    if (entry.expiresAt <= now) {
      tokenPriceResolveCache.delete(key);
    }
  }
  fifoEvict(tokenPriceResolveCache, MAX_TOKEN_PRICE_CACHE_ENTRIES);
}

async function getCoingeckoAssetPlatformMap(forceRefresh = false): Promise<Map<number, string>> {
  const now = Date.now();
  if (!forceRefresh && coingeckoPlatformCache && coingeckoPlatformCache.expiresAt > now) {
    return coingeckoPlatformCache.map;
  }

  if (!forceRefresh && coingeckoPlatformInFlight) {
    return coingeckoPlatformInFlight;
  }

  const promise = (async (): Promise<Map<number, string>> => {
    const response = await fetch(`${COINGECKO_API_BASE}/asset_platforms`);
    if (!response.ok) {
      throw new Error(`CoinGecko /asset_platforms failed (${response.status})`);
    }

    const payload = (await response.json()) as AssetPlatform[];
    const map = new Map<number, string>();
    if (Array.isArray(payload)) {
      payload.forEach((item) => {
        const chainId = item.chain_identifier;
        const platformId = item.id;
        if (
          typeof chainId === 'number' &&
          Number.isFinite(chainId) &&
          chainId > 0 &&
          typeof platformId === 'string' &&
          platformId.trim() !== ''
        ) {
          map.set(chainId, platformId);
        }
      });
    }

    coingeckoPlatformCache = {
      map,
      expiresAt: Date.now() + COINGECKO_PLATFORM_CACHE_TTL_MS,
    };
    return map;
  })();

  coingeckoPlatformInFlight = promise;
  try {
    return await promise;
  } finally {
    coingeckoPlatformInFlight = null;
  }
}

function resolveCoingeckoPlatformId(chainId: number, map: Map<number, string>): string | undefined {
  return (
    COINGECKO_PLATFORM_BY_CHAIN_ID_OVERRIDES[chainId] ??
    COINGECKO_PLATFORM_BY_CHAIN_ID_SYNCED[chainId] ??
    map.get(chainId)
  );
}

type PendingBatch = {
  addresses: Set<string>;
  listeners: Map<string, Array<(price: number | undefined) => void>>;
  timer: ReturnType<typeof setTimeout> | null;
};

const pendingBatches = new Map<string, PendingBatch>();

function flushBatch(platformId: string, batch: PendingBatch): void {
  if (batch.timer !== null) {
    clearTimeout(batch.timer);
    batch.timer = null;
  }
  pendingBatches.delete(platformId);

  const addresses = Array.from(batch.addresses);
  if (addresses.length === 0) {
    for (const [, cbs] of batch.listeners) for (const cb of cbs) cb(undefined);
    return;
  }

  const url =
    `${COINGECKO_API_BASE}/simple/token_price/${platformId}` +
    `?contract_addresses=${encodeURIComponent(addresses.join(','))}` +
    `&vs_currencies=usd`;

  fetch(url)
    .then((response) => {
      if (!response.ok) return {} as Record<string, { usd?: number }>;
      return response.json() as Promise<Record<string, { usd?: number }>>;
    })
    .then((payload) => {
      const results: Record<string, number | undefined> = {};
      for (const addr of addresses) {
        const hit = payload[addr];
        const usd = hit?.usd;
        results[addr] = typeof usd === 'number' && Number.isFinite(usd) ? usd : undefined;
      }
      for (const [addr, cbs] of batch.listeners) {
        const price = results[addr];
        for (const cb of cbs) cb(price);
      }
    })
    .catch(() => {
      for (const [, cbs] of batch.listeners) for (const cb of cbs) cb(undefined);
    });
}

function joinBatch(platformId: string, normalizedAddress: string): Promise<number | undefined> {
  let batch = pendingBatches.get(platformId);
  if (!batch) {
    batch = { addresses: new Set(), listeners: new Map(), timer: null };
    pendingBatches.set(platformId, batch);
  }

  batch.addresses.add(normalizedAddress);

  const price = new Promise<number | undefined>((resolve) => {
    const cbs = batch!.listeners.get(normalizedAddress) ?? [];
    cbs.push(resolve);
    batch!.listeners.set(normalizedAddress, cbs);

    if (batch!.timer === null) {
      batch!.timer = setTimeout(() => {
        const current = pendingBatches.get(platformId);
        if (current) flushBatch(platformId, current);
      }, 0);
    }
  });

  return price;
}

async function fetchCoingeckoTokenPriceUsd(chainId: number, tokenAddress: string): Promise<number | undefined> {
  if (!isValidEvmAddress(tokenAddress)) return undefined;

  const normalizedAddress = tokenAddress.toLowerCase();

  const cachedPlatformId = resolveCoingeckoPlatformId(chainId, coingeckoPlatformCache?.map ?? new Map());
  if (cachedPlatformId) {
    return joinBatch(cachedPlatformId, normalizedAddress);
  }

  const platformMap = await getCoingeckoAssetPlatformMap(false);
  let platformId = resolveCoingeckoPlatformId(chainId, platformMap);
  if (!platformId) {
    const refreshed = await getCoingeckoAssetPlatformMap(true);
    platformId = resolveCoingeckoPlatformId(chainId, refreshed);
  }
  if (!platformId) return undefined;

  return joinBatch(platformId, normalizedAddress);
}

async function fetchCoingeckoCoinPriceBySymbolUsd(symbol?: string): Promise<number | undefined> {
  if (!symbol) return undefined;
  const coinId = COINGECKO_COIN_ID_BY_SYMBOL[symbol.trim().toLowerCase()];
  if (!coinId) return undefined;

  const url = `${COINGECKO_API_BASE}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`;
  const response = await fetch(url);
  if (!response.ok) return undefined;

  const payload = (await response.json()) as Record<string, { usd?: number }>;
  const usd = payload?.[coinId]?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : undefined;
}

function isValidEvmAddress(address: string): boolean {
  // Strict hex 20-byte check (EVM style).
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export async function resolveTokenPriceWithBackup({
  chainId,
  tokenAddress,
  tokenSymbol,
  snapshotPrice,
}: ResolveTokenPriceWithBackupParams): Promise<number | undefined> {
  const normalizedSnapshotPrice = toFiniteNumber(snapshotPrice);
  if (normalizedSnapshotPrice !== null) {
    return normalizedSnapshotPrice;
  }

  const rawNormalizedAddress = tokenAddress?.trim().toLowerCase() ?? '';
  // If invalid, skip contract-based lookup and fall back to symbol-based lookup.
  const normalizedAddress = isValidEvmAddress(rawNormalizedAddress) ? rawNormalizedAddress : '';
  const normalizedSymbol = tokenSymbol?.trim().toLowerCase() ?? '';
  const cacheKey = `${chainId}:${normalizedAddress}:${normalizedSymbol}`;
  const now = Date.now();
  const existing = tokenPriceResolveCache.get(cacheKey);
  if (existing && existing.expiresAt > now) {
    return existing.value;
  }
  if (existing) tokenPriceResolveCache.delete(cacheKey);

  const inFlight = tokenPriceResolveInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async (): Promise<number | undefined> => {
    let resolvedPrice: number | undefined;
    let contractPrice: number | undefined;
    if (normalizedAddress) {
      try {
        contractPrice = await fetchCoingeckoTokenPriceUsd(chainId, normalizedAddress);
      } catch {
        // Contract lookup errors should not block symbol fallback.
        contractPrice = undefined;
      }
    }

    if (contractPrice !== undefined) {
      resolvedPrice = contractPrice;
    } else {
      try {
        resolvedPrice = await fetchCoingeckoCoinPriceBySymbolUsd(tokenSymbol);
      } catch {
        // Treat transient provider/network errors as a short-lived miss.
        resolvedPrice = undefined;
      }
    }

    const cacheTtlMs =
      resolvedPrice === undefined ? COINGECKO_FAILURE_CACHE_TTL_MS : COINGECKO_SUCCESS_CACHE_TTL_MS;
    const expiresAt = Date.now() + cacheTtlMs;
    pruneTokenPriceCache(Date.now());

    tokenPriceResolveCache.set(cacheKey, {
      value: resolvedPrice,
      expiresAt,
    });

    return resolvedPrice;
  })();

  tokenPriceResolveInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    tokenPriceResolveInFlight.delete(cacheKey);
  }
}

export async function resolveUsdPriceWithPriority({
  chainId,
  tokenAddress,
  tokenSymbol,
  snapshotPrice,
  reservePrice,
}: ResolveUsdPriceWithPriorityParams): Promise<{ price?: number; source: UsdPriceSource }> {
  const normalizedSnapshot = toFiniteNumber(snapshotPrice);
  if (normalizedSnapshot !== null && normalizedSnapshot > 0) {
    return { price: normalizedSnapshot, source: 'snapshot' };
  }

  if (typeof reservePrice === 'number' && Number.isFinite(reservePrice) && reservePrice > 0) {
    return { price: reservePrice, source: 'reserve' };
  }

  const coingeckoPrice = await resolveTokenPriceWithBackup({
    chainId,
    tokenAddress,
    tokenSymbol,
    snapshotPrice: undefined,
  });

  if (coingeckoPrice !== undefined && coingeckoPrice > 0) {
    return { price: coingeckoPrice, source: 'coingecko' };
  }
  return { source: 'missing' };
}

export function getTokenPriceCacheStats(): { priceCache: number; inFlight: number; platformCache: boolean } {
  return {
    priceCache: tokenPriceResolveCache.size,
    inFlight: tokenPriceResolveInFlight.size,
    platformCache: coingeckoPlatformCache !== null,
  };
}
