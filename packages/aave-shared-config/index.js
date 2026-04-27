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

export const AAVE_CHAIN_ID_TO_RPC_KEY = Object.freeze({
  1: 'ethereum',
  10: 'optimism',
  56: 'bnb',
  100: 'gnosis',
  137: 'polygon',
  146: 'sonic',
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
