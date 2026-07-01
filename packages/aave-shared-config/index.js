import { execSync } from 'node:child_process';

const DEFAULT_ITEMS_PER_PAGE = 100;
const MAX_ITEMS_PER_PAGE = 100;
const DEFAULT_OPPORTUNITIES_SNAPSHOT_TTL_MS = 60 * 1000;

/** `MERKL_FETCH_MAX_CONCURRENCY` (default 5): one shared pool for all Merkl HTTP in a process. */
const readMerklFetchMaxConcurrency = () => {
  const raw = process.env.MERKL_FETCH_MAX_CONCURRENCY;
  const defaultValue = 5;
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 1 ? n : defaultValue;
};

let merklFetchActiveCount = 0;
const merklFetchWaitQueue = [];

const acquireMerklFetchSlot = () => {
  const max = readMerklFetchMaxConcurrency();
  if (merklFetchActiveCount < max) {
    merklFetchActiveCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => merklFetchWaitQueue.push(resolve));
};

const releaseMerklFetchSlot = () => {
  const next = merklFetchWaitQueue.shift();
  if (next) {
    next();
  } else {
    merklFetchActiveCount--;
  }
};

/**
 * Wraps `fetch` so every Merkl HTTP call shares one process-wide concurrency pool
 * (opportunities pagination, campaign/metrics, merit Merkl probes, etc.).
 */
export function createMerklConcurrencyLimitedFetch(fetchImpl = fetch) {
  return async (input, init) => {
    await acquireMerklFetchSlot();
    try {
      return await fetchImpl(input, init);
    } finally {
      releaseMerklFetchSlot();
    }
  };
}

export function createSlidingWindowRateLimiter(maxRequestsPerSecond) {
  const timestamps = [];
  const windowMs = 1000;

  function cleanup(now) {
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  }

  async function wait() {
    const now = Date.now();
    cleanup(now);
    if (timestamps.length >= maxRequestsPerSecond) {
      const waitMs = timestamps[0] + windowMs - now + 1;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      cleanup(Date.now());
    }
    timestamps.push(Date.now());
  }

  function getTimestamps() {
    cleanup(Date.now());
    return [...timestamps];
  }

  function reset() {
    timestamps.length = 0;
  }

  return { wait, getTimestamps, reset };
}

const readV3FetchMaxConcurrency = () => {
  const raw = process.env.V3_FETCH_MAX_CONCURRENCY;
  const defaultValue = 5;
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 1 ? n : defaultValue;
};

const readV3MaxRequestsPerSecond = () => {
  const raw = process.env.V3_MAX_REQUESTS_PER_SECOND;
  const defaultValue = 3;
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 1 ? n : defaultValue;
};

const readV3FetchMaxRetries = () => {
  const raw = process.env.V3_FETCH_MAX_RETRIES;
  const defaultValue = 3;
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
};

const readV3FetchBaseDelayMs = () => {
  const raw = process.env.V3_FETCH_BASE_DELAY_MS;
  const defaultValue = 1000;
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
};

const readV3FetchMaxDelayMs = () => {
  const raw = process.env.V3_FETCH_MAX_DELAY_MS;
  const defaultValue = 30000;
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
};

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const asNumber = Number(headerValue);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber * 1000;
  const asDate = new Date(headerValue);
  if (!isNaN(asDate.getTime())) {
    const diff = asDate.getTime() - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
}

let v3FetchActiveCount = 0;
const v3FetchWaitQueue = [];

const acquireV3FetchSlot = () => {
  const max = readV3FetchMaxConcurrency();
  if (v3FetchActiveCount < max) {
    v3FetchActiveCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => v3FetchWaitQueue.push(resolve));
};

const releaseV3FetchSlot = () => {
  const next = v3FetchWaitQueue.shift();
  if (next) {
    next();
  } else {
    v3FetchActiveCount--;
  }
};

let totalV3429s = 0;

