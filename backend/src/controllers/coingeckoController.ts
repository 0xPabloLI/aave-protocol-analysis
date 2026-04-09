import { logger } from '../logger.js';
import { coingeckoFetchConfig } from '../config.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';

const CG_ENDPOINT = 'https://api.coingecko.com/api/v3/coins/markets';
const CMC_QUOTES_ENDPOINT = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
const COINGECKO_LONG_DATA_TTL_MS = BACKEND_CACHE_TTL_MS.coingeckoLongDataTtlMs;
const CATEGORIES_CACHE_TTL_MS = COINGECKO_LONG_DATA_TTL_MS;
/** Matches FDV warm cron interval (5 min); cron and request both respect this TTL. */
const FDV_CACHE_TTL_MS = BACKEND_CACHE_TTL_MS.coingeckoFdv;
const FDV_MONITOR_TTL_MS = COINGECKO_LONG_DATA_TTL_MS;
const FDV_DIFF_ALERT_THRESHOLD_PCT = 5;
const CATEGORIES_MAX_SERVE_STALE_MS = (() => {
  const raw = process.env.COINGECKO_CATEGORIES_MAX_SERVE_STALE_MS;
  const fallback = Math.max(CATEGORIES_CACHE_TTL_MS * 3, 30 * 60 * 1000);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
})();
const FDV_MAX_SERVE_STALE_MS = (() => {
  const raw = process.env.COINGECKO_FDV_MAX_SERVE_STALE_MS;
  const fallback = Math.max(FDV_CACHE_TTL_MS * 3, 30 * 60 * 1000);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
})();
const FDV_COINS = [
  { id: 'crypto-com-chain', cmcSymbol: 'CRO' },
  { id: 'gatechain-token', cmcSymbol: 'GT' },
  { id: 'okb', cmcSymbol: 'OKB' },
  { id: 'mantle', cmcSymbol: 'MNT' },
  { id: 'bitget-token', cmcSymbol: 'BGB' },
  { id: 'binancecoin', cmcSymbol: 'BNB' },
] as const;

type FdvSource = 'coinmarketcap' | 'coingecko_fallback';

interface FdvItem {
  id: string;
  symbol: string | null;
  name: string | null;
  fdvUsd: number | null;
  source: FdvSource;
}

interface CoinGeckoCoin {
  id: string;
  symbol: string;
}

interface CoinGeckoMarket {
  id: string;
  symbol: string;
  name: string;
  fully_diluted_valuation: number | null;
}

interface CoinMarketCapQuote {
  symbol: string;
  name: string;
  quote?: {
    USD?: {
      fully_diluted_market_cap?: number | null;
    };
  };
}

interface CoinMarketCapQuotesResponse {
  status?: {
    error_code?: number;
    error_message?: string | null;
  };
  data?: Record<string, CoinMarketCapQuote | CoinMarketCapQuote[]>;
}

export interface CoingeckoCategoriesData {
  uniqueSymbolsStablecoins: string[];
  uniqueSymbolsEth: string[];
}

let cachedResponse: { data: { uniqueSymbolsStablecoins: string[]; uniqueSymbolsEth: string[] }; fetchedAt: number } | null =
  null;
let cachedFdvResponse: {
  data: { items: FdvItem[]; fetchedAt: string };
  fetchedAt: number;
} | null = null;
// 跟踪正在进行的 fetch，防止并发请求触发重复的 API 调用
let inFlightFetch: Promise<{ uniqueSymbolsStablecoins: string[]; uniqueSymbolsEth: string[] }> | null = null;
let inFlightFdvFetch: Promise<{ items: FdvItem[]; fetchedAt: string }> | null = null;
// 跟踪最后一次 API 请求的时间，用于 rate limit 控制（Free tier: 30 次/分钟 = 每 2 秒一次）
let lastApiRequestTime: number = 0;
let lastFdvMonitorCheckTime = 0;

function isWithinMaxServeStale(fetchedAt: number, maxStaleMs: number): boolean {
  const ageMs = Math.max(0, Date.now() - fetchedAt);
  return ageMs <= maxStaleMs;
}

const getHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = process.env.COINGECKO_API_KEY;
  if (apiKey) {
    headers['x-cg-demo-api-key'] = apiKey;
  }
  return headers;
};

