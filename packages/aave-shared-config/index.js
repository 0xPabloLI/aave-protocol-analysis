const DEFAULT_ITEMS_PER_PAGE = 100;
const MAX_ITEMS_PER_PAGE = 100;
const DEFAULT_OPPORTUNITIES_SNAPSHOT_TTL_MS = 60 * 1000;

const opportunitiesSnapshotCache = new Map();

const {
  INFURA_PROJECT_ID,
  // QUICKNODE_API_KEY, // no free plan – commented out
  ALCHEMY_API_KEY,
  ANKR_API_KEY,
} = process.env;

export const AAVE_RPC_URLS_BY_CHAIN_KEY = Object.freeze({
  ethereum: Object.freeze([
    `https://mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    // `https://cosmological-solitary-uranium.quiknode.pro/${QUICKNODE_API_KEY}`,
    `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    'https://ethereum-rpc.publicnode.com',
    'https://eth-mainnet.public.blastapi.io',
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
  ]),
  polygon: Object.freeze([
    `https://polygon-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    'https://gateway.tenderly.co/public/polygon',
    'https://polygon-pokt.nodies.app',
    'https://polygon-bor-rpc.publicnode.com',
    'https://rpc-mainnet.matic.quiknode.pro',
    'https://polygon.drpc.org',
    'https://1rpc.io/matic',
  ]),
  avalanche: Object.freeze([
    `https://avalanche-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    'https://api.avax.network/ext/bc/C/rpc',
    'https://avalanche.drpc.org',
    'https://1rpc.io/avax/c',
    'https://avalanche-c-chain-rpc.publicnode.com',
  ]),
  arbitrum: Object.freeze([
    `https://arbitrum-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    'https://arb1.arbitrum.io/rpc',
    'https://1rpc.io/arb',
    'https://arbitrum.drpc.org',
    'https://arbitrum-one-rpc.publicnode.com',
  ]),
  base: Object.freeze([
    `https://base-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    // `https://cosmological-solitary-uranium.base-mainnet.quiknode.pro/${QUICKNODE_API_KEY}`,
    // `https://rpc.ankr.com/base/${ANKR_API_KEY}`, // fetch failed in connectivity test
    'https://1rpc.io/base',
    'https://base.llamarpc.com',
    'https://base.publicnode.com',
    'https://base-mainnet.public.blastapi.io',
    'https://base.drpc.org',
  ]),
  optimism: Object.freeze([
    `https://optimism-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    'https://public-op-mainnet.fastnode.io',
    'https://optimism-rpc.publicnode.com',
    'https://optimism.drpc.org',
    'https://1rpc.io/op',
  ]),
  metis: Object.freeze([
    'https://andromeda.metis.io/?owner=1088',
    'https://metis-rpc.publicnode.com',
    'https://metis.drpc.org',
    'https://metis-andromeda.gateway.tenderly.co',
  ]),
  gnosis: Object.freeze([
    'https://gnosis-rpc.publicnode.com',
    'https://rpc.gnosischain.com',
    'https://1rpc.io/gnosis',
    'https://gnosis.drpc.org',
    'https://gnosis.api.onfinality.io/public',
  ]),
  bnb: Object.freeze([
    // `https://bsc-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`, // HTTP 401 – Infura may not support BSC
    `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    'https://bsc.publicnode.com',
    'https://bsc-mainnet.public.blastapi.io',
    'https://1rpc.io/bnb',
    'https://bsc.drpc.org',
  ]),
  scroll: Object.freeze([
    // `https://scroll-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`, // HTTP 401 – Infura may not support Scroll
    'https://rpc.scroll.io',
    'https://scroll-rpc.publicnode.com',
    'https://scroll.drpc.org',
    'https://1rpc.io/scroll',
  ]),
  zksync: Object.freeze([
    // `https://zksync-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`, // HTTP 401 – Infura may not support zkSync
    `https://rpc.ankr.com/zksync_era/${ANKR_API_KEY}`,
    'https://mainnet.era.zksync.io',
    'https://zksync.drpc.org',
    'https://1rpc.io/zksync2-era',
    'https://rpc.ankr.com/zksync_era',
    'https://zksync-era.public-rpc.com',
  ]),
  linea: Object.freeze([
    `https://linea-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    'https://1rpc.io/linea',
    'https://linea.drpc.org',
    'https://linea-rpc.publicnode.com',
    'https://rpc.linea.build',
  ]),
  sonic: Object.freeze([
    `https://sonic-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    // `https://rpc.ankr.com/sonic_mainnet/${ANKR_API_KEY}`, // HTTP 403 in connectivity test
    'https://rpc.soniclabs.com',
    'https://sonic.drpc.org',
    'https://sonic-rpc.publicnode.com',
  ]),
  celo: Object.freeze([
    `https://celo-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
    'https://rpc.ankr.com/celo',
    'https://celo.drpc.org',
    'https://forno.celo.org',
    'https://celo-mainnet.gateway.tatum.io',
  ]),
  soneium: Object.freeze([
    'https://soneium.drpc.org',
    'https://rpc.soneium.org',
    'https://soneium-rpc.publicnode.com',
    'https://soneium.gateway.tenderly.co',
  ]),
  mantle: Object.freeze([
    // `https://mantle-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`, // HTTP 401 – Infura may not support Mantle
    'https://rpc.mantle.xyz',
    'https://mantle.publicnode.com',
    'https://mantle.drpc.org',
    'https://mantle.gateway.tenderly.co',
  ]),
  megaeth: Object.freeze(['https://mainnet.megaeth.com/rpc']),
  plasma: Object.freeze(['https://rpc.plasma.to']),
  ink: Object.freeze([
    `https://ink-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    'https://ink.drpc.org',
  ]),
  blast: Object.freeze([
    // `https://blast-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`, // HTTP 401 – Infura may not support Blast
    'https://rpc.blast.io',
    'https://blast.drpc.org',
    'https://blast-rpc.publicnode.com',
  ]),
  palm: Object.freeze([
    `https://palm-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`,
  ]),
  opbnb: Object.freeze([
    // `https://opbnb-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`, // HTTP 401 – Infura may not support opBNB
    'https://opbnb-mainnet-rpc.bnbchain.org',
    'https://opbnb.drpc.org',
    'https://opbnb-rpc.publicnode.com',
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
    `https://berachain-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    'https://rpc.berachain.com',
    'https://berachain.drpc.org',
    'https://berachain-rpc.publicnode.com',
  ]),
  abstract: Object.freeze([
    `https://abstract-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    // `https://cosmological-solitary-uranium.abstract-mainnet.quiknode.pro/${QUICKNODE_API_KEY}`,
  ]),
  flare: Object.freeze([
    `https://rpc.ankr.com/flare/${ANKR_API_KEY}`,
    // `https://cosmological-solitary-uranium.flare-mainnet.quiknode.pro/${QUICKNODE_API_KEY}`,
    'https://flare-api.flare.network/ext/C/rpc',
    'https://rpc.ankr.com/flare',
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
  const response = await fetchImpl(url, {
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
