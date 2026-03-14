import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { UiPoolDataProvider } from '@aave/contract-helpers';
import * as AaveAddressBook from '@bgd-labs/aave-address-book';
import { Contract } from 'ethers';
import { getAavePublicRpcUrlsByChainId } from '@internal/aave-shared-config';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { logger } from '../logger.js';
import type { MarketWithSpread, RateInputsResponse, ReserveRateInput } from '../types/index.js';
import { getMarketsSnapshot } from './marketsService.js';
import { ethProviderService } from './ethProviderService.js';

const RATE_INPUTS_TTL_MS = BACKEND_CACHE_TTL_MS.realtimeFamily;
const RATE_INPUTS_MAX_STALE_MS = BACKEND_CACHE_TTL_MS.rateInputsServeStaleMax;
const AAVE_API_TIMEOUT_MS = 15_000;
const SUBGRAPH_TIMEOUT_MS = 15_000;
const ONCHAIN_TIMEOUT_MS = 20_000;
const AAVE_API_MAX_RETRIES = 2;
const SUBGRAPH_MAX_RETRIES = 2;

const AAVE_API_URL = 'https://api.v3.aave.com/graphql';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SUBGRAPH_SNAPSHOT_PATH = join(__dirname, '..', '..', '..', 'docs', 'api', 'aave-subgraph-deployments.snapshot.json');
const DEBUG_DATA_DIR = join(__dirname, '..', '..', '..', 'data', 'debug');

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await writeFile(filePath, content, 'utf-8');
}

interface RawFetchResult {
  records: ReserveRateInputInternal[];
  rawPayload: unknown;
  source: 'subgraph' | 'onchain';
  marketName: string;
  chainId: number;
  sourceDetail: string;
}

const SUBGRAPH_QUERY = `
query ReservesRateInputs {
  reserves(first: 1000) {
    underlyingAsset
    decimals
    availableLiquidity
    totalScaledVariableDebt
    variableBorrowIndex
    reserveFactor
    variableRateSlope1
    variableRateSlope2
    baseVariableBorrowRate
    optimalUtilisationRate
  }
}
`;

// Aave API GraphQL query - fetches all markets for given chain IDs
const AAVE_API_QUERY = `
query RateInputs($chainIds: [Int!]!) {
  markets(request: { chainIds: $chainIds }) {
    name
    chain { chainId }
    reserves {
      underlyingToken { address decimals }
      borrowInfo {
        availableLiquidity { amount { raw } }
        total { amount { raw } }
        reserveFactor { raw }
        variableRateSlope1 { raw }
        variableRateSlope2 { raw }
        baseVariableBorrowRate { raw }
        optimalUsageRate { raw }
      }
    }
  }
}
`;

interface SubgraphDeploymentRecord {
  chainId: number | null;
  market?: string | null;
  queryPath?: string | null;
  queryUrlTemplate?: string | null;
}

interface SubgraphSnapshot {
  generatedAt?: string;
  deployments?: SubgraphDeploymentRecord[];
}

interface OnchainFallbackConfig {
  marketName: string;
  chainId: number;
  chainName: string;
  reason: string;
  defaultRpcUrls: string[];
  uiPoolDataProviderAddress: string;
  poolAddressesProvider: string;
}

interface ServiceSnapshot {
  fetchedAt: number;
  data: ReserveRateInputInternal[];
}

type QueryFilters = {
  chainId?: number;
  asset?: string;
  marketName?: string;
};

type AddressBookFallbackEntry = {
  config: OnchainFallbackConfig;
  score: number;
};

type TargetMarket = {
  marketName: string;
  chainId: number;
  marketSlug: string;
  tokenFilter: Set<string>;
};

type RateInputSource = 'subgraph' | 'onchain';

type ReserveRateInputInternal = ReserveRateInput & {
  source: RateInputSource;
  sourceDetail: string;
};

function simplifyErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function configKeyScore(key: string): number {
  let score = 0;
  if (/Sepolia|Fuji/i.test(key)) score += 100;
  if (/Lido|EtherFi/i.test(key)) score += 10;
  if (/Whitelabel/i.test(key)) score += 5;
  score += key.length / 1000;
  return score;
}

