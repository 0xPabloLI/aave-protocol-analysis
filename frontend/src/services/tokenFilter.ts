// Hardcoded token lists
export const STABLECOINS_HARDCODED = [
  'USDC',
  'USDT',
  'DAI',
  'GHO',
  'EURC',
  'USDBC',
  'USDE',
  'USDS',
  'SUSDE',
  'RLUSD',
  'PYUSD',
  'LUSD',
  'SDAI',
  'CRVUSD',
  'USD₮0',
  'USD₮',
  'USDC.E',
  'USDCE',
  'EURE',
  'XDAI',
  'WXDAI',
];

export const CORRELATED_ETH_HARDCODED = [
  'WEETH',
  'ETH',
  'WETH',
  'WSTETH',
  'CBETH',
  'EZETH',
  'WRSETH',
  'OSETH',
  'RETH',
  'ETHX',
];

export const CORRELATED_BTC_HARDCODED = ['CBBTC', 'WBTC', 'LBTC', 'TBTC', 'EBTC', 'BTC.B', 'WBTC.E'];

// CoinGecko API configuration
const CG_ENDPOINT = 'https://api.coingecko.com/api/v3/2/coins/markets';
const HEADERS = {
  accept: 'application/json',
  'x-cg-demo-api-key': 'DEMO API Key',
};

export type TokenCategory = 'stablecoin' | 'eth-related' | 'btc-related' | 'pendle';

interface CoinGeckoToken {
  symbol: string;
  name: string;
}

/**
 * Fetch tokens from CoinGecko API for stablecoins and ETH-related categories
 */
export async function fetchCoinGeckoTokens(): Promise<{
  stablecoins: Set<string>;
  ethRelated: Set<string>;
}> {
  const stablecoins = new Set<string>(STABLECOINS_HARDCODED);
  const ethRelated = new Set<string>(CORRELATED_ETH_HARDCODED);

  try {
    const [resStable1, resStable2, resEth1, resEth2, resEth3] = await Promise.all([
      fetch(`${CG_ENDPOINT}?vs_currency=usd&category=stablecoins&per_page=250&page=1`, {
        method: 'GET',
        headers: HEADERS,
      }),
      fetch(`${CG_ENDPOINT}?vs_currency=usd&category=stablecoins&per_page=250&page=2`, {
        method: 'GET',
        headers: HEADERS,
      }),
      fetch(`${CG_ENDPOINT}?vs_currency=usd&category=liquid-staked-eth&per_page=250&page=1`, {
        method: 'GET',
        headers: HEADERS,
      }),
      fetch(`${CG_ENDPOINT}?vs_currency=usd&category=ether-fi-ecosystem&per_page=250&page=1`, {
        method: 'GET',
        headers: HEADERS,
      }),
      fetch(`${CG_ENDPOINT}?vs_currency=usd&category=liquid-staking-tokens&per_page=250&page=1`, {
        method: 'GET',
        headers: HEADERS,
      }),
    ]);

    const [stable1, stable2, eth1, eth2, eth3] = await Promise.all([
      resStable1.json(),
      resStable2.json(),
      resEth1.json(),
      resEth2.json(),
      resEth3.json(),
    ]);

    // Add stablecoins from CoinGecko
    [...(stable1 || []), ...(stable2 || [])].forEach((token: CoinGeckoToken) => {
      if (token.symbol) {
        stablecoins.add(token.symbol.toUpperCase());
      }
    });

    // Add ETH-related tokens from CoinGecko
    [...(eth1 || []), ...(eth2 || []), ...(eth3 || [])].forEach((token: CoinGeckoToken) => {
      if (token.symbol) {
        ethRelated.add(token.symbol.toUpperCase());
      }
    });
  } catch (error) {
    console.error('Error fetching CoinGecko tokens:', error);
    // Fallback to hardcoded lists only
  }

  return { stablecoins, ethRelated };
}

/**
 * Check if a token belongs to a specific category
 */
export function isTokenInCategory(
  tokenSymbol: string,
  category: TokenCategory,
  stablecoins: Set<string>,
  ethRelated: Set<string>
): boolean {
  const upperSymbol = tokenSymbol.toUpperCase();

  switch (category) {
    case 'stablecoin':
      return stablecoins.has(upperSymbol);
    case 'eth-related':
      return ethRelated.has(upperSymbol);
    case 'btc-related':
      return CORRELATED_BTC_HARDCODED.includes(upperSymbol);
    case 'pendle':
      return upperSymbol.startsWith('PT');
    default:
      return false;
  }
}
