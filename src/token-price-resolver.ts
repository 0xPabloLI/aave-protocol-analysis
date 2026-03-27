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
const HARDCODED_PLATFORM_BY_CHAIN_ID: Record<number, string> = {
  1: 'ethereum',
  10: 'optimistic-ethereum',
  56: 'binance-smart-chain',
  100: 'xdai',
  137: 'polygon-pos',
  146: 'sonic',
  250: 'fantom',
  324: 'zksync',
  8453: 'base',
  42161: 'arbitrum-one',
  43114: 'avalanche',
  59144: 'linea',
  534352: 'scroll',
};
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
  while (tokenPriceResolveCache.size > MAX_TOKEN_PRICE_CACHE_ENTRIES) {
    const oldestKey = tokenPriceResolveCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    tokenPriceResolveCache.delete(oldestKey);
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    const maybeValue = (value as { value?: unknown }).value;
    if (maybeValue !== undefined) return toFiniteNumber(maybeValue);
  }
  return null;
}

async function getCoingeckoAssetPlatformMap(forceRefresh = false): Promise<Map<number, string>> {
  const now = Date.now();
  if (!forceRefresh && coingeckoPlatformCache && coingeckoPlatformCache.expiresAt > now) {
    return coingeckoPlatformCache.map;
  }

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
    expiresAt: now + COINGECKO_PLATFORM_CACHE_TTL_MS,
  };
  return map;
}

function resolveCoingeckoPlatformId(chainId: number, map: Map<number, string>): string | undefined {
  return HARDCODED_PLATFORM_BY_CHAIN_ID[chainId] ?? map.get(chainId);
}

async function fetchCoingeckoTokenPriceUsd(chainId: number, tokenAddress: string): Promise<number | undefined> {
  if (!isValidEvmAddress(tokenAddress)) return undefined;

  const normalizedAddress = tokenAddress.toLowerCase();
  const platformMap = await getCoingeckoAssetPlatformMap(false);
  let platformId = resolveCoingeckoPlatformId(chainId, platformMap);
  if (!platformId) {
    const refreshed = await getCoingeckoAssetPlatformMap(true);
    platformId = resolveCoingeckoPlatformId(chainId, refreshed);
  }
  if (!platformId) return undefined;

  const tokenPriceUrl =
    `${COINGECKO_API_BASE}/simple/token_price/${platformId}` +
    `?contract_addresses=${encodeURIComponent(normalizedAddress)}` +
    `&vs_currencies=usd`;
  const response = await fetch(tokenPriceUrl);
  if (!response.ok) return undefined;

  const payload = (await response.json()) as Record<string, { usd?: number }>;
  if (!payload || typeof payload !== 'object') return undefined;
  const hit = payload[normalizedAddress] ?? payload[Object.keys(payload)[0] ?? ''];
  const usd = hit?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : undefined;
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
    try {
      const contractPrice = normalizedAddress
        ? await fetchCoingeckoTokenPriceUsd(chainId, normalizedAddress)
        : undefined;
      const symbolPrice = await fetchCoingeckoCoinPriceBySymbolUsd(tokenSymbol);
      resolvedPrice = contractPrice ?? symbolPrice;
    } catch {
      // Treat transient provider/network errors as a short-lived miss.
      resolvedPrice = undefined;
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