export function createAaveV3RateLimitedFetch(fetchImpl = fetch) {
  const limiter = createSlidingWindowRateLimiter(readV3MaxRequestsPerSecond());
  const maxRetries = readV3FetchMaxRetries();
  const baseDelayMs = readV3FetchBaseDelayMs();
  const maxDelayMs = readV3FetchMaxDelayMs();

  return async (input, init) => {
    await acquireV3FetchSlot();
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await limiter.wait();
        const response = await fetchImpl(input, init);

        if (response.status === 429 && attempt < maxRetries) {
          totalV3429s++;
          const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
          const delayMs = retryAfterMs != null
            ? Math.min(retryAfterMs, maxDelayMs)
            : Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt)) + Math.random() * 500;

          if (typeof globalThis.console?.warn === 'function') {
            console.warn(
              `[V3-RateLimit] 429 received (attempt ${attempt + 1}/${maxRetries + 1}, total 429s: ${totalV3429s}), ` +
              `retrying in ${Math.round(delayMs)}ms${retryAfterMs != null ? ' (Retry-After)' : ' (exponential backoff)'}`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        return response;
      }
      const finalResponse = await fetchImpl(input, init);
      return finalResponse;
    } finally {
      releaseV3FetchSlot();
    }
  };
}

export function getV3RateLimitStats() {
  return { total429s: totalV3429s, activeConcurrent: v3FetchActiveCount };
}

export function resetV3RateLimitState() {
  totalV3429s = 0;
  v3FetchActiveCount = 0;
  v3FetchWaitQueue.length = 0;
}

const opportunitiesSnapshotCache = new Map();

const {
  INFURA_PROJECT_ID,
  // QUICKNODE_API_KEY, // no free plan – commented out
  ALCHEMY_API_KEY,
  ANKR_API_KEY,
} = process.env;