function buildFallbackConfigByChainId(): Map<number, OnchainFallbackConfig> {
  const scored = new Map<number, AddressBookFallbackEntry>();
  for (const [key, value] of Object.entries(AaveAddressBook)) {
    if (!key.startsWith('AaveV3')) continue;
    if (!value || typeof value !== 'object') continue;
    const chainIdRaw = (value as Record<string, unknown>).CHAIN_ID;
    const uiPoolDataProviderAddress = (value as Record<string, unknown>).UI_POOL_DATA_PROVIDER;
    const poolAddressesProvider = (value as Record<string, unknown>).POOL_ADDRESSES_PROVIDER;
    const chainId = Number(chainIdRaw);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    if (typeof uiPoolDataProviderAddress !== 'string' || typeof poolAddressesProvider !== 'string') continue;

    const score = configKeyScore(key);
    const current = scored.get(chainId);
    if (current && current.score <= score) continue;

    const chainName = toSnakeCase(key.replace(/^AaveV3/, '') || `chain_${chainId}`);
    const config: OnchainFallbackConfig = {
      marketName: key,
      chainId,
      chainName,
      reason: `Resolved from @bgd-labs/aave-address-book export ${key}.`,
      defaultRpcUrls: getAavePublicRpcUrlsByChainId(chainId),
      uiPoolDataProviderAddress,
      poolAddressesProvider,
    };
    scored.set(chainId, { config, score });
  }

  const output = new Map<number, OnchainFallbackConfig>();
  for (const [chainId, entry] of scored) {
    output.set(chainId, entry.config);
  }
  return output;
}

function buildFallbackConfigByMarketName(): Map<string, OnchainFallbackConfig> {
  const output = new Map<string, OnchainFallbackConfig>();
  for (const [key, value] of Object.entries(AaveAddressBook)) {
    if (!key.startsWith('AaveV3')) continue;
    if (!value || typeof value !== 'object') continue;
    const chainIdRaw = (value as Record<string, unknown>).CHAIN_ID;
    const uiPoolDataProviderAddress = (value as Record<string, unknown>).UI_POOL_DATA_PROVIDER;
    const poolAddressesProvider = (value as Record<string, unknown>).POOL_ADDRESSES_PROVIDER;
    const chainId = Number(chainIdRaw);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    if (typeof uiPoolDataProviderAddress !== 'string' || typeof poolAddressesProvider !== 'string') continue;

    output.set(normalizeMarketName(key), {
      marketName: key,
      chainId,
      chainName: toSnakeCase(key.replace(/^AaveV3/, '') || `chain_${chainId}`),
      reason: `Resolved from @bgd-labs/aave-address-book export ${key}.`,
      defaultRpcUrls: getAavePublicRpcUrlsByChainId(chainId),
      uiPoolDataProviderAddress,
      poolAddressesProvider,
    });
  }
  return output;
}

const FALLBACK_CONFIG_BY_CHAIN_ID = buildFallbackConfigByChainId();
const FALLBACK_CONFIG_BY_MARKET_NAME = buildFallbackConfigByMarketName();

function resolveOnchainFallbackConfig(marketName: string, chainId: number): OnchainFallbackConfig | null {
  const normalizedMarketName = normalizeMarketName(marketName);
  const exact = FALLBACK_CONFIG_BY_MARKET_NAME.get(normalizedMarketName);
  if (exact && exact.chainId === chainId) {
    return exact;
  }

  // Prevent using core fallback for non-core markets, which can silently mismatch rates.
  if (inferSubgraphMarketSlug(marketName) !== 'core') {
    return null;
  }

  return FALLBACK_CONFIG_BY_CHAIN_ID.get(chainId) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeMarketName(value: string): string {
  return value.trim().toLowerCase();
}

function inferSubgraphMarketSlug(marketName: string): string {
  const normalized = normalizeMarketName(marketName);
  if (normalized.includes('lido')) return 'lido';
  if (normalized.includes('etherfi')) return 'etherfi';
  if (normalized.includes('gho')) return 'gho';
  return 'core';
}

function toNumericString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed;
  }
  return String(value);
}

function toReserveDecimals(value: unknown, fallback = 18): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return fallback;
}

function hasRequiredRateInputFields(reserve: Record<string, unknown>): boolean {
  const requiredKeys = [
    'availableLiquidity',
    'totalScaledVariableDebt',
    'variableBorrowIndex',
    'reserveFactor',
    'variableRateSlope1',
    'variableRateSlope2',
    'baseVariableBorrowRate',
  ];
  for (const key of requiredKeys) {
    if (!Object.hasOwn(reserve, key)) return false;
  }
  // Accept empty/null values, but field key must exist in response.
  return Object.hasOwn(reserve, 'optimalUsageRatio') || Object.hasOwn(reserve, 'optimalUtilisationRate');
}

function withPromiseTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface AaveApiReserve {
  underlyingToken: { address: string; decimals: number };
  borrowInfo: {
    availableLiquidity: { amount: { raw: string } };
    total: { amount: { raw: string } };
    deficit?: { amount?: { raw?: string }; raw?: string } | string | number;
    reserveFactor: { raw: string };
    variableRateSlope1: { raw: string };
    variableRateSlope2: { raw: string };
    baseVariableBorrowRate: { raw: string };
    optimalUsageRate: { raw: string };
  };
}

interface AaveApiMarket {
  name: string;
  chain: { chainId: number };
  reserves: AaveApiReserve[];
}

const POOL_ADDRESSES_PROVIDER_ABI = [
  'function getPool() view returns (address)',
];

const POOL_DEFICIT_ABI = [
  'function getReserveDeficit(address asset) view returns (uint256)',
];

async function fetchReserveDeficitMap(
  provider: unknown,
  poolAddressesProvider: string,
  tokenAddresses: string[]
): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  if (tokenAddresses.length === 0) return output;

  const addressProvider = new Contract(
    poolAddressesProvider,
    POOL_ADDRESSES_PROVIDER_ABI,
    provider as any
  );
  const poolAddress = await addressProvider.getPool();
  const pool = new Contract(poolAddress, POOL_DEFICIT_ABI, provider as any);

  const deficits = await Promise.all(
    tokenAddresses.map(async (asset) => {
      try {
        const value = await pool.getReserveDeficit(asset);
        return { asset, value: value?.toString?.() ?? String(value ?? '0') };
      } catch {
        return { asset, value: '0' };
      }
    })
  );

  for (const item of deficits) {
    output.set(normalizeAddress(item.asset), item.value);
  }
  return output;
}

interface AaveApiResponse {
  data?: { markets?: AaveApiMarket[] };
  errors?: Array<{ message?: string }>;
}

async function fetchAaveApiChains(chainIds: number[]): Promise<RawFetchResult[]> {
  const results: RawFetchResult[] = [];

  for (let attempt = 0; attempt <= AAVE_API_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AAVE_API_TIMEOUT_MS);
      const response = await fetch(AAVE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: AAVE_API_QUERY,
          variables: { chainIds },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as AaveApiResponse;

      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const msg = payload.errors.map((item) => item.message || 'unknown').join('; ');
        throw new Error(msg);
      }

      const markets = payload.data?.markets ?? [];
      for (const market of markets) {
        const chainId = market.chain?.chainId;
        const marketName = market.name;
        if (!chainId || !marketName) continue;

        const records: ReserveRateInputInternal[] = [];
        for (const reserve of market.reserves ?? []) {
          const address = reserve.underlyingToken?.address;
          if (!address) continue;

          const borrowInfo = reserve.borrowInfo;
          if (!borrowInfo) continue;

          // Aave API returns totalDebt as borrowInfo.total, not scaledDebt + index
          // We'll use totalDebt directly and set index to RAY (1e27) as placeholder
          const totalDebt = toNumericString(borrowInfo.total?.amount?.raw);
          const RAY_STR = '1000000000000000000000000000'; // 1e27
          records.push({
            marketName,
            chainId,
            tokenAddress: normalizeAddress(address),
            decimals: toReserveDecimals(reserve.underlyingToken?.decimals),
            deficit: '0',
            availableLiquidity: toNumericString(borrowInfo.availableLiquidity?.amount?.raw),
            // For API source, we provide totalDebt directly
            // scaledDebt = totalDebt when index = RAY
            totalScaledVariableDebt: totalDebt,
            variableBorrowIndex: RAY_STR,
            reserveFactor: toNumericString(borrowInfo.reserveFactor?.raw),
            variableRateSlope1: toNumericString(borrowInfo.variableRateSlope1?.raw),
            variableRateSlope2: toNumericString(borrowInfo.variableRateSlope2?.raw),
            baseVariableBorrowRate: toNumericString(borrowInfo.baseVariableBorrowRate?.raw),
            optimalUsageRate: toNumericString(borrowInfo.optimalUsageRate?.raw),
            source: 'onchain', // Mark as 'onchain' since API data is real-time like on-chain
            sourceDetail: 'api.v3.aave.com',
          });
        }

        if (records.length > 0) {
          results.push({
            records,
            rawPayload: market,
            source: 'onchain',
            marketName,
            chainId,
            sourceDetail: 'api.v3.aave.com',
          });
        }
      }

      return results;
    } catch (error) {
      if (attempt >= AAVE_API_MAX_RETRIES) throw error;
      const delayMs = 300 * Math.pow(2, attempt);
      await sleep(delayMs);
    }
  }

  return results;
}

