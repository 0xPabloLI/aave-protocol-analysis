import type { Request, Response } from 'express';
import { logger } from '../logger.js';

const CG_ENDPOINT = 'https://api.coingecko.com/api/v3/coins/markets';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CoinGeckoCoin {
  id: string;
  symbol: string;
}

let cachedResponse: { data: { uniqueSymbolsStablecoins: string[]; uniqueSymbolsEth: string[] }; fetchedAt: number } | null =
  null;

const getHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = process.env.COINGECKO_API_KEY;
  if (apiKey) {
    headers['x-cg-demo-api-key'] = apiKey;
  }
  return headers;
};

const fetchCategoryPage = async (url: string): Promise<CoinGeckoCoin[]> => {
  const response = await fetch(url, { method: 'GET', headers: getHeaders() });
  if (!response.ok) {
    throw new Error(`CoinGecko request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

export const getCoingeckoCategories = async (req: Request, res: Response) => {
  try {
    if (cachedResponse && Date.now() - cachedResponse.fetchedAt < CACHE_TTL_MS) {
      return res.status(200).json(cachedResponse.data);
    }

    const [dataStable1, dataStable2, dataEth1, dataEth2, dataEth3] = await Promise.all([
      fetchCategoryPage(`${CG_ENDPOINT}?vs_currency=usd&category=stablecoins&per_page=250&page=1`),
      fetchCategoryPage(`${CG_ENDPOINT}?vs_currency=usd&category=stablecoins&per_page=250&page=2`),
      fetchCategoryPage(`${CG_ENDPOINT}?vs_currency=usd&category=liquid-staked-eth&per_page=250&page=1`),
      fetchCategoryPage(`${CG_ENDPOINT}?vs_currency=usd&category=ether-fi-ecosystem&per_page=250&page=1`),
      fetchCategoryPage(`${CG_ENDPOINT}?vs_currency=usd&category=liquid-staking-tokens&per_page=250&page=1`),
    ]);

    const combinedStable = [...dataStable1, ...dataStable2];
    const stableSymbols = combinedStable
      .map((coin) => coin.symbol?.toUpperCase())
      .filter((symbol): symbol is string => Boolean(symbol));

    const uniqueSymbolsStablecoins = Array.from(new Set(stableSymbols));

    const filteredEth3 = dataEth3.filter((coin) => coin.symbol?.toUpperCase().includes('ETH'));
    const combinedEth = [...dataEth1, ...dataEth2, ...filteredEth3];
    const ethSymbols = combinedEth
      .map((coin) => coin.symbol?.toUpperCase())
      .filter((symbol): symbol is string => Boolean(symbol));

    const uniqueSymbolsEth = Array.from(new Set([...ethSymbols, 'WETH']));

    cachedResponse = {
      data: { uniqueSymbolsStablecoins, uniqueSymbolsEth },
      fetchedAt: Date.now(),
    };

    return res.status(200).json(cachedResponse.data);
  } catch (error) {
    logger.error('Coingecko categories proxy error:', error);
    return res.status(500).json({ error: 'Internal server error', details: String(error) });
  }
};