// RPC order: public endpoints first, private (Infura/Alchemy/Ankr) last. Infura = mainnet HTTPS per https://docs.metamask.io/services/get-started/endpoints. Alchemy = latest mainnet v2 endpoints.
export const AAVE_RPC_URLS_BY_CHAIN_KEY = Object.freeze({
  ethereum: Object.freeze([
    'https://ethereum-rpc.publicnode.com',
    'https://eth-mainnet.public.blastapi.io',
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
    `https://mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    `https://rpc.ankr.com/eth/${ANKR_API_KEY}`,
  ]),
  polygon: Object.freeze([
    'https://gateway.tenderly.co/public/polygon',
    'https://polygon-pokt.nodies.app',
    'https://polygon-bor-rpc.publicnode.com',
    'https://rpc-mainnet.matic.quiknode.pro',
    'https://polygon.drpc.org',
    'https://1rpc.io/matic',
    `https://polygon-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/polygon/${ANKR_API_KEY}`,
    `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  avalanche: Object.freeze([
    'https://api.avax.network/ext/bc/C/rpc',
    'https://avalanche.drpc.org',
    'https://1rpc.io/avax/c',
    'https://avalanche-c-chain-rpc.publicnode.com',
    `https://avalanche-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/avalanche/${ANKR_API_KEY}`,
    `https://avax-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  arbitrum: Object.freeze([
    'https://arb1.arbitrum.io/rpc',
    'https://1rpc.io/arb',
    'https://arbitrum.drpc.org',
    'https://arbitrum-one-rpc.publicnode.com',
    `https://arbitrum-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    `https://rpc.ankr.com/arbitrum/${ANKR_API_KEY}`,
  ]),
  base: Object.freeze([
    'https://1rpc.io/base',
    'https://base.llamarpc.com',
    'https://base.publicnode.com',
    'https://base-mainnet.public.blastapi.io',
    'https://base.drpc.org',
    `https://base-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/base/${ANKR_API_KEY}`,
    `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  optimism: Object.freeze([
    'https://public-op-mainnet.fastnode.io',
    'https://optimism-rpc.publicnode.com',
    'https://optimism.drpc.org',
    'https://1rpc.io/op',
    `https://optimism-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/optimism/${ANKR_API_KEY}`,
    `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  metis: Object.freeze([
    'https://andromeda.metis.io/?owner=1088',
    'https://metis-rpc.publicnode.com',
    'https://metis.drpc.org',
    'https://metis-andromeda.gateway.tenderly.co',
    `https://rpc.ankr.com/metis/${ANKR_API_KEY}`,
    `https://metis-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  gnosis: Object.freeze([
    'https://gnosis-rpc.publicnode.com',
    'https://rpc.gnosischain.com',
    'https://1rpc.io/gnosis',
    'https://gnosis.drpc.org',
    'https://gnosis.api.onfinality.io/public',
    `https://rpc.ankr.com/gnosis/${ANKR_API_KEY}`,
    `https://gnosis-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  bnb: Object.freeze([
    'https://bsc.publicnode.com',
    'https://bsc-mainnet.public.blastapi.io',
    'https://1rpc.io/bnb',
    'https://bsc.drpc.org',
    `https://bsc-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    `https://rpc.ankr.com/bsc/${ANKR_API_KEY}`,
  ]),
  scroll: Object.freeze([
    'https://rpc.scroll.io',
    'https://scroll-rpc.publicnode.com',
    'https://scroll.drpc.org',
    'https://1rpc.io/scroll',
    `https://scroll-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/scroll/${ANKR_API_KEY}`,
    `https://scroll-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  zksync: Object.freeze([
    'https://mainnet.era.zksync.io',
    'https://zksync.drpc.org',
    'https://1rpc.io/zksync2-era',
    'https://zksync-era.public-rpc.com',
    `https://zksync-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/zksync_era/${ANKR_API_KEY}`,
    `https://zksync-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  linea: Object.freeze([
    'https://1rpc.io/linea',
    'https://linea.drpc.org',
    'https://linea-rpc.publicnode.com',
    'https://rpc.linea.build',
    `https://linea-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/linea/${ANKR_API_KEY}`,
    `https://linea-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  sonic: Object.freeze([
    'https://rpc.soniclabs.com',
    'https://sonic.drpc.org',
    'https://sonic-rpc.publicnode.com',
    `https://sonic-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    `https://rpc.ankr.com/sonic/${ANKR_API_KEY}`,
  ]),
  celo: Object.freeze([
    'https://celo.drpc.org',
    'https://forno.celo.org',
    'https://celo-mainnet.gateway.tatum.io',
    `https://celo-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/celo/${ANKR_API_KEY}`,
    `https://celo-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  soneium: Object.freeze([
    'https://soneium.drpc.org',
    'https://rpc.soneium.org',
    'https://soneium-rpc.publicnode.com',
    'https://soneium.gateway.tenderly.co',
    `https://soneium-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  mantle: Object.freeze([
    'https://rpc.mantle.xyz',
    'https://mantle.publicnode.com',
    'https://mantle.drpc.org',
    'https://mantle.gateway.tenderly.co',
    `https://mantle-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/mantle/${ANKR_API_KEY}`,
    `https://mantle-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  megaeth: Object.freeze([
    'https://mainnet.megaeth.com/rpc',
    `https://megaeth-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://megaeth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  plasma: Object.freeze([
    'https://rpc.plasma.to',
    `https://plasma-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  ink: Object.freeze([
    'https://ink.drpc.org',
    `https://ink-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  blast: Object.freeze([
    'https://rpc.blast.io',
    'https://blast.drpc.org',
    'https://blast-rpc.publicnode.com',
    `https://blast-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://rpc.ankr.com/blast/${ANKR_API_KEY}`,
    `https://blast-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  palm: Object.freeze([
    `https://palm-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
  ]),
  opbnb: Object.freeze([
    'https://opbnb-mainnet-rpc.bnbchain.org',
    'https://opbnb.drpc.org',
    'https://opbnb-rpc.publicnode.com',
    `https://opbnb-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://opbnb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  zkLinkNova: Object.freeze([
    'https://rpc.zklink.io',
  ]),
  manta: Object.freeze([
    'https://pacific-rpc.manta.network/http',
    'https://manta-pacific.drpc.org',
    'https://1rpc.io/manta',
  ]),
  berachain: Object.freeze([
    'https://rpc.berachain.com',
    'https://berachain.drpc.org',
    'https://berachain-rpc.publicnode.com',
    `https://berachain-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  ]),
  abstract: Object.freeze([
    `https://abstract-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    // `https://cosmological-solitary-uranium.abstract-mainnet.quiknode.pro/${QUICKNODE_API_KEY}`,
  ]),
  flare: Object.freeze([
    'https://flare-api.flare.network/ext/C/rpc',
    'https://rpc.ankr.com/flare',
    `https://rpc.ankr.com/flare/${ANKR_API_KEY}`,
  ]),
  xlayer: Object.freeze([
    'https://rpc.xlayer.tech',
    'https://xlayerrpc.okx.com',
    'https://xlayer.drpc.org',
    'https://1rpc.io/xlayer',
  ]),
  harmony: Object.freeze([
    'https://api.harmony.one',
    'https://rpc.ankr.com/harmony',
    'https://harmony-0-rpc.gateway.pokt.network',
    'https://1rpc.io/one',
    `https://rpc.ankr.com/harmony/${ANKR_API_KEY}`,
  ]),
});

export const AAVE_CHAIN_KEY_ALIASES = Object.freeze({
  'ethereum-etherfi': 'ethereum',
  'ethereum-prime': 'ethereum',
  'ethereum-horizon': 'ethereum',
  'arbitrum-one': 'arbitrum',
  arbitrum_one: 'arbitrum',
  xdai: 'gnosis',
  metis_andromeda: 'metis',
  bsc: 'bnb',
  binance: 'bnb',
});

export const DEFAULT_SPOKE_HUB_TOPOLOGY = [
  { chainId: 1, spokeAddress: '0x94e7a5dcbe816e498b89ab752661904e2f56c485', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x973a023a77420ba610f06b3858ad991df6d85a08', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x973a023a77420ba610f06b3858ad991df6d85a08', hubAddress: '0x943827dca022d0f354a8a8c332da1e5eb9f9f931' },
  { chainId: 1, spokeAddress: '0xe1900480ac69f0b296841cd01cc37546d92f35cd', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0xbf10bdfe177de0336afd7fccf80a904e15386219', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x3131fe68c4722e726fe6b2819ed68e514395b9a4', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x58131e79531cab1d52301228d1f7b842f26b9649', hubAddress: '0x06002e9c4412cb7814a791ea3666d905871e536a' },
  { chainId: 1, spokeAddress: '0xba1b3d55d249692b669a164024a838309b7508af', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0xba1b3d55d249692b669a164024a838309b7508af', hubAddress: '0x06002e9c4412cb7814a791ea3666d905871e536a' },
  { chainId: 1, spokeAddress: '0xd8b93635b8c6d0ff98cbe90b5988e3f2d1cd9da1', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x65407b940966954b23dfa3caa5c0702bb42984dc', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x7ec68b5695e803e98a21a9a05d744f28b0a7753d', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
];

export const AAVE_CHAIN_ID_TO_RPC_KEY = Object.freeze({
  1: 'ethereum',
  10: 'optimism',
  56: 'bnb',
  100: 'gnosis',
  137: 'polygon',
  146: 'sonic',
  196: 'xlayer',
  324: 'zksync',
  1868: 'soneium',
  42220: 'celo',
  5000: 'mantle',
  4326: 'megaeth',
  8453: 'base',
  9745: 'plasma',
  1088: 'metis',
  57073: 'ink',
  59144: 'linea',
  42161: 'arbitrum',
  43114: 'avalanche',
  534352: 'scroll',
  1666600000: 'harmony',
  81457: 'blast',
  11297108109: 'palm',
  204: 'opbnb',
  810180: 'zkLinkNova',
  169: 'manta',
  80094: 'berachain',
  2741: 'abstract',
  14: 'flare',
});

const normalizeHttpUrls = (urls) =>
  (Array.isArray(urls) ? urls : []).filter(
    (url) => typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))
  );

export const resolveAaveRpcChainKey = (chainNameOrKey) => {
  const normalized = String(chainNameOrKey || '').trim().toLowerCase();
  if (!normalized) return '';
  return AAVE_CHAIN_KEY_ALIASES[normalized] ?? normalized;
};

export const getAaveRpcUrlsByChainName = (chainNameOrKey) => {
  const key = resolveAaveRpcChainKey(chainNameOrKey);
  return normalizeHttpUrls(AAVE_RPC_URLS_BY_CHAIN_KEY[key] ?? []);
};

export const getAaveRpcUrlsByChainId = (chainId) => {
  const key = AAVE_CHAIN_ID_TO_RPC_KEY[Number(chainId)];
  if (!key) return [];
  return normalizeHttpUrls(AAVE_RPC_URLS_BY_CHAIN_KEY[key] ?? []);
};

export const DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY = Object.freeze({
  mainProtocolId: 'aave,tydro',
  status: 'LIVE',
  campaigns: true,
  itemsPerPage: DEFAULT_ITEMS_PER_PAGE,
});

export const resolveCacheTtlMs = (
  raw,
  fallbackMs = DEFAULT_OPPORTUNITIES_SNAPSHOT_TTL_MS
) => {
  const parsedFallback = Number.parseInt(String(fallbackMs), 10);
  const safeFallback =
    Number.isFinite(parsedFallback) && parsedFallback > 0
      ? parsedFallback
      : DEFAULT_OPPORTUNITIES_SNAPSHOT_TTL_MS;

  if (raw === undefined || raw === null || raw === '') {
    return safeFallback;
  }

  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : safeFallback;
};

const toFiniteNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Normalize a Merkl campaign budget to the effective unit used by forecast:
 * - If reward token price is available and positive: USD
 * - Otherwise: reward token units (after decimals normalization when needed)
 *
 * Returns `null` when amount cannot be parsed.
 */
export const normalizeMerklCampaignTotalBudget = (campaign) => {
  const amountRaw = campaign?.amount;
  const amount = toFiniteNumber(amountRaw);
  if (amount === null) return null;

  const decimals =
    toFiniteNumber(campaign?.rewardToken?.decimals) ??
    toFiniteNumber(campaign?.params?.decimalsRewardToken);

  let rewardAmount = amount;
  if (decimals !== null && decimals >= 0) {
    if (typeof amountRaw === 'string' && !amountRaw.includes('.')) {
      rewardAmount = amount / Math.pow(10, decimals);
    }
  }

  const rewardTokenPrice = toFiniteNumber(campaign?.rewardToken?.price);
  if (rewardTokenPrice !== null && rewardTokenPrice > 0) {
    return rewardAmount * rewardTokenPrice;
  }
  return rewardAmount;
};

const withDefaultAaveTydroQuery = ({
  mainProtocolId,
  status,
  campaigns,
  itemsPerPage,
  ...rest
}) => ({
  ...rest,
  mainProtocolId:
    mainProtocolId ?? DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY.mainProtocolId,
  status: status ?? DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY.status,
  campaigns: campaigns ?? DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY.campaigns,
  itemsPerPage:
    itemsPerPage ?? DEFAULT_AAVE_TYDRO_OPPORTUNITIES_QUERY.itemsPerPage,
});

const clampItemsPerPage = (value) => {
  if (!Number.isFinite(value)) return DEFAULT_ITEMS_PER_PAGE;
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  if (rounded > MAX_ITEMS_PER_PAGE) return MAX_ITEMS_PER_PAGE;
  return rounded;
};

const buildQuery = (query) => {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    params.set(key, String(value));
  });
  return params;
};

const fetchJson = async ({ fetchImpl, url }) => {
  const limitedFetch = createMerklConcurrencyLimitedFetch(fetchImpl);
  const response = await limitedFetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Merkl API ${response.status} for ${url}`);
  }
  return response.json();
};

export const fetchMerklOpportunitiesShortPage = async ({
  baseUrl = 'https://api.merkl.xyz/v4',
  mainProtocolId,
  status,
  campaigns,
  distributionTypes,
  itemsPerPage,
  fetchImpl = fetch,
}) => {
  const normalized = withDefaultAaveTydroQuery({
    mainProtocolId,
    status,
    campaigns,
    itemsPerPage,
    distributionTypes,
  });
  const items = clampItemsPerPage(normalized.itemsPerPage);
  const baseQuery = {
    mainProtocolId: normalized.mainProtocolId,
    status: normalized.status,
    campaigns: normalized.campaigns,
    distributionTypes: normalized.distributionTypes,
    items,
  };

  const aggregated = [];
  for (let page = 0; ; page += 1) {
    const query = buildQuery({
      ...baseQuery,
      page,
    });
    const url = `${baseUrl}/opportunities?${query.toString()}`;
    const payload = await fetchJson({ fetchImpl, url }).catch(() => null);
    if (!Array.isArray(payload)) break;
    aggregated.push(...payload);
    if (payload.length < items) {
      break;
    }
  }
  return aggregated;
};

const buildSnapshotCacheKey = ({
  baseUrl,
  mainProtocolId,
  status,
  campaigns,
  distributionTypes,
  itemsPerPage,
}) => {
  const normalized = withDefaultAaveTydroQuery({
    mainProtocolId,
    status,
    campaigns,
    itemsPerPage,
    distributionTypes,
  });

  return JSON.stringify({
    baseUrl,
    mainProtocolId: normalized.mainProtocolId ?? null,
    status: normalized.status ?? null,
    campaigns: normalized.campaigns ?? null,
    distributionTypes: normalized.distributionTypes ?? null,
    itemsPerPage: clampItemsPerPage(normalized.itemsPerPage),
  });
};

export const fetchMerklOpportunitiesSnapshot = async ({
  baseUrl = 'https://api.merkl.xyz/v4',
  mainProtocolId,
  status,
  campaigns,
  distributionTypes,
  itemsPerPage,
  fetchImpl = fetch,
  ttlMs = DEFAULT_OPPORTUNITIES_SNAPSHOT_TTL_MS,
  forceRefresh = false,
}) => {
  const cacheKey = buildSnapshotCacheKey({
    baseUrl,
    mainProtocolId,
    status,
    campaigns,
    distributionTypes,
    itemsPerPage,
  });
  const now = Date.now();
  const cached = opportunitiesSnapshotCache.get(cacheKey);

  if (!forceRefresh && cached && cached.expiresAt > now && Array.isArray(cached.data)) {
    return cached.data;
  }
  if (!forceRefresh && cached?.inFlight) {
    return cached.inFlight;
  }

  const request = fetchMerklOpportunitiesShortPage({
    baseUrl,
    mainProtocolId,
    status,
    campaigns,
    distributionTypes,
    itemsPerPage,
    fetchImpl,
  })
    .then((result) => {
      opportunitiesSnapshotCache.set(cacheKey, {
        data: result,
        expiresAt: Date.now() + Math.max(0, ttlMs),
      });
      return result;
    })
    .catch((error) => {
      const current = opportunitiesSnapshotCache.get(cacheKey);
      if (current) {
        delete current.inFlight;
        opportunitiesSnapshotCache.set(cacheKey, current);
      }
      throw error;
    });

  opportunitiesSnapshotCache.set(cacheKey, {
    data: cached?.data,
    expiresAt: cached?.expiresAt ?? 0,
    inFlight: request,
  });

  return request;
};

export const __resetMerklOpportunitiesSnapshotCacheForTests = () => {
  opportunitiesSnapshotCache.clear();
};

// ============================================================
// Shared env-var helpers
// ============================================================

/**
 * Read a numeric environment variable with validation.
 * Returns `defaultValue` if the var is missing, non-finite, or below `min`.
 */
export const readNumberEnv = (key, { defaultValue, min }) => {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value)) return defaultValue;
  if (min !== undefined && value < min) return defaultValue;
  return value;
};

// ============================================================
// Shared env-file / Doppler helpers
// ============================================================

/**
 * Parse dotenv-style text (KEY=VALUE lines) into an object.
 * Skips comments (#) and empty lines. Strips surrounding quotes.
 */
export const parseEnvLinesToObject = (envText) => {
  const out = {};
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

/**
 * Inject env vars into process.env, respecting existing values.
 */
export const injectEnv = (envVars) => {
  for (const [key, value] of Object.entries(envVars)) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
};

/**
 * Try to load secrets from Doppler CLI.
 * Returns true if secrets were loaded successfully.
 */
export const tryLoadFromDoppler = () => {
  const dopplerToken = process.env.DOPPLER_TOKEN;

  if (!dopplerToken) {
    console.log('ℹ️  DOPPLER_TOKEN not set in process environment');
    console.log('   💡 Checking if Doppler CLI is configured...');

    try {
      execSync('doppler configure get token --plain', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log('   ✅ Doppler CLI is configured (using config file token)');
    } catch {
      console.log('   ⚠️  Doppler CLI is not configured');
      console.log('   💡 To configure: doppler setup');
      console.log('   💡 Or set DOPPLER_TOKEN environment variable');
      return false;
    }
  } else {
    const tokenPrefix = dopplerToken.substring(0, 10);
    console.log(`✅ DOPPLER_TOKEN found in environment (prefix: ${tokenPrefix}...)`);
  }

  try {
    console.log('🔍 Attempting to fetch secrets from Doppler...');

    const env = dopplerToken ? { ...process.env, DOPPLER_TOKEN: dopplerToken } : process.env;

    const envText = execSync('doppler secrets download --no-file --format env', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env,
    });
    const envVars = parseEnvLinesToObject(envText);
    const envVarKeys = Object.keys(envVars);

    if (envVarKeys.length === 0) {
      console.log('⚠️  Doppler returned no environment variables');
      console.log('   💡 Check your Doppler project configuration');
      return false;
    }

    injectEnv(envVars);
    console.log(`✅ Successfully loaded ${envVarKeys.length} environment variable(s) from Doppler`);
    console.log(`   Variables loaded: ${envVarKeys.join(', ')}`);

    const criticalVars = ['CLOUDFLARE_WORKER_URL'];
    const missingCritical = criticalVars.filter(v => !process.env[v]);
    if (missingCritical.length > 0) {
      console.log(`⚠️  Warning: Critical environment variables not found in Doppler: ${missingCritical.join(', ')}`);
      console.log(`   💡 Please add these variables to your Doppler project`);
    }

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`❌ Failed to fetch secrets from Doppler: ${errorMessage}`);

    if (errorMessage.includes('token') || errorMessage.includes('authentication')) {
      console.log('   💡 This might be a token authentication issue');
      console.log('   💡 Verify DOPPLER_TOKEN is correct and has proper permissions');
    } else if (errorMessage.includes('project') || errorMessage.includes('config')) {
      console.log('   💡 This might be a Doppler project configuration issue');
      console.log('   💡 Run: doppler setup');
    }

    return false;
  }
};
