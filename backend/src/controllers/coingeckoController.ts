import type { Request, Response } from 'express';
import { logger } from '../logger.js';
import { coingeckoFetchConfig } from '../config.js';

const CG_ENDPOINT = 'https://api.coingecko.com/api/v3/coins/markets';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FDV_CACHE_TTL_MS = 10 * 60 * 1000;
const FDV_COINS = [
  { id: 'crypto-com-chain' },
  { id: 'gatechain-token' },
  { id: 'okb' },
  { id: 'mantle' },
  { id: 'bitget-token' },
  { id: 'binancecoin' },
] as const;

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

let cachedResponse: { data: { uniqueSymbolsStablecoins: string[]; uniqueSymbolsEth: string[] }; fetchedAt: number } | null =
  null;
let cachedFdvResponse: {
  data: { items: { id: string; symbol: string | null; name: string | null; fdvUsd: number | null }[]; fetchedAt: string };
  fetchedAt: number;
} | null = null;
// 跟踪正在进行的 fetch，防止并发请求触发重复的 API 调用
let inFlightFetch: Promise<{ uniqueSymbolsStablecoins: string[]; uniqueSymbolsEth: string[] }> | null = null;
let inFlightFdvFetch: Promise<{ items: { id: string; symbol: string | null; name: string | null; fdvUsd: number | null }[]; fetchedAt: string }> | null = null;
// 跟踪最后一次 API 请求的时间，用于 rate limit 控制（Free tier: 30 次/分钟 = 每 2 秒一次）
let lastApiRequestTime: number = 0;

const getHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = process.env.COINGECKO_API_KEY;
  if (apiKey) {
    headers['x-cg-demo-api-key'] = apiKey;
  }
  return headers;
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

export const getCoingeckoCategories = async (req: Request, res: Response) => {
  try {
    // 检查缓存是否有效
    if (cachedResponse && Date.now() - cachedResponse.fetchedAt < CACHE_TTL_MS) {
      return res.status(200).json(cachedResponse.data);
    }

    // 启动新的 fetch 并跟踪它
    // 使用原子检查并设置模式防止竞态条件：
    // 1. 创建 promise 工厂函数（不立即执行）
    // 2. 原子检查并设置 inFlightFetch
    // 3. 只有赢得竞态条件的请求才执行 promise 工厂函数
    // 这样可以确保只有一个请求会实际执行 API 调用
    // 注意：移除早期检查，只依赖原子检查-设置模式，避免竞态条件
    const createFetchPromise = (): Promise<{ uniqueSymbolsStablecoins: string[]; uniqueSymbolsEth: string[] }> => {
      return (async () => {
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
        const dataStable1 = await fetchCategoryPageWithRetry(`${CG_ENDPOINT}?vs_currency=usd&category=stablecoins&per_page=250&page=1`, 'stablecoins-page-1');
        
        await sleep(minIntervalMs);
        lastApiRequestTime = Date.now();
        const dataStable2 = await fetchCategoryPageWithRetry(`${CG_ENDPOINT}?vs_currency=usd&category=stablecoins&per_page=250&page=2`, 'stablecoins-page-2');
        
        await sleep(minIntervalMs);
        lastApiRequestTime = Date.now();
        const dataEth1 = await fetchCategoryPageWithRetry(`${CG_ENDPOINT}?vs_currency=usd&category=liquid-staked-eth&per_page=250&page=1`, 'liquid-staked-eth');
        
        await sleep(minIntervalMs);
        lastApiRequestTime = Date.now();
        const dataEth2 = await fetchCategoryPageWithRetry(`${CG_ENDPOINT}?vs_currency=usd&category=ether-fi-ecosystem&per_page=250&page=1`, 'ether-fi-ecosystem');
        
        await sleep(minIntervalMs);
        lastApiRequestTime = Date.now();
        const dataEth3 = await fetchCategoryPageWithRetry(`${CG_ENDPOINT}?vs_currency=usd&category=liquid-staking-tokens&per_page=250&page=1`, 'liquid-staking-tokens');

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

        // 更新缓存
        cachedResponse = {
          data: result,
          fetchedAt: Date.now(),
        };

        return result;
      })();
    };
    
    // 原子检查并设置：如果 inFlightFetch 仍为 null，设置它；否则另一个请求已经设置了
    // 关键：只有在赢得竞态条件后才创建并执行 promise，避免重复的 API 调用
    // 这是唯一的检查点，确保真正的原子性
    if (inFlightFetch === null) {
      // 我们赢得了竞态条件，创建并执行 promise
      const fetchPromise = createFetchPromise();
      inFlightFetch = fetchPromise;
      
      // 在 promise 完成后清除 inFlightFetch，但只在它仍然指向当前 promise 时清除
      // 使用 promise.finally() 确保无论成功还是失败都会执行清理
      fetchPromise.finally(() => {
        // 只有当 inFlightFetch 仍然指向当前 promise 时才清除
        // 这样可以防止新启动的 fetch 被错误清除
        if (inFlightFetch === fetchPromise) {
          inFlightFetch = null;
        }
      });
      
      try {
        // 使用局部变量引用 await，避免竞态条件
        const data = await fetchPromise;
        return res.status(200).json(data);
      } catch (error) {
        // 错误会被外层 catch 处理，这里不需要处理
        throw error;
      }
    } else {
      // 另一个请求在我们检查期间设置了 inFlightFetch
      // 直接等待这个 promise，不需要修改任何状态
      // promise 的 finally 块会负责清除 inFlightFetch
      const currentFetch = inFlightFetch;
      
      try {
        // 等待那个请求的 promise 完成
        const data = await currentFetch;
        // 等待完成后，缓存应该已经更新，使用缓存数据
        return res.status(200).json(cachedResponse?.data || data);
      } catch (error) {
        // 如果 promise 失败，外层 catch 会处理
        throw error;
      }
    }
  } catch (error) {
    // 如果出错，promise 的 finally 块会负责清除 inFlightFetch
    // 这里不需要手动清除，因为 promise.finally() 已经设置了清理逻辑
    logger.error('Coingecko categories proxy error:', error);
    return res.status(500).json({ error: 'Internal server error', details: String(error) });
  }
};

