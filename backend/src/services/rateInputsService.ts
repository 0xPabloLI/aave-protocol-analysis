import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { UiPoolDataProvider } from '@aave/contract-helpers';
import { AaveV3Mantle, AaveV3Metis, AaveV3Plasma } from '@bgd-labs/aave-address-book';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { logger } from '../logger.js';
import type { MarketWithSpread, RateInputsResponse, ReserveRateInput } from '../types/index.js';
import { dataService } from './dataService.js';
import { ethProviderService } from './ethProviderService.js';

const RATE_INPUTS_TTL_MS = BACKEND_CACHE_TTL_MS.realtimeFamily;
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
  chainId: number;
  chainName: string;
  reason: string;
  preferOnchain?: boolean;
  defaultRpcUrls: string[];
  uiPoolDataProviderAddress: string;
  poolAddressesProvider: string;
}

interface ServiceSnapshot {
  fetchedAt: number;
  data: ReserveRateInput[];
  sources: RateInputsResponse['sources'];
}

type QueryFilters = {
  chainId?: number;
  asset?: string;
};

// Explicit on-chain fallback map: chains missing from subgraph snapshot or chains with incompatible legacy schema.
const ONCHAIN_FALLBACK_CHAINS: Record<number, OnchainFallbackConfig> = {
  1088: {
    chainId: 1088,
    chainName: 'metis_andromeda',
    reason: 'Legacy Metis subgraph schema differs; use on-chain UiPoolDataProvider for full rate inputs.',
    preferOnchain: true,
    defaultRpcUrls: ['https://andromeda.metis.io/?owner=1088'],
    uiPoolDataProviderAddress: AaveV3Metis.UI_POOL_DATA_PROVIDER,
    poolAddressesProvider: AaveV3Metis.POOL_ADDRESSES_PROVIDER,
  },
  5000: {
    chainId: 5000,
    chainName: 'mantle',
    reason: 'No Aave deployment entry in protocol-subgraphs snapshot; use on-chain UiPoolDataProvider.',
    defaultRpcUrls: ['https://rpc.mantle.xyz'],
    uiPoolDataProviderAddress: AaveV3Mantle.UI_POOL_DATA_PROVIDER,
    poolAddressesProvider: AaveV3Mantle.POOL_ADDRESSES_PROVIDER,
  },
  9745: {
    chainId: 9745,
    chainName: 'plasma',
    reason: 'No Aave deployment entry in protocol-subgraphs snapshot; use on-chain UiPoolDataProvider.',
    defaultRpcUrls: ['https://rpc.plasma.to'],
    uiPoolDataProviderAddress: AaveV3Plasma.UI_POOL_DATA_PROVIDER,
    poolAddressesProvider: AaveV3Plasma.POOL_ADDRESSES_PROVIDER,
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function toNumericString(value: unknown): string {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '0';
  }
  return String(value);
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
  const currentIsCore = current.market === 'core';
  const candidateIsCore = candidate.market === 'core';
  if (!currentIsCore && candidateIsCore) return candidate;

  const currentIsId = (current.queryPath || '').startsWith('id/');
  const candidateIsId = (candidate.queryPath || '').startsWith('id/');
  if (!currentIsId && candidateIsId) return candidate;

  return current;
}

async function loadSubgraphDeployments(): Promise<Map<number, SubgraphDeploymentRecord>> {
  try {
    const raw = await readFile(SUBGRAPH_SNAPSHOT_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SubgraphSnapshot;
    const deployments = Array.isArray(parsed.deployments) ? parsed.deployments : [];
    const map = new Map<number, SubgraphDeploymentRecord>();
    for (const deployment of deployments) {
      if (!deployment.chainId || !deployment.queryPath || !deployment.queryUrlTemplate) continue;
      const picked = pickPreferredDeployment(map.get(deployment.chainId), deployment);
      map.set(deployment.chainId, picked);
    }
    return map;
  } catch (error) {
    logger.warn(`Failed to load subgraph deployment snapshot (${SUBGRAPH_SNAPSHOT_PATH}): ${error instanceof Error ? error.message : String(error)}`);
    return new Map<number, SubgraphDeploymentRecord>();
  }
}

function buildTargetChainMap(rows: MarketWithSpread[]): Map<number, Set<string>> {
  const chainMap = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!row.chainId || !row.tokenAddress) continue;
    const tokenAddress = normalizeAddress(row.tokenAddress);
    const existing = chainMap.get(row.chainId) ?? new Set<string>();
    existing.add(tokenAddress);
    chainMap.set(row.chainId, existing);
  }

  // Ensure fallback chains are part of the fetch set, even if current market snapshot is sparse.
  for (const chainId of Object.keys(ONCHAIN_FALLBACK_CHAINS).map(Number)) {
    if (!chainMap.has(chainId)) chainMap.set(chainId, new Set<string>());
  }
  return chainMap;
}