function pickPreferredDeployment(
  current: SubgraphDeploymentRecord | undefined,
  candidate: SubgraphDeploymentRecord
): SubgraphDeploymentRecord {
  if (!current) return candidate;

  const currentIsId = (current.queryPath || '').startsWith('id/');
  const candidateIsId = (candidate.queryPath || '').startsWith('id/');
  if (!currentIsId && candidateIsId) return candidate;

  return current;
}

function subgraphDeploymentKey(chainId: number, marketSlug: string): string {
  return `${chainId}:${marketSlug}`;
}

function normalizeSubgraphMarketSlug(raw: string | null | undefined): string {
  const normalized = String(raw || 'core').trim().toLowerCase();
  return normalized || 'core';
}

async function loadSubgraphDeployments(): Promise<Map<string, SubgraphDeploymentRecord>> {
  try {
    const raw = await readFile(SUBGRAPH_SNAPSHOT_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SubgraphSnapshot;
    const deployments = Array.isArray(parsed.deployments) ? parsed.deployments : [];
    const map = new Map<string, SubgraphDeploymentRecord>();
    for (const deployment of deployments) {
      if (!deployment.chainId || !deployment.queryPath || !deployment.queryUrlTemplate) continue;
      const marketSlug = normalizeSubgraphMarketSlug(deployment.market);
      const key = subgraphDeploymentKey(deployment.chainId, marketSlug);
      const picked = pickPreferredDeployment(map.get(key), deployment);
      map.set(key, picked);
    }
    return map;
  } catch {
    // Subgraph snapshot is optional; silently return empty map if unavailable
    return new Map<string, SubgraphDeploymentRecord>();
  }
}

function resolveSubgraphDeployment(
  deployments: Map<string, SubgraphDeploymentRecord>,
  chainId: number,
  marketSlug: string
): SubgraphDeploymentRecord | null {
  const exact = deployments.get(subgraphDeploymentKey(chainId, marketSlug));
  if (exact) return exact;
  return deployments.get(subgraphDeploymentKey(chainId, 'core')) ?? null;
}

function buildTargetMarketMap(rows: MarketWithSpread[]): Map<string, TargetMarket> {
  const marketMap = new Map<string, TargetMarket>();
  for (const row of rows) {
    if (!row.chainId || !row.tokenAddress || !row.marketName) continue;
    const tokenAddress = normalizeAddress(row.tokenAddress);
    const key = normalizeMarketName(row.marketName);
    const existing = marketMap.get(key);
    if (!existing) {
      marketMap.set(key, {
        marketName: row.marketName,
        chainId: row.chainId,
        marketSlug: inferSubgraphMarketSlug(row.marketName),
        tokenFilter: new Set([tokenAddress]),
      });
      continue;
    }

    if (existing.chainId !== row.chainId) {
      logger.warn(
        `Market name ${row.marketName} appeared with multiple chain IDs (${existing.chainId}, ${row.chainId}); keeping first.`
      );
      continue;
    }

    existing.tokenFilter.add(tokenAddress);
  }
  return marketMap;
}

function resolveSubgraphUrl(record: SubgraphDeploymentRecord): string | null {
  const template = record.queryUrlTemplate;
  if (!template) return null;
  if (!template.includes('{apiKey}')) return template;

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) return null;
  return template.replace('{apiKey}', encodeURIComponent(apiKey));
}

function computeMissingTokenFilter(tokenFilter: Set<string>, records: ReserveRateInputInternal[]): Set<string> {
  if (tokenFilter.size === 0) return new Set<string>();
  const found = new Set(records.map((item) => item.tokenAddress));
  const missing = new Set<string>();
  for (const tokenAddress of tokenFilter) {
    if (!found.has(tokenAddress)) missing.add(tokenAddress);
  }
  return missing;
}

