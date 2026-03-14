const DEFAULT_ITEMS_PER_PAGE = 100;
const MAX_ITEMS_PER_PAGE = 100;
const DEFAULT_OPPORTUNITIES_SNAPSHOT_TTL_MS = 60 * 1000;

const opportunitiesSnapshotCache = new Map();

export const AAVE_PUBLIC_RPC_URLS_BY_CHAIN_KEY = Object.freeze({
  ethereum: Object.freeze([
    'https://ethereum-rpc.publicnode.com',
    'https://eth-mainnet.public.blastapi.io',
    'https://rpc.ankr.com/eth',
    'https://eth.drpc.org',
    'https://cloudflare-eth.com',
    'https://1rpc.io/eth',
  ]),
  polygon: Object.freeze([
    'https://gateway.tenderly.co/public/polygon',
    'https://polygon-pokt.nodies.app',
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon-rpc.com',
    'https://polygon-mainnet.public.blastapi.io',
    'https://rpc-mainnet.matic.quiknode.pro',
    'https://polygon.drpc.org',
    'https://1rpc.io/matic',
  ]),
  avalanche: Object.freeze([
    'https://api.avax.network/ext/bc/C/rpc',
    'https://ava-mainnet.public.blastapi.io/ext/bc/C/rpc',
    'https://rpc.ankr.com/avalanche',
    'https://avalanche.drpc.org',
    'https://1rpc.io/avax/c',
    'https://avalanche-c-chain-rpc.publicnode.com',
  ]),
  arbitrum: Object.freeze([
    'https://arb1.arbitrum.io/rpc',
    'https://rpc.ankr.com/arbitrum',
    'https://1rpc.io/arb',
    'https://arbitrum.drpc.org',
    'https://arbitrum-one-rpc.publicnode.com',
  ]),
  base: Object.freeze([
    'https://1rpc.io/base',
    'https://base.llamarpc.com',
    'https://base.publicnode.com',
    'https://base-mainnet.public.blastapi.io',
    'https://base.drpc.org',
  ]),
  optimism: Object.freeze([
    'https://public-op-mainnet.fastnode.io',
    'https://optimism-rpc.publicnode.com',
    'https://optimism.drpc.org',
    'https://1rpc.io/op',
    'https://rpc.ankr.com/optimism',
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
    'https://bsc.publicnode.com',
    'https://bsc-mainnet.public.blastapi.io',
    'https://1rpc.io/bnb',
    'https://bsc.drpc.org',
    'https://rpc.ankr.com/bsc',
  ]),
  scroll: Object.freeze([
    'https://rpc.scroll.io',
    'https://rpc.ankr.com/scroll',
    'https://scroll-rpc.publicnode.com',
    'https://scroll.drpc.org',
    'https://1rpc.io/scroll',
  ]),
  zksync: Object.freeze([
    'https://mainnet.era.zksync.io',
    'https://zksync.drpc.org',
    'https://1rpc.io/zksync2-era',
    'https://rpc.ankr.com/zksync_era',
    'https://zksync-era.public-rpc.com',
  ]),
  linea: Object.freeze([
    'https://1rpc.io/linea',
    'https://linea.drpc.org',
    'https://linea-rpc.publicnode.com',
    'https://rpc.linea.build',
  ]),
  sonic: Object.freeze([
    'https://rpc.soniclabs.com',
    'https://sonic.drpc.org',
    'https://sonic-rpc.publicnode.com',
  ]),
  celo: Object.freeze([
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
    'https://rpc.mantle.xyz',
    'https://mantle.publicnode.com',
    'https://mantle.drpc.org',
    'https://mantle.gateway.tenderly.co',
  ]),
  megaeth: Object.freeze(['https://mainnet.megaeth.com/rpc']),
  plasma: Object.freeze(['https://rpc.plasma.to']),
  ink: Object.freeze([
    'https://ink.drpc.org',
    'https://rpc.inkonchain.com',
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

export const getAavePublicRpcUrlsByChainName = (chainNameOrKey) => {
  const key = resolveAaveRpcChainKey(chainNameOrKey);
  return normalizeHttpUrls(AAVE_PUBLIC_RPC_URLS_BY_CHAIN_KEY[key] ?? []);
};

export const getAavePublicRpcUrlsByChainId = (chainId) => {
  const key = AAVE_CHAIN_ID_TO_RPC_KEY[Number(chainId)];
  if (!key) return [];
  return normalizeHttpUrls(AAVE_PUBLIC_RPC_URLS_BY_CHAIN_KEY[key] ?? []);
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