function resolveSubgraphUrl(record: SubgraphDeploymentRecord): string | null {
  const template = record.queryUrlTemplate;
  if (!template) return null;
  if (!template.includes('{apiKey}')) return template;

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) return null;
  return template.replace('{apiKey}', encodeURIComponent(apiKey));
}

async function fetchSubgraphChain(
  chainId: number,
  deployment: SubgraphDeploymentRecord,
  tokenFilter: Set<string>
): Promise<ReserveRateInput[]> {
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
      const records: ReserveRateInput[] = [];
      for (const reserve of reserves) {
        const underlyingAsset = String(reserve.underlyingAsset || '').trim();
        if (!underlyingAsset) continue;
        const tokenAddress = normalizeAddress(underlyingAsset);
        if (tokenFilter.size > 0 && !tokenFilter.has(tokenAddress)) continue;
        records.push({
          chainId,
          tokenAddress,
          availableLiquidity: toNumericString(reserve.availableLiquidity),
          totalScaledVariableDebt: toNumericString(reserve.totalScaledVariableDebt),
          variableBorrowIndex: toNumericString(reserve.variableBorrowIndex),
          reserveFactor: toNumericString(reserve.reserveFactor),
          variableRateSlope1: toNumericString(reserve.variableRateSlope1),
          variableRateSlope2: toNumericString(reserve.variableRateSlope2),
          baseVariableBorrowRate: toNumericString(reserve.baseVariableBorrowRate),
          optimalUsageRate: toNumericString(
            reserve.optimalUsageRatio ?? reserve.optimalUsageRate ?? reserve.optimalUtilisationRate
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

async function fetchOnchainChain(config: OnchainFallbackConfig, tokenFilter: Set<string>): Promise<ReserveRateInput[]> {
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

      const records: ReserveRateInput[] = [];
      for (const reserve of reserves) {
        const underlyingAsset = String(reserve.underlyingAsset || '').trim();
        if (!underlyingAsset) continue;
        const tokenAddress = normalizeAddress(underlyingAsset);
        if (tokenFilter.size > 0 && !tokenFilter.has(tokenAddress)) continue;
        records.push({
          chainId: config.chainId,
          tokenAddress,
          availableLiquidity: toNumericString(reserve.availableLiquidity),
          totalScaledVariableDebt: toNumericString(reserve.totalScaledVariableDebt),
          variableBorrowIndex: toNumericString(reserve.variableBorrowIndex),
          reserveFactor: toNumericString(reserve.reserveFactor),
          variableRateSlope1: toNumericString(reserve.variableRateSlope1),
          variableRateSlope2: toNumericString(reserve.variableRateSlope2),
          baseVariableBorrowRate: toNumericString(reserve.baseVariableBorrowRate),
          optimalUsageRate: toNumericString(reserve.optimalUsageRatio ?? reserve.optimalUsageRate),
          source: 'onchain',
          sourceDetail: `rpc:${rpcUrl}`,
        });
      }

      if (records.length === 0 && tokenFilter.size > 0) {
        logger.warn(`On-chain fetch succeeded but no reserve matched filter on chain ${config.chainId}`);
      }
      return records;
    } catch (error) {
      lastError = error;
      logger.warn(`On-chain fallback failed for chain ${config.chainId} via ${rpcUrl}: ${error instanceof Error ? error.message : String(error)}`);
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
    const targetChains = buildTargetChainMap(marketRows);
    const deployments = await loadSubgraphDeployments();
    const hasGraphApiKey = Boolean(process.env.THE_GRAPH_API_KEY);
    if (!hasGraphApiKey) {
      logger.warn('THE_GRAPH_API_KEY not set: gateway subgraph chains will be skipped (legacy direct URLs still attempted).');
    }

    const records: ReserveRateInput[] = [];
    const seen = new Set<string>();
    const subgraphChains = new Set<number>();
    const onchainChains = new Set<number>();
    const subgraphMissingChains = new Set<number>();

    const chainIds = Array.from(targetChains.keys()).sort((a, b) => a - b);

    await Promise.all(
      chainIds.map(async (chainId) => {
        const tokenFilter = targetChains.get(chainId) ?? new Set<string>();
        const deployment = deployments.get(chainId);
        const fallbackConfig = ONCHAIN_FALLBACK_CHAINS[chainId];
        const shouldPreferOnchain = Boolean(fallbackConfig?.preferOnchain);

        if (deployment && !shouldPreferOnchain) {
          const requiresApiKey = (deployment.queryUrlTemplate || '').includes('{apiKey}');
          if (requiresApiKey && !hasGraphApiKey) {
            return;
          }
          try {
            const subgraphRecords = await fetchSubgraphChain(chainId, deployment, tokenFilter);
            if (subgraphRecords.length > 0) {
              subgraphChains.add(chainId);
              for (const item of subgraphRecords) {
                const key = `${item.chainId}:${item.tokenAddress}`;
                if (seen.has(key)) continue;
                seen.add(key);
                records.push(item);
              }
              return;
            }
          } catch (error) {
            logger.warn(`Subgraph fetch failed for chain ${chainId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else if (!deployment && fallbackConfig) {
          subgraphMissingChains.add(chainId);
        }

        if (!fallbackConfig) return;

        try {
          const onchainRecords = await fetchOnchainChain(fallbackConfig, tokenFilter);
          if (onchainRecords.length > 0) {
            onchainChains.add(chainId);
            for (const item of onchainRecords) {
              const key = `${item.chainId}:${item.tokenAddress}`;
              if (seen.has(key)) continue;
              seen.add(key);
              records.push(item);
            }
          }
        } catch (error) {
          logger.warn(`On-chain fallback failed for chain ${chainId} (${fallbackConfig.chainName}): ${error instanceof Error ? error.message : String(error)}`);
        }
      })
    );

    const snapshot: ServiceSnapshot = {
      fetchedAt: Date.now(),
      data: records.sort((a, b) => (a.chainId - b.chainId) || a.tokenAddress.localeCompare(b.tokenAddress)),
      sources: {
        subgraphChains: Array.from(subgraphChains).sort((a, b) => a - b),
        onchainChains: Array.from(onchainChains).sort((a, b) => a - b),
        subgraphMissingChains: Array.from(subgraphMissingChains).sort((a, b) => a - b),
      },
    };

    this.snapshot = snapshot;
    return snapshot;
  }

  async getRateInputs(filters: QueryFilters): Promise<RateInputsResponse> {
    const mustRefresh = this.isStale();
    const snapshot = mustRefresh ? await this.refreshSnapshot() : this.snapshot!;

    let filtered = snapshot.data;
    if (filters.chainId !== undefined) {
      filtered = filtered.filter((item) => item.chainId === filters.chainId);
    }
    if (filters.asset) {
      const asset = normalizeAddress(filters.asset);
      filtered = filtered.filter((item) => item.tokenAddress === asset);
    }

    const response: RateInputsResponse = {
      data: filtered,
      lastUpdated: new Date(snapshot.fetchedAt).toISOString(),
      isStale: Date.now() - snapshot.fetchedAt > RATE_INPUTS_TTL_MS,
      staleTimeMs: RATE_INPUTS_TTL_MS,
      sources:
        filters.chainId === undefined
          ? snapshot.sources
          : {
              subgraphChains: snapshot.sources.subgraphChains.filter((chainId) => chainId === filters.chainId),
              onchainChains: snapshot.sources.onchainChains.filter((chainId) => chainId === filters.chainId),
              subgraphMissingChains: snapshot.sources.subgraphMissingChains.filter((chainId) => chainId === filters.chainId),
            },
    };

    return response;
  }
}

export const rateInputsService = new RateInputsService();