async function fetchSubgraphChain(
  marketName: string,
  chainId: number,
  deployment: SubgraphDeploymentRecord,
  tokenFilter: Set<string>
): Promise<RawFetchResult> {
  const url = resolveSubgraphUrl(deployment);
  if (!url) throw new Error(`subgraph url unavailable for chain ${chainId} (missing THE_GRAPH_API_KEY?)`);
  const sourceDetail = deployment.queryPath || 'subgraph';

  for (let attempt = 0; attempt <= SUBGRAPH_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: SUBGRAPH_QUERY }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as {
        data?: { reserves?: Array<Record<string, unknown>> };
        errors?: Array<{ message?: string }>;
      };

      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const msg = payload.errors.map((item) => item.message || 'unknown').join('; ');
        throw new Error(msg);
      }

      const reserves = payload.data?.reserves ?? [];
      const records: ReserveRateInputInternal[] = [];
      for (const reserve of reserves) {
        const underlyingAsset = String(reserve.underlyingAsset || '').trim();
        if (!underlyingAsset) continue;
        const tokenAddress = normalizeAddress(underlyingAsset);
        if (tokenFilter.size > 0 && !tokenFilter.has(tokenAddress)) continue;
        if (!hasRequiredRateInputFields(reserve)) continue;
        records.push({
          marketName,
          chainId,
          tokenAddress,
          decimals: toReserveDecimals(reserve.decimals),
          deficit: toNumericString(reserve.deficit) || '0',
          availableLiquidity: toNumericString(reserve.availableLiquidity),
          totalScaledVariableDebt: toNumericString(reserve.totalScaledVariableDebt),
          variableBorrowIndex: toNumericString(reserve.variableBorrowIndex),
          reserveFactor: toNumericString(reserve.reserveFactor),
          variableRateSlope1: toNumericString(reserve.variableRateSlope1),
          variableRateSlope2: toNumericString(reserve.variableRateSlope2),
          baseVariableBorrowRate: toNumericString(reserve.baseVariableBorrowRate),
          optimalUsageRate: toNumericString(
            reserve.optimalUsageRatio ?? reserve.optimalUtilisationRate
          ),
          source: 'subgraph',
          sourceDetail,
        });
      }
      return {
        records,
        rawPayload: payload,
        source: 'subgraph',
        marketName,
        chainId,
        sourceDetail,
      };
    } catch (error) {
      if (attempt >= SUBGRAPH_MAX_RETRIES) throw error;
      const delayMs = 300 * Math.pow(2, attempt);
      await sleep(delayMs);
    }
  }
  return {
    records: [],
    rawPayload: null,
    source: 'subgraph',
    marketName,
    chainId,
    sourceDetail,
  };
}

