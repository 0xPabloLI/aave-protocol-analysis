import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { UiPoolDataProvider } from '@aave/contract-helpers';
import * as AaveAddressBook from '@bgd-labs/aave-address-book';
import { getAavePublicRpcUrlsByChainId } from '@internal/aave-shared-config';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { logger } from '../logger.js';
import type { MarketWithSpread, RateInputsResponse, ReserveRateInput } from '../types/index.js';
import { dataService } from './dataService.js';
import { ethProviderService } from './ethProviderService.js';

const RATE_INPUTS_TTL_MS = BACKEND_CACHE_TTL_MS.realtimeFamily;
const RATE_INPUTS_MAX_STALE_MS = BACKEND_CACHE_TTL_MS.rateInputsServeStaleMax;
const SUBGRAPH_TIMEOUT_MS = 15_000;
const ONCHAIN_TIMEOUT_MS = 20_000;
const SUBGRAPH_MAX_RETRIES = 2;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SUBGRAPH_SNAPSHOT_PATH = join(__dirname, '..', '..', '..', 'docs', 'api', 'aave-subgraph-deployments.snapshot.json');

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
  sources: RateInputsResponse['sources'];
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
  } catch (error) {
    logger.warn(`Failed to load subgraph deployment snapshot (${SUBGRAPH_SNAPSHOT_PATH}): ${error instanceof Error ? error.message : String(error)}`);
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
): Promise<ReserveRateInputInternal[]> {
  const url = resolveSubgraphUrl(deployment);
  if (!url) throw new Error(`subgraph url unavailable for chain ${chainId} (missing THE_GRAPH_API_KEY?)`);

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
        // Keep API payload focused on hypothetical-TVL inputs; liquidityRate/variableBorrowRate are intentionally omitted.
        records.push({
          marketName,
          chainId,
          tokenAddress,
          decimals: toReserveDecimals(reserve.decimals),
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
          sourceDetail: deployment.queryPath || 'subgraph',
        });
      }
      return records;
    } catch (error) {
      if (attempt >= SUBGRAPH_MAX_RETRIES) throw error;
      const delayMs = 300 * Math.pow(2, attempt);
      await sleep(delayMs);
    }
  }
  return [];
}