export const getCoingeckoFdv = async (req: Request, res: Response) => {
  try {
    if (cachedFdvResponse && Date.now() - cachedFdvResponse.fetchedAt < FDV_CACHE_TTL_MS) {
      const hasNullFdv = cachedFdvResponse.data.items.some((item) => item.fdvUsd === null);
      if (!hasNullFdv) {
        logger.debug('✅ CoinGecko FDV cache hit');
        return res.status(200).json(cachedFdvResponse.data);
      }
      logger.warn('⚠️ CoinGecko FDV cache has null values, forcing refresh');
    }

    const createFetchPromise = (): Promise<{ items: { id: string; symbol: string | null; name: string | null; fdvUsd: number | null }[]; fetchedAt: string }> => {
      return (async () => {
        const minIntervalMs = coingeckoFetchConfig.minRequestIntervalMs;
        const now = Date.now();
        const timeSinceLastRequest = now - lastApiRequestTime;
        if (timeSinceLastRequest < minIntervalMs) {
          const waitMs = minIntervalMs - timeSinceLastRequest;
          logger.debug(`⏳ CoinGecko rate limit: waiting ${waitMs}ms before next request`);
          await sleep(waitMs);
        }

        lastApiRequestTime = Date.now();
        const idsParam = encodeURIComponent(FDV_COINS.map((coin) => coin.id).join(','));
        const url = `${CG_ENDPOINT}?vs_currency=usd&ids=${idsParam}&per_page=250&page=1`;
        const markets = await fetchMarkets(url, 'fdv-coins');

        const marketById = new Map(markets.map((coin) => [coin.id, coin]));
        const items = FDV_COINS.map(({ id }) => {
          const coin = marketById.get(id);
          return {
            id,
            symbol: coin?.symbol?.toUpperCase() ?? null,
            name: coin?.name ?? null,
            fdvUsd: coin?.fully_diluted_valuation ?? null,
          };
        });

        const result = { items, fetchedAt: new Date().toISOString() };
        cachedFdvResponse = { data: result, fetchedAt: Date.now() };
        logger.info(
          `✅ CoinGecko FDV refreshed (${FDV_COINS.length} coins) at ${result.fetchedAt}`
        );
        return result;
      })();
    };

    if (inFlightFdvFetch === null) {
      const fetchPromise = createFetchPromise();
      inFlightFdvFetch = fetchPromise;
      fetchPromise.finally(() => {
        if (inFlightFdvFetch === fetchPromise) {
          inFlightFdvFetch = null;
        }
      });

      const data = await fetchPromise;
      return res.status(200).json(data);
    }

    const currentFetch = inFlightFdvFetch;
    const data = await currentFetch;
    return res.status(200).json(cachedFdvResponse?.data || data);
  } catch (error) {
    logger.error('Coingecko fdv proxy error:', error);
    return res.status(500).json({ error: 'Internal server error', details: String(error) });
  }
};