async function fetchOnchainChain(
  config: OnchainFallbackConfig,
  tokenFilter: Set<string>,
  marketNameOverride?: string
): Promise<RawFetchResult> {
  const effectiveMarketName = marketNameOverride ?? config.marketName;
  const rpcCandidates = ethProviderService.getProvidersForChain(config.chainId, config.defaultRpcUrls);
  let lastError: unknown = null;

  for (const candidate of rpcCandidates) {
    const { rpcUrl, provider } = candidate;
    try {
      const uiPoolDataProvider = new UiPoolDataProvider({
        uiPoolDataProviderAddress: config.uiPoolDataProviderAddress,
        provider,
        chainId: config.chainId,
      });
      const humanized = await withPromiseTimeout(
        uiPoolDataProvider.getReservesHumanized({
          lendingPoolAddressProvider: config.poolAddressesProvider,
        }),
        ONCHAIN_TIMEOUT_MS,
        `on-chain fetch timeout for chain ${config.chainId}`
      );
      const reserves = (humanized as unknown as { reservesData?: Array<Record<string, unknown>> }).reservesData ?? [];
      const deficitByAsset = await fetchReserveDeficitMap(
        provider,
        config.poolAddressesProvider,
        reserves
          .map((reserve) => String(reserve.underlyingAsset || '').trim())
          .filter(Boolean)
      );

      const records: ReserveRateInputInternal[] = [];
      for (const reserve of reserves) {
        const underlyingAsset = String(reserve.underlyingAsset || '').trim();
        if (!underlyingAsset) continue;
        const tokenAddress = normalizeAddress(underlyingAsset);
        if (tokenFilter.size > 0 && !tokenFilter.has(tokenAddress)) continue;
        if (!hasRequiredRateInputFields(reserve)) continue;
        records.push({
          marketName: effectiveMarketName,
          chainId: config.chainId,
          tokenAddress,
          decimals: toReserveDecimals(reserve.decimals),
          deficit: toNumericString(deficitByAsset.get(tokenAddress) ?? reserve.deficit) || '0',
          availableLiquidity: toNumericString(reserve.availableLiquidity),
          totalScaledVariableDebt: toNumericString(reserve.totalScaledVariableDebt),
          variableBorrowIndex: toNumericString(reserve.variableBorrowIndex),
          reserveFactor: toNumericString(reserve.reserveFactor),
          variableRateSlope1: toNumericString(reserve.variableRateSlope1),
          variableRateSlope2: toNumericString(reserve.variableRateSlope2),
          baseVariableBorrowRate: toNumericString(reserve.baseVariableBorrowRate),
          optimalUsageRate: toNumericString(reserve.optimalUsageRatio),
          source: 'onchain',
          sourceDetail: `rpc:${rpcUrl}`,
        });
      }

      if (records.length === 0 && tokenFilter.size > 0) {
        logger.warn(`On-chain fetch succeeded but no reserve matched filter on chain ${config.chainId} market ${effectiveMarketName}`);
      }
      ethProviderService.reportProviderSuccess(config.chainId, rpcUrl);
      return {
        records,
        rawPayload: humanized,
        source: 'onchain',
        marketName: effectiveMarketName,
        chainId: config.chainId,
        sourceDetail: `rpc:${rpcUrl}`,
      };
    } catch (error) {
      lastError = error;
      const message = simplifyErrorMessage(error);
      ethProviderService.reportProviderFailure(config.chainId, rpcUrl, message);
      logger.warn(`On-chain fallback failed for chain ${config.chainId} via ${rpcUrl}: ${message}`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`No RPC endpoint succeeded for chain ${config.chainId}`);
}

class RateInputsService {
  private snapshot: ServiceSnapshot | null = null;
  private inFlightRefresh: Promise<ServiceSnapshot> | null = null;

  private isStale(): boolean {
    if (!this.snapshot) return true;
    return Date.now() - this.snapshot.fetchedAt > RATE_INPUTS_TTL_MS;
  }

  async refreshSnapshot(): Promise<ServiceSnapshot> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    this.inFlightRefresh = this.doRefreshSnapshot().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async doRefreshSnapshot(): Promise<ServiceSnapshot> {
    const marketsSnapshot = getMarketsSnapshot();
    if (!marketsSnapshot) {
      logger.warn('Markets snapshot not available for rate-inputs refresh');
      return {
        data: [],
        fetchedAt: Date.now(),
      };
    }
    const marketRows = marketsSnapshot.payload.data;
    const targetMarkets = buildTargetMarketMap(marketRows);
    const deployments = await loadSubgraphDeployments();
    const hasGraphApiKey = Boolean(process.env.THE_GRAPH_API_KEY);

    const records: ReserveRateInputInternal[] = [];
    const seen = new Set<string>();
    const apiChains = new Set<number>();
    const onchainChains = new Set<number>();
    const subgraphChains = new Set<number>();
    const rawFetchResults: RawFetchResult[] = [];

    const targets = Array.from(targetMarkets.values()).sort(
      (a, b) => (a.chainId - b.chainId) || a.marketName.localeCompare(b.marketName)
    );

    const hasAnyRecordForTarget = (target: TargetMarket): boolean =>
      records.some(
        (r) =>
          r.chainId === target.chainId &&
          normalizeMarketName(r.marketName) === normalizeMarketName(target.marketName)
      );

    // 1) On-chain first (highest priority, deficit-aware)
    await Promise.all(
      targets.map(async (target) => {
        const { chainId, marketName, tokenFilter } = target;
        const onchainConfig = resolveOnchainFallbackConfig(marketName, chainId);
        if (!onchainConfig) return;
        try {
          const onchainResult = await fetchOnchainChain(onchainConfig, tokenFilter, marketName);
          rawFetchResults.push(onchainResult);
          if (onchainResult.records.length === 0) return;
          onchainChains.add(chainId);
          for (const item of onchainResult.records) {
            const key = `${normalizeMarketName(item.marketName)}:${item.chainId}:${item.tokenAddress}`;
            if (seen.has(key)) continue;
            seen.add(key);
            records.push(item);
          }
        } catch (error) {
          logger.warn(
            `On-chain fetch failed for chain ${chainId} market ${marketName}: ${
              error instanceof Error ? error.message : String(error)
            }; will try Aave API/subgraph fallback.`
          );
        }
      })
    );

    // 2) Aave API fallback for markets still missing
    const marketsMissingAfterOnchain = targets.filter((target) => !hasAnyRecordForTarget(target));
    if (marketsMissingAfterOnchain.length > 0) {
      const fallbackChainIds = [...new Set(marketsMissingAfterOnchain.map((t) => t.chainId))];
      const fallbackTargetMap = new Map<string, TargetMarket>();
      for (const target of marketsMissingAfterOnchain) {
        fallbackTargetMap.set(`${normalizeMarketName(target.marketName)}:${target.chainId}`, target);
      }
      try {
        logger.info(`🌐 Fallback: fetching ${fallbackChainIds.length} chain(s) from Aave API...`);
        const apiResults = await fetchAaveApiChains(fallbackChainIds);
        for (const result of apiResults) {
          rawFetchResults.push(result);
          for (const item of result.records) {
            const target = fallbackTargetMap.get(
              `${normalizeMarketName(item.marketName)}:${item.chainId}`
            );
            if (!target) continue;
            if (target.tokenFilter.size > 0 && !target.tokenFilter.has(item.tokenAddress)) continue;
            const key = `${normalizeMarketName(item.marketName)}:${item.chainId}:${item.tokenAddress}`;
            if (seen.has(key)) continue;
            seen.add(key);
            records.push(item);
            apiChains.add(item.chainId);
          }
        }
      } catch (error) {
        logger.warn(
          `Aave API fallback failed: ${error instanceof Error ? error.message : String(error)}; will try subgraph fallback.`
        );
      }
    }

    // 3) Subgraph last resort
    const marketsMissingAfterApi = targets.filter((target) => !hasAnyRecordForTarget(target));
    if (marketsMissingAfterApi.length > 0) {
      logger.info(`📡 ${marketsMissingAfterApi.length} market(s) still missing; trying subgraph fallback...`);
    }

    await Promise.all(
      marketsMissingAfterApi.map(async (target) => {
        const { chainId, marketName, marketSlug, tokenFilter } = target;
        const deployment = resolveSubgraphDeployment(deployments, chainId, marketSlug);
        if (!deployment) return;
        const requiresApiKey = (deployment.queryUrlTemplate || '').includes('{apiKey}');
        if (requiresApiKey && !hasGraphApiKey) {
          logger.warn(`Subgraph for chain ${chainId} requires API key but THE_GRAPH_API_KEY not set.`);
          return;
        }
        try {
          const subgraphResult = await fetchSubgraphChain(marketName, chainId, deployment, tokenFilter);
          rawFetchResults.push(subgraphResult);
          if (subgraphResult.records.length === 0) return;
          subgraphChains.add(chainId);
          logger.info(`📊 Using subgraph fallback for chain ${chainId} market ${marketName}`);
          for (const item of subgraphResult.records) {
            const key = `${normalizeMarketName(item.marketName)}:${item.chainId}:${item.tokenAddress}`;
            if (seen.has(key)) continue;
            seen.add(key);
            records.push(item);
          }
        } catch (error) {
          logger.warn(
            `Subgraph fallback failed for chain ${chainId} market ${marketName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      })
    );

    // Write debug raw data
    try {
      await mkdir(DEBUG_DATA_DIR, { recursive: true });
      const debugPath = join(DEBUG_DATA_DIR, 'rate-inputs-raw-data.json');
      const sortedResults = rawFetchResults.sort(
        (a, b) => (a.chainId - b.chainId) || a.marketName.localeCompare(b.marketName)
      );
      await writeJsonAtomic(debugPath, {
        timestamp: new Date().toISOString(),
        totalFetches: sortedResults.length,
        subgraphFetches: sortedResults.filter((r) => r.source === 'subgraph').length,
        onchainFetches: sortedResults.filter((r) => r.source === 'onchain').length,
        fetches: sortedResults.map((r) => ({
          source: r.source,
          marketName: r.marketName,
          chainId: r.chainId,
          sourceDetail: r.sourceDetail,
          recordsCount: r.records.length,
          rawPayload: r.rawPayload,
        })),
      });
      logger.info(`💾 Rate-inputs debug data saved to ${debugPath}`);
    } catch (error) {
      logger.warn(`Failed to write rate-inputs debug data: ${error instanceof Error ? error.message : String(error)}`);
    }

    const snapshot: ServiceSnapshot = {
      fetchedAt: Date.now(),
      data: records.sort(
        (a, b) =>
          (a.chainId - b.chainId) ||
          a.marketName.localeCompare(b.marketName) ||
          a.tokenAddress.localeCompare(b.tokenAddress)
      ),
    };

    logger.info(
      `✅ Rate-inputs refresh complete: ${records.length} reserves, ` +
      `${onchainChains.size} chains via on-chain (primary), ` +
      `${apiChains.size} chains via Aave API (fallback), ` +
      `${subgraphChains.size} chains via subgraph (last resort)`
    );

    this.snapshot = snapshot;
    return snapshot;
  }

  async getRateInputs(filters: QueryFilters): Promise<RateInputsResponse> {
    // Cron-write/API-read-only pattern: API requests never trigger refresh.
    // Cron (every 1 min) + startup warmup handle all refreshes.
    const snapshot = this.snapshot;

    if (!snapshot) {
      // Cold start before cron/warmup runs - return empty with warning.
      logger.warn('Rate-inputs snapshot not yet populated; returning empty response');
      return {
        data: [],
        lastUpdated: new Date().toISOString(),
        staleTimeMs: RATE_INPUTS_TTL_MS,
      };
    }

    let filtered = snapshot.data;
    if (filters.chainId !== undefined) {
      filtered = filtered.filter((item) => item.chainId === filters.chainId);
    }
    if (filters.asset) {
      const asset = normalizeAddress(filters.asset);
      filtered = filtered.filter((item) => item.tokenAddress === asset);
    }
    if (filters.marketName) {
      const marketName = normalizeMarketName(filters.marketName);
      filtered = filtered.filter((item) => normalizeMarketName(item.marketName) === marketName);
    }

    const publicData: ReserveRateInput[] = filtered.map(({ source: _source, sourceDetail: _sourceDetail, ...item }) => item);

    return {
      data: publicData,
      lastUpdated: new Date(snapshot.fetchedAt).toISOString(),
      staleTimeMs: RATE_INPUTS_TTL_MS,
    };
  }

  /**
   * Get rate-inputs as a Map for quick lookup by chainId-tokenAddress.
   * Used by marketsController to merge rate-inputs into reserves.
   * Returns null if snapshot not yet populated.
   */
  getRateInputsMap(): Map<string, ReserveRateInput> | null {
    if (!this.snapshot) {
      return null;
    }

    const map = new Map<string, ReserveRateInput>();
    for (const item of this.snapshot.data) {
      // Key: chainId-tokenAddress (lowercase)
      const key = `${item.chainId}-${item.tokenAddress.toLowerCase()}`;
      // Strip internal fields (source, sourceDetail) before exposing
      const { source: _source, sourceDetail: _sourceDetail, ...publicItem } = item;
      map.set(key, publicItem);
    }
    return map;
  }

  /**
   * Check if rate-inputs snapshot is available.
   */
  hasSnapshot(): boolean {
    return this.snapshot !== null;
  }
}

export const rateInputsService = new RateInputsService();

export async function warmRateInputsCache(): Promise<void> {
  await rateInputsService.refreshSnapshot();
}

/**
 * Get rate-inputs as a Map for quick lookup by reserveId (marketName:chainId:tokenAddress).
 * Used by marketsController to merge rate-inputs into markets response.
 * Returns null if snapshot not yet populated.
 */
export function getRateInputsMap(): Map<string, ReserveRateInput> | null {
  const snapshot = rateInputsService['snapshot'];
  if (!snapshot) {
    return null;
  }

  const map = new Map<string, ReserveRateInput>();
  for (const item of snapshot.data) {
    // Key format matches reserveId: marketName:chainId:tokenAddress
    const key = `${item.marketName}:${item.chainId}:${item.tokenAddress.toLowerCase()}`;
    // Strip internal fields (source, sourceDetail) before exposing
    const { source: _source, sourceDetail: _sourceDetail, ...publicItem } = item as any;
    map.set(key, publicItem);
  }
  return map;
}