const getCoinMarketCapHeaders = (): Record<string, string> => {
  const apiKey = process.env.COINMARKETCAP_API_KEY;
  if (!apiKey) {
    throw new Error('COINMARKETCAP_API_KEY is missing');
  }
  return {
    Accept: 'application/json',
    'X-CMC_PRO_API_KEY': apiKey,
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  const retryableCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETRESET', 'ECONNREFUSED']);
  const code = (error as any)?.code || (error as any)?.cause?.code;
  return Boolean(code && retryableCodes.has(String(code)));
}

/**
 * 获取 Retry-After 等待时间（毫秒）
 * 优先使用响应头中的 Retry-After，否则使用配置的最小等待时间
 */
function getRetryAfterMs(response: globalThis.Response): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  // 如果没有 Retry-After header，使用配置的最小等待时间
  return coingeckoFetchConfig.rateLimitMinWaitSeconds * 1000;
}

/**
 * 带重试机制的 CoinGecko API 请求
 * 处理 429 (Rate Limit) 和 5xx 错误，使用指数退避
 */
async function fetchJsonWithRetry<T>(
  url: string,
  label: string
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  const headers = getHeaders();

  while (attempt <= coingeckoFetchConfig.maxRetries) {
    try {
      const response = await fetch(url, { method: 'GET', headers });

      if (response.ok) {
        // 必须 await JSON 解析，以便解析错误能被 try-catch 捕获并触发重试
        return await response.json();
      }

      // 处理 429 Rate Limit 错误
      if (response.status === 429) {
        if (attempt < coingeckoFetchConfig.maxRetries) {
          const waitMs = getRetryAfterMs(response);
          logger.warn(
            `⚠️ CoinGecko ${label} rate limited (429), waiting ${Math.round(waitMs / 1000)}s before retry (attempt ${attempt + 1}/${coingeckoFetchConfig.maxRetries})`
          );
          await sleep(waitMs);
          attempt++;
          continue;
        }
        // 最后一次重试也失败，抛出错误
        throw new Error(`CoinGecko rate limit exceeded after ${coingeckoFetchConfig.maxRetries} retries`);
      }

      // 处理 5xx 服务器错误（可重试）
      if (response.status >= 500 && response.status < 600 && attempt < coingeckoFetchConfig.maxRetries) {
        const delay = Math.min(
          coingeckoFetchConfig.maxDelayMs,
          coingeckoFetchConfig.baseDelayMs * Math.pow(2, attempt)
        ) + Math.random() * 250; // 添加随机抖动避免雷群效应
        logger.warn(
          `⚠️ CoinGecko ${label} HTTP ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${coingeckoFetchConfig.maxRetries})`
        );
        await sleep(delay);
        attempt++;
        continue;
      }

      // 其他 HTTP 错误（4xx 等）不重试
      throw new Error(`CoinGecko request failed: ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;

      // 如果是网络错误且可重试
      if (isRetryableError(error) && attempt < coingeckoFetchConfig.maxRetries) {
        const delay = Math.min(
          coingeckoFetchConfig.maxDelayMs,
          coingeckoFetchConfig.baseDelayMs * Math.pow(2, attempt)
        ) + Math.random() * 250;
        logger.warn(
          `⚠️ CoinGecko ${label} network error (${(error as Error).message}), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${coingeckoFetchConfig.maxRetries})`
        );
        await sleep(delay);
        attempt++;
        continue;
      }

      // 不可重试的错误或已达到最大重试次数
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// 保持向后兼容的简单函数（内部使用重试版本）
const fetchCategoryPageWithRetry = async (url: string, label: string): Promise<CoinGeckoCoin[]> => {
  return fetchJsonWithRetry<CoinGeckoCoin[]>(url, label);
};

const fetchMarkets = async (url: string, label: string): Promise<CoinGeckoMarket[]> => {
  return fetchJsonWithRetry<CoinGeckoMarket[]>(url, label);
};

async function waitForCoingeckoRateLimit(): Promise<void> {
  const minIntervalMs = coingeckoFetchConfig.minRequestIntervalMs;
  const now = Date.now();
  const timeSinceLastRequest = now - lastApiRequestTime;
  if (timeSinceLastRequest < minIntervalMs) {
    const waitMs = minIntervalMs - timeSinceLastRequest;
    logger.debug(`⏳ CoinGecko rate limit: waiting ${waitMs}ms before next request`);
    await sleep(waitMs);
  }
  lastApiRequestTime = Date.now();
}

async function fetchCoingeckoFdvItems(source: FdvSource): Promise<FdvItem[]> {
  await waitForCoingeckoRateLimit();
  const idsParam = encodeURIComponent(FDV_COINS.map((coin) => coin.id).join(','));
  const url = `${CG_ENDPOINT}?vs_currency=usd&ids=${idsParam}&per_page=250&page=1`;
  const markets = await fetchMarkets(url, 'fdv-coins');
  const marketById = new Map(markets.map((coin) => [coin.id, coin]));

  return FDV_COINS.map(({ id }) => {
    const coin = marketById.get(id);
    return {
      id,
      symbol: coin?.symbol?.toUpperCase() ?? null,
      name: coin?.name ?? null,
      fdvUsd: coin?.fully_diluted_valuation ?? null,
      source,
    };
  });
}

function normalizeCmcQuote(quote: CoinMarketCapQuote | CoinMarketCapQuote[] | undefined): CoinMarketCapQuote | null {
  if (!quote) {
    return null;
  }
  if (Array.isArray(quote)) {
    return quote[0] ?? null;
  }
  return quote;
}

async function fetchCoinMarketCapFdvItems(): Promise<FdvItem[]> {
  const symbols = FDV_COINS.map((coin) => coin.cmcSymbol).join(',');
  const url = `${CMC_QUOTES_ENDPOINT}?symbol=${encodeURIComponent(symbols)}&convert=USD`;
  const response = await fetch(url, { method: 'GET', headers: getCoinMarketCapHeaders() });
  if (!response.ok) {
    throw new Error(`CoinMarketCap request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as CoinMarketCapQuotesResponse;
  if ((payload.status?.error_code ?? 0) !== 0) {
    throw new Error(`CoinMarketCap API error: ${payload.status?.error_message ?? 'unknown error'}`);
  }

  const data = payload.data ?? {};
  return FDV_COINS.map(({ id, cmcSymbol }) => {
    const quote = normalizeCmcQuote(data[cmcSymbol]);
    return {
      id,
      symbol: quote?.symbol ?? null,
      name: quote?.name ?? null,
      fdvUsd: quote?.quote?.USD?.fully_diluted_market_cap ?? null,
      source: 'coinmarketcap' as const,
    };
  });
}

function monitorFdvParity(cmcItems: FdvItem[]): void {
  const now = Date.now();
  if (now - lastFdvMonitorCheckTime < FDV_MONITOR_TTL_MS) {
    return;
  }
  lastFdvMonitorCheckTime = now;

  // Non-blocking parity check: one CoinGecko request every 6 hours.
  void (async () => {
    try {
      const cgItems = await fetchCoingeckoFdvItems('coingecko_fallback');
      const cgById = new Map(cgItems.map((item) => [item.id, item]));
      for (const cmcItem of cmcItems) {
        const cgItem = cgById.get(cmcItem.id);
        if (!cgItem || cgItem.fdvUsd === null || cgItem.fdvUsd === 0 || cmcItem.fdvUsd === null) {
          continue;
        }
        const diffPct = ((cmcItem.fdvUsd - cgItem.fdvUsd) / cgItem.fdvUsd) * 100;
        if (Math.abs(diffPct) >= FDV_DIFF_ALERT_THRESHOLD_PCT) {
          logger.warn(
            `⚠️ FDV parity alert for ${cmcItem.id}: CMC=${cmcItem.fdvUsd}, CoinGecko=${cgItem.fdvUsd}, diff=${diffPct.toFixed(2)}%`
          );
        }
      }
    } catch (error) {
      logger.warn('FDV parity monitor skipped due to CoinGecko error:', error);
    }
  })();
}

function hasReusableCategoriesCache(): boolean {
  if (!cachedResponse) return false;
  return Date.now() - cachedResponse.fetchedAt < CATEGORIES_CACHE_TTL_MS;
}

async function getOrRefreshCoingeckoCategoriesData(source: 'request' | 'startup'): Promise<CoingeckoCategoriesData> {
  if (hasReusableCategoriesCache() && cachedResponse) {
    logger.debug(`✅ Coingecko categories cache hit (${source})`);
    return cachedResponse.data;
  }

  if (inFlightFetch !== null) {
    const data = await inFlightFetch;
    return cachedResponse?.data || data;
  }

  const fetchPromise: Promise<CoingeckoCategoriesData> = (async () => {
    const previous = cachedResponse;
    // Free tier rate limit: 30 次/分钟 = 每 2 秒一次
    // 为了安全，在请求之间添加间隔，确保不会超过 rate limit
    // 使用串行请求而不是并发，在请求之间添加间隔（略大于 2 秒，留有余量）
    const minIntervalMs = coingeckoFetchConfig.minRequestIntervalMs;

    const now = Date.now();
    const timeSinceLastRequest = now - lastApiRequestTime;
    if (timeSinceLastRequest < minIntervalMs) {
      const waitMs = minIntervalMs - timeSinceLastRequest;
      logger.debug(`⏳ CoinGecko rate limit: waiting ${waitMs}ms before next request`);
      await sleep(waitMs);
    }

    // 串行发送请求，在请求之间添加间隔
    // 这样可以确保不会超过 30 次/分钟的限制（5 个请求 × 2.5 秒 = 12.5 秒，远低于 60 秒）
    lastApiRequestTime = Date.now();
    const dataStable1 = await fetchCategoryPageWithRetry(
      `${CG_ENDPOINT}?vs_currency=usd&category=stablecoins&per_page=250&page=1`,
      'stablecoins-page-1'
    );

    await sleep(minIntervalMs);
    lastApiRequestTime = Date.now();
    const dataStable2 = await fetchCategoryPageWithRetry(
      `${CG_ENDPOINT}?vs_currency=usd&category=stablecoins&per_page=250&page=2`,
      'stablecoins-page-2'
    );

    await sleep(minIntervalMs);
    lastApiRequestTime = Date.now();
    const dataEth1 = await fetchCategoryPageWithRetry(
      `${CG_ENDPOINT}?vs_currency=usd&category=liquid-staked-eth&per_page=250&page=1`,
      'liquid-staked-eth'
    );

    await sleep(minIntervalMs);
    lastApiRequestTime = Date.now();
    const dataEth2 = await fetchCategoryPageWithRetry(
      `${CG_ENDPOINT}?vs_currency=usd&category=ether-fi-ecosystem&per_page=250&page=1`,
      'ether-fi-ecosystem'
    );

    await sleep(minIntervalMs);
    lastApiRequestTime = Date.now();
    const dataEth3 = await fetchCategoryPageWithRetry(
      `${CG_ENDPOINT}?vs_currency=usd&category=liquid-staking-tokens&per_page=250&page=1`,
      'liquid-staking-tokens'
    );

    const combinedStable = [...dataStable1, ...dataStable2];
    const stableSymbols = combinedStable
      .map((coin) => coin.symbol?.toUpperCase())
      .filter((symbol): symbol is string => Boolean(symbol));
    const uniqueSymbolsStablecoins = Array.from(new Set(stableSymbols)).sort();

    const filteredEth3 = dataEth3.filter((coin) => (coin.symbol?.toUpperCase() ?? '').includes('ETH'));
    const combinedEth = [...dataEth1, ...dataEth2, ...filteredEth3];
    const ethSymbols = combinedEth
      .map((coin) => coin.symbol?.toUpperCase())
      .filter((symbol): symbol is string => Boolean(symbol));
    const uniqueSymbolsEth = Array.from(new Set([...ethSymbols, 'WETH'])).sort();

    const result = { uniqueSymbolsStablecoins, uniqueSymbolsEth };

    const isEmpty = result.uniqueSymbolsStablecoins.length === 0 && result.uniqueSymbolsEth.length === 0;
    if (isEmpty) {
        if (previous && isWithinMaxServeStale(previous.fetchedAt, CATEGORIES_MAX_SERVE_STALE_MS)) {
          logger.warn(
            `⚠️ Coingecko categories refresh returned empty; keeping previous cache (age=${Math.round(
              (Date.now() - previous.fetchedAt) / 1000
            )}s, max=${Math.round(CATEGORIES_MAX_SERVE_STALE_MS / 1000)}s)`
          );
          return previous.data;
        }
      throw new Error('Coingecko categories refresh returned empty and no fresh fallback cache is available');
    }

    cachedResponse = { data: result, fetchedAt: Date.now() };
    logger.info(`✅ Coingecko categories refreshed (${source})`);
    return result;
  })();

  inFlightFetch = fetchPromise;
  fetchPromise.finally(() => {
    if (inFlightFetch === fetchPromise) {
      inFlightFetch = null;
    }
  }).catch(() => undefined);

  const data = await fetchPromise;
  return cachedResponse?.data || data;
}

export async function warmCoingeckoCategoriesCache(): Promise<void> {
  await getOrRefreshCoingeckoCategoriesData('startup');
}

export async function getCoingeckoCategoriesSnapshot(
  source: 'request' | 'startup' | 'meta' = 'request'
): Promise<{ data: CoingeckoCategoriesData; fetchedAt: string; staleTimeMs: number }> {
  const data = await getOrRefreshCoingeckoCategoriesData(source === 'meta' ? 'request' : source);
  const fetchedAtMs = cachedResponse?.fetchedAt ?? Date.now();
  return {
    data,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    staleTimeMs: CATEGORIES_CACHE_TTL_MS,
  };
}

function hasReusableFdvCache(): boolean {
  if (!cachedFdvResponse) return false;
  if (Date.now() - cachedFdvResponse.fetchedAt >= FDV_CACHE_TTL_MS) return false;
  const hasNullFdv = cachedFdvResponse.data.items.some((item) => item.fdvUsd === null);
  return !hasNullFdv;
}

async function getOrRefreshFdvData(
  source: 'request' | 'cron'
): Promise<{ items: FdvItem[]; fetchedAt: string }> {
  if (hasReusableFdvCache() && cachedFdvResponse) {
    logger.debug(`✅ FDV cache hit (${source})`);
    return cachedFdvResponse.data;
  }

  if (cachedFdvResponse) {
    logger.warn('⚠️ FDV cache is stale or has null values, refreshing');
  }

  if (inFlightFdvFetch !== null) {
    const data = await inFlightFdvFetch;
    return cachedFdvResponse?.data || data;
  }

  const fetchPromise: Promise<{ items: FdvItem[]; fetchedAt: string }> = (async () => {
    const previous = cachedFdvResponse;
    let items: FdvItem[];
    try {
      items = await fetchCoinMarketCapFdvItems();
      logger.info(`✅ FDV refreshed via CoinMarketCap (${FDV_COINS.length} coins)`);
      monitorFdvParity(items);
    } catch (cmcError) {
      logger.warn(`⚠️ CoinMarketCap FDV fetch failed, falling back to CoinGecko: ${String(cmcError)}`);
      items = await fetchCoingeckoFdvItems('coingecko_fallback');
      logger.info(`✅ FDV refreshed via CoinGecko fallback (${FDV_COINS.length} coins)`);
    }

    const result = { items, fetchedAt: new Date().toISOString() };

    if (result.items.length === 0) {
      if (previous && isWithinMaxServeStale(previous.fetchedAt, FDV_MAX_SERVE_STALE_MS)) {
        logger.warn(
          `⚠️ FDV refresh returned empty items; keeping previous cache (age=${Math.round(
            (Date.now() - previous.fetchedAt) / 1000
          )}s, max=${Math.round(FDV_MAX_SERVE_STALE_MS / 1000)}s)`
        );
        return previous.data;
      }
      throw new Error('FDV refresh returned empty items and no fresh fallback cache is available');
    }

    cachedFdvResponse = { data: result, fetchedAt: Date.now() };
    logger.info(`✅ FDV cache updated at ${result.fetchedAt}`);
    return result;
  })();

  inFlightFdvFetch = fetchPromise;
  fetchPromise.finally(() => {
    if (inFlightFdvFetch === fetchPromise) {
      inFlightFdvFetch = null;
    }
  }).catch(() => undefined);

  const data = await fetchPromise;
  return cachedFdvResponse?.data || data;
}

export async function warmCoingeckoFdvCache(): Promise<void> {
  await getOrRefreshFdvData('cron');
}

export async function getCoingeckoFdvSnapshot(
  source: 'request' | 'cron' | 'meta' = 'request'
): Promise<{ data: { items: FdvItem[]; fetchedAt: string }; staleTimeMs: number }> {
  const data = await getOrRefreshFdvData(source === 'meta' ? 'request' : source);
  return {
    data,
    staleTimeMs: FDV_CACHE_TTL_MS,
  };
}