async function fetchOnchainChain(
  config: OnchainFallbackConfig,
  tokenFilter: Set<string>,
  marketNameOverride?: string
): Promise<ReserveRateInputInternal[]> {
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

      const records: ReserveRateInputInternal[] = [];
      for (const reserve of reserves) {
        const underlyingAsset = String(reserve.underlyingAsset || '').trim();
        if (!underlyingAsset) continue;
        const tokenAddress = normalizeAddress(underlyingAsset);
        if (tokenFilter.size > 0 && !tokenFilter.has(tokenAddress)) continue;
        if (!hasRequiredRateInputFields(reserve)) continue;
        // Keep API payload focused on hypothetical-TVL inputs; liquidityRate/variableBorrowRate are intentionally omitted.
        records.push({
          marketName: effectiveMarketName,
          chainId: config.chainId,
          tokenAddress,
          decimals: toReserveDecimals(reserve.decimals),
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
      return records;
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

  private async refreshSnapshot(): Promise<ServiceSnapshot> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    this.inFlightRefresh = this.doRefreshSnapshot().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async doRefreshSnapshot(): Promise<ServiceSnapshot> {
    const marketRows = await dataService.getData();
    const targetMarkets = buildTargetMarketMap(marketRows);
    const deployments = await loadSubgraphDeployments();
    const hasGraphApiKey = Boolean(process.env.THE_GRAPH_API_KEY);
    if (!hasGraphApiKey) {
      logger.warn('THE_GRAPH_API_KEY not set: gateway subgraph chains will be skipped (legacy direct URLs still attempted).');
    }

    const records: ReserveRateInputInternal[] = [];
    const seen = new Set<string>();
    const subgraphChains = new Set<number>();
    const onchainChains = new Set<number>();
    const subgraphMissingChains = new Set<number>();

    const targets = Array.from(targetMarkets.values()).sort(
      (a, b) => (a.chainId - b.chainId) || a.marketName.localeCompare(b.marketName)
    );

    await Promise.all(
      targets.map(async (target) => {
        const { chainId, marketName, marketSlug, tokenFilter } = target;
        const deployment = resolveSubgraphDeployment(deployments, chainId, marketSlug);
        const fallbackConfig = resolveOnchainFallbackConfig(marketName, chainId);
        let subgraphRecords: ReserveRateInputInternal[] = [];
        let subgraphFailed = false;

        if (deployment) {
          const requiresApiKey = (deployment.queryUrlTemplate || '').includes('{apiKey}');
          if (requiresApiKey && !hasGraphApiKey) {
            subgraphFailed = true;
          } else {
            try {
              subgraphRecords = await fetchSubgraphChain(marketName, chainId, deployment, tokenFilter);
              if (subgraphRecords.length > 0) {
                subgraphChains.add(chainId);
                for (const item of subgraphRecords) {
                  const key = `${normalizeMarketName(item.marketName)}:${item.chainId}:${item.tokenAddress}`;
                  if (seen.has(key)) continue;
                  seen.add(key);
                  records.push(item);
                }
              }
            } catch (error) {
              subgraphFailed = true;
              logger.warn(`Subgraph fetch failed for chain ${chainId} market ${marketName}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          if (!fallbackConfig) {
            return;
          }

          const missingTokenFilter = computeMissingTokenFilter(tokenFilter, subgraphRecords);
          const needsFallback =
            subgraphFailed ||
            subgraphRecords.length === 0 ||
            (tokenFilter.size > 0 && missingTokenFilter.size > 0);

          if (!needsFallback) {
            return;
          }

          if (tokenFilter.size > 0 && missingTokenFilter.size > 0) {
            logger.warn(
              `Subgraph returned partial rate-inputs for chain ${chainId} market ${marketName}; missing ${missingTokenFilter.size} token(s), applying on-chain fallback.`
            );
          }

          try {
            const onchainFilter = tokenFilter.size > 0 ? missingTokenFilter : tokenFilter;
            const onchainRecords = await fetchOnchainChain(fallbackConfig, onchainFilter, marketName);
            if (onchainRecords.length > 0) {
              onchainChains.add(chainId);
              for (const item of onchainRecords) {
                const key = `${normalizeMarketName(item.marketName)}:${item.chainId}:${item.tokenAddress}`;
                if (seen.has(key)) continue;
                seen.add(key);
                records.push(item);
              }
            }
          } catch (error) {
            logger.warn(
              `On-chain fallback failed for chain ${chainId} market ${marketName} (${fallbackConfig.chainName}): ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
          return;
        }

        if (!deployment && fallbackConfig) {
          subgraphMissingChains.add(chainId);
        }

        if (!fallbackConfig) return;

        try {
          const onchainRecords = await fetchOnchainChain(fallbackConfig, tokenFilter, marketName);
          if (onchainRecords.length > 0) {
            onchainChains.add(chainId);
            for (const item of onchainRecords) {
              const key = `${normalizeMarketName(item.marketName)}:${item.chainId}:${item.tokenAddress}`;
              if (seen.has(key)) continue;
              seen.add(key);
              records.push(item);
            }
          }
        } catch (error) {
          logger.warn(
            `On-chain fallback failed for chain ${chainId} market ${marketName} (${fallbackConfig.chainName}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      })
    );

    const snapshot: ServiceSnapshot = {
      fetchedAt: Date.now(),
      data: records.sort(
        (a, b) =>
          (a.chainId - b.chainId) ||
          a.marketName.localeCompare(b.marketName) ||
          a.tokenAddress.localeCompare(b.tokenAddress)
      ),
      sources: {
        subgraphChains: Array.from(subgraphChains).sort((a, b) => a - b),
        onchainChains: Array.from(onchainChains).sort((a, b) => a - b),
        subgraphMissingChains: Array.from(subgraphMissingChains).sort((a, b) => a - b),
        unhealthyRpcEndpoints: ethProviderService.getUnhealthyEndpoints(),
      },
    };

    this.snapshot = snapshot;
    return snapshot;
  }

  async getRateInputs(filters: QueryFilters): Promise<RateInputsResponse> {
    let snapshot = this.snapshot;

    // Cold start: block until we have the first snapshot.
    if (!snapshot) {
      snapshot = await this.refreshSnapshot();
    } else {
      const ageMs = Date.now() - snapshot.fetchedAt;
      if (ageMs > RATE_INPUTS_MAX_STALE_MS) {
        // Hard stale cap: do not serve very old snapshots.
        snapshot = await this.refreshSnapshot();
      } else if (ageMs > RATE_INPUTS_TTL_MS) {
        // Soft stale window: serve current snapshot, refresh in background.
        void this.refreshSnapshot().catch((error) => {
          logger.warn(
            `Background rate-inputs refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
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

    const response: RateInputsResponse = {
      data: publicData,
      lastUpdated: new Date(snapshot.fetchedAt).toISOString(),
      staleTimeMs: RATE_INPUTS_TTL_MS,
      sources:
        filters.chainId === undefined
          ? snapshot.sources
          : {
              subgraphChains: snapshot.sources.subgraphChains.filter((chainId) => chainId === filters.chainId),
              onchainChains: snapshot.sources.onchainChains.filter((chainId) => chainId === filters.chainId),
              subgraphMissingChains: snapshot.sources.subgraphMissingChains.filter((chainId) => chainId === filters.chainId),
              unhealthyRpcEndpoints: snapshot.sources.unhealthyRpcEndpoints.filter(
                (item) => item.chainId === filters.chainId
              ),
            },
    };

    return response;
  }
}

export const rateInputsService = new RateInputsService();

export async function warmRateInputsCache(): Promise<void> {
  await rateInputsService.getRateInputs({});
}
