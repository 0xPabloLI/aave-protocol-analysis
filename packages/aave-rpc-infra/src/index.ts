import { providers, utils } from 'ethers';
import * as AaveAddressBook from '@aave-dao/aave-address-book';
import { IHubV4_ABI } from '@aave-dao/aave-address-book/abis/IHubV4';
import { ISpokeV4_ABI } from '@aave-dao/aave-address-book/abis/ISpokeV4';
import { AAVE_CHAIN_ID_TO_RPC_KEY, getAaveRpcUrlsByChainId } from '@internal/aave-shared-config';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';

export type ProviderCandidate = {
  rpcUrl: string;
  provider: providers.StaticJsonRpcProvider;
};

type EndpointHealth = {
  consecutiveFailures: number;
  suppressedUntil: number;
  lastError: string;
  lastFailureAt: number;
  lastSuccessAt: number;
};

export type UnhealthyEndpoint = {
  chainId: number;
  rpcUrl: string;
  lastError: string;
  suppressedUntil: string;
};

export type ProviderPoolOptions = {
  failureThreshold?: number;
  suppressionMs?: number;
  now?: () => number;
  errorClassifier?: ErrorClassifier;
};

export type ErrorClass = 'retry_next_rpc' | 'try_fallback';

export type ErrorClassifier = (error: unknown) => ErrorClass;

export type ExecuteWithFallbackOptions = {
  label?: string;
};

const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_SUPPRESSION_MS = 5 * 60_000;
const DEFAULT_PROVIDER_TTL_MS = 30 * 60_000; // 30 min — evict unused providers

function defaultErrorClassifier(error: unknown): ErrorClass {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.code;
  if (typeof code === 'string') {
    const networkCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'NETWORK_ERROR', 'SERVER_ERROR']);
    if (networkCodes.has(code)) return 'retry_next_rpc';
  }
  if (msg.includes('CALL_EXCEPTION') || msg.includes('UNPREDICTABLE_GAS_LIMIT')) {
    return 'try_fallback';
  }
  return 'retry_next_rpc';
}

export class ProviderPool {
  private providerByKey = new Map<string, providers.StaticJsonRpcProvider>();
  private endpointHealthByKey = new Map<string, EndpointHealth>();
  private providerLastUsedAt = new Map<string, number>();
  private readonly failureThreshold: number;
  private readonly suppressionMs: number;
  private readonly providerTtlMs: number;
  private readonly now: () => number;
  readonly errorClassifier: ErrorClassifier;

  constructor(options: ProviderPoolOptions & { providerTtlMs?: number } = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.suppressionMs = Math.max(1_000, options.suppressionMs ?? DEFAULT_SUPPRESSION_MS);
    this.providerTtlMs = Math.max(60_000, options.providerTtlMs ?? DEFAULT_PROVIDER_TTL_MS);
    this.now = options.now ?? Date.now;
    this.errorClassifier = options.errorClassifier ?? defaultErrorClassifier;
  }

  private endpointKey(chainId: number, rpcUrl: string): string {
    return `${chainId}:${rpcUrl}`;
  }

  private isSuppressed(health: EndpointHealth | undefined): boolean {
    return !!health && health.suppressedUntil > this.now();
  }

  reportProviderFailure(chainId: number, rpcUrl: string, errorMessage: string): void {
    const key = this.endpointKey(chainId, rpcUrl);
    const now = this.now();
    const current = this.endpointHealthByKey.get(key);
    const nextFailures = (current?.consecutiveFailures ?? 0) + 1;
    const shouldSuppress = nextFailures >= this.failureThreshold;
    this.endpointHealthByKey.set(key, {
      consecutiveFailures: nextFailures,
      suppressedUntil: shouldSuppress ? now + this.suppressionMs : (current?.suppressedUntil ?? 0),
      lastError: errorMessage,
      lastFailureAt: now,
      lastSuccessAt: current?.lastSuccessAt ?? 0,
    });
  }

  reportProviderSuccess(chainId: number, rpcUrl: string): void {
    const key = this.endpointKey(chainId, rpcUrl);
    const current = this.endpointHealthByKey.get(key);
    const now = this.now();
    this.endpointHealthByKey.set(key, {
      consecutiveFailures: 0,
      suppressedUntil: 0,
      lastError: current?.lastError ?? '',
      lastFailureAt: current?.lastFailureAt ?? 0,
      lastSuccessAt: now,
    });
  }

  getUnhealthyEndpoints(): UnhealthyEndpoint[] {
    const now = this.now();
    const output: UnhealthyEndpoint[] = [];
    for (const [key, health] of this.endpointHealthByKey.entries()) {
      if (health.suppressedUntil <= now) continue;
      const [chainIdRaw, ...rpcUrlParts] = key.split(':');
      const chainId = Number(chainIdRaw);
      const rpcUrl = rpcUrlParts.join(':');
      if (!Number.isFinite(chainId) || !rpcUrl) continue;
      output.push({
        chainId,
        rpcUrl,
        lastError: health.lastError,
        suppressedUntil: new Date(health.suppressedUntil).toISOString(),
      });
    }
    return output.sort((a, b) => (a.chainId - b.chainId) || a.rpcUrl.localeCompare(b.rpcUrl));
  }

  getProvidersForChain(chainId: number, fallbackUrls: string[]): ProviderCandidate[] {
    const healthyCandidates: Array<ProviderCandidate & { lastSuccessAt: number; index: number }> = [];
    const suppressedCandidates: ProviderCandidate[] = [];

    for (let index = 0; index < fallbackUrls.length; index++) {
      const rpcUrl = fallbackUrls[index];
      const key = this.endpointKey(chainId, rpcUrl);
      let provider = this.providerByKey.get(key);
      if (!provider) {
        provider = new providers.StaticJsonRpcProvider(rpcUrl, chainId);
        this.providerByKey.set(key, provider);
      }
      this.providerLastUsedAt.set(key, this.now());
      const candidate = { rpcUrl, provider };
      const health = this.endpointHealthByKey.get(key);
      if (this.isSuppressed(health)) {
        suppressedCandidates.push(candidate);
      } else {
        healthyCandidates.push({
          ...candidate,
          lastSuccessAt: health?.lastSuccessAt ?? 0,
          index,
        });
      }
    }

    healthyCandidates.sort((a, b) => {
      if (b.lastSuccessAt !== a.lastSuccessAt) return b.lastSuccessAt - a.lastSuccessAt;
      return a.index - b.index;
    });

    // Evict stale providers to prevent unbounded memory growth
    this.cleanupStaleProviders();

    return [
      ...healthyCandidates.map(({ rpcUrl, provider }) => ({ rpcUrl, provider })),
      ...suppressedCandidates,
    ];
  }

  async executeWithFallback<T>(
    chainId: number,
    rpcUrls: string[],
    execs: {
      primary: (provider: providers.Provider) => Promise<T>;
      fallback?: (provider: providers.Provider) => Promise<T>;
    },
    options?: ExecuteWithFallbackOptions,
  ): Promise<T> {
    const candidates = this.getProvidersForChain(chainId, rpcUrls);
    const errors: Array<{ rpcUrl: string; message: string }> = [];

    for (const { rpcUrl, provider } of candidates) {
      try {
        const result = await execs.primary(provider);
        this.reportProviderSuccess(chainId, rpcUrl);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.reportProviderFailure(chainId, rpcUrl, message);

        const errorClass = this.errorClassifier(error);
        if (errorClass === 'try_fallback' && execs.fallback) {
          try {
            const fallbackResult = await execs.fallback(provider);
            this.reportProviderSuccess(chainId, rpcUrl);
            return fallbackResult;
          } catch (fallbackError) {
            const fbMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            this.reportProviderFailure(chainId, rpcUrl, fbMsg);
            errors.push({ rpcUrl, message: `${message} | fallback: ${fbMsg}` });
          }
        } else {
          errors.push({ rpcUrl, message });
        }
      }
    }

    const label = options?.label ? ` (${options.label})` : '';
    const details = errors.map(e => `  ${e.rpcUrl}: ${e.message}`).join('\n');
    throw new Error(`executeWithFallback${label}: all ${rpcUrls.length} RPCs failed for chain ${chainId}\n${details}`);
  }

  /** Remove provider + health entries unused for longer than providerTtlMs */
  private cleanupStaleProviders(): void {
    const cutoff = this.now() - this.providerTtlMs;
    for (const [key, lastUsed] of this.providerLastUsedAt.entries()) {
      if (lastUsed < cutoff) {
        this.providerByKey.delete(key);
        this.endpointHealthByKey.delete(key);
        this.providerLastUsedAt.delete(key);
      }
    }
  }
}

export const providerPool = new ProviderPool();

export const MULTICALL3_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'target', type: 'address' },
          { internalType: 'bool', name: 'allowFailure', type: 'bool' },
          { internalType: 'bytes', name: 'callData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Call3[]',
        name: 'calls',
        type: 'tuple[]',
      },
    ],
    name: 'aggregate3',
    outputs: [
      { internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
      {
        components: [
          { internalType: 'bool', name: 'success', type: 'bool' },
          { internalType: 'bytes', name: 'returnData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Result[]',
        name: 'returnData',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export { ISpokeV4_ABI };

export const HUB_EXTENSIONS_ABI = [
  {
    inputs: [
      { internalType: 'uint256', name: 'assetId', type: 'uint256' },
      { internalType: 'address', name: 'spoke', type: 'address' },
    ],
    name: 'getSpokeDeficitRay',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const V4_HUB_FULL_ABI = [...IHubV4_ABI, ...HUB_EXTENSIONS_ABI] as const;

export type Multicall3Call = {
  target: string;
  allowFailure: boolean;
  callData: string;
};

export type Multicall3Result = {
  success: boolean;
  returnData: string;
};

export type Multicall3Options = {
  timeoutMs?: number;
  label?: string;
};

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function executeMulticall3(
  provider: providers.Provider,
  calls: Multicall3Call[],
  options: Multicall3Options = {},
): Promise<Multicall3Result[]> {
  const iface = new utils.Interface(MULTICALL3_ABI as any);
  const encodedData = iface.encodeFunctionData('aggregate3', [calls]);
  const rawResult = await withTimeout(
    provider.call({ to: MULTICALL3_ADDRESS, data: encodedData }, 'latest'),
    options.timeoutMs ?? 15_000,
    options.label ?? 'Multicall3.aggregate3 timeout',
  );
  const decoded = iface.decodeFunctionResult('aggregate3', rawResult);
  return (decoded[1] as any[]).map((result: any) => ({
    success: result.success,
    returnData: result.returnData,
  }));
}

export interface V4SpokeEntry {
  spokeName: string;
  chainId: number;
  spokeAddress: string;
  hubName: string;
  hubAddress: string;
}

const V4_SPOKE_TO_HUB: Record<string, string[]> = {
  MAIN_SPOKE: ['CORE_HUB'],
  BLUECHIP_SPOKE: ['CORE_HUB', 'PRIME_HUB'],
  LIDO_ESPOKE: ['CORE_HUB'],
  ETHERFI_ESPOKE: ['CORE_HUB'],
  KELP_ESPOKE: ['CORE_HUB'],
  ETHENA_CORRELATED_SPOKE: ['PLUS_HUB'],
  ETHENA_ECOSYSTEM_SPOKE: ['PLUS_HUB'],
  FOREX_SPOKE: ['PLUS_HUB'],
  GOLD_SPOKE: ['PLUS_HUB'],
  LOMBARD_BTC_SPOKE: ['PRIME_HUB'],
};

const V4_SKIP_SPOKES = new Set(['TREASURY_SPOKE']);

function isSupportedChain(chainId: number): boolean {
  return Object.prototype.hasOwnProperty.call(AAVE_CHAIN_ID_TO_RPC_KEY, chainId);
}

export function getDefaultV4SpokeEntries(): V4SpokeEntry[] {
  const entries: V4SpokeEntry[] = [];
  for (const [moduleName, moduleValue] of Object.entries(AaveAddressBook)) {
    if (!moduleName.startsWith('AaveV4') || !moduleValue || typeof moduleValue !== 'object') continue;
    const value = moduleValue as Record<string, unknown>;
    const chainId = Number(value.CHAIN_ID);
    if (!Number.isFinite(chainId) || !isSupportedChain(chainId)) continue;

    const hubs = value.HUBS as Record<string, string> | undefined;
    const spokes = value.SPOKES as Record<string, string> | undefined;
    if (!hubs || !spokes) continue;

    for (const [spokeName, spokeAddress] of Object.entries(spokes)) {
      if (!spokeName.endsWith('_SPOKE') && !spokeName.endsWith('_ESPOKE')) continue;
      if (V4_SKIP_SPOKES.has(spokeName) || typeof spokeAddress !== 'string') continue;
      const hubNames = V4_SPOKE_TO_HUB[spokeName] ?? [];
      for (const hubName of hubNames) {
        const hubAddress = hubs[hubName];
        if (typeof hubAddress !== 'string') continue;
        entries.push({
          spokeName,
          chainId,
          spokeAddress: normalizeAddress(spokeAddress),
          hubName,
          hubAddress: normalizeAddress(hubAddress),
        });
      }
    }
  }
  return entries;
}

type ProviderPoolLike = Pick<ProviderPool, 'getProvidersForChain' | 'reportProviderFailure' | 'reportProviderSuccess' | 'errorClassifier' | 'executeWithFallback'>;

export interface FetchV4ReservesViaRpcOptions {
  entries?: V4SpokeEntry[];
  providerPool?: ProviderPoolLike;
  rpcUrlsByChainId?: (chainId: number) => string[];
  timeoutMs?: number;
}

export interface FetchV4ReservesViaRpcResult {
  reserves: RuntimeReserveData[];
  errors: string[];
}

function normalizeAddress(address: string): string {
  return address.toLowerCase().trim();
}

function bigintToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return BigInt(String(value)).toString();
  } catch {
    return undefined;
  }
}

function rayToPercent(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const ray = BigInt(String(value));
    return Number(ray / 10n ** 21n) / 1e6;
  } catch {
    return undefined;
  }
}

async function callContract(
  provider: providers.Provider,
  iface: utils.Interface,
  target: string,
  functionName: string,
  args: unknown[],
  timeoutMs: number,
): Promise<utils.Result> {
  const data = iface.encodeFunctionData(functionName, args);
  const raw = await withTimeout(
    provider.call({ to: target, data }, 'latest'),
    timeoutMs,
    `${functionName} timeout for ${target}`,
  );
  return iface.decodeFunctionResult(functionName, raw);
}

function buildReserveData(
  entry: V4SpokeEntry,
  underlying: string,
  decimals: number,
  hubAsset: any,
): RuntimeReserveData {
  const liquidity = bigintToString(hubAsset.liquidity ?? hubAsset[0]);
  const borrowed = bigintToString(hubAsset.drawnShares ?? hubAsset[6]);
  const supplied = bigintToString(hubAsset.addedShares ?? hubAsset[3]);
  const borrowApy = rayToPercent(hubAsset.drawnRate ?? hubAsset[10]);
  const protocolFeeRaw = hubAsset.liquidityFee ?? hubAsset[8];
  const protocolFee = protocolFeeRaw !== undefined ? Number(protocolFeeRaw) / 100 : undefined;

  return {
    reserveId: `${entry.chainId}:${normalizeAddress(entry.spokeAddress)}:${underlying}:${entry.hubName}`,
    marketName: `AaveV4${entry.spokeName.replace(/\s+/g, '')}`,
    chainName: `Chain ${entry.chainId}`,
    chainId: entry.chainId,
    tokenName: 'Unknown',
    tokenSymbol: 'Unknown',
    tokenAddress: underlying,
    aTokenAddress: null,
    vTokenAddress: null,
    ...(decimals !== 18 ? { decimals } : {}),
    ...(liquidity ? { liquidity } : {}),
    ...(borrowed ? { borrowed } : {}),
    ...(supplied ? { supplied } : {}),
    ...(borrowApy !== undefined ? { borrowApy } : {}),
    ...(protocolFee !== undefined ? { protocolFee } : {}),
    hubId: normalizeAddress(entry.hubAddress),
    hubName: entry.hubName,
    hubAddress: normalizeAddress(entry.hubAddress),
    spokeId: normalizeAddress(entry.spokeAddress),
    spokeName: entry.spokeName,
    spokeAddress: normalizeAddress(entry.spokeAddress),
    aaveProReserveId: `${entry.chainId}:${normalizeAddress(entry.spokeAddress)}:${underlying}:${normalizeAddress(entry.hubAddress)}:${entry.hubName}`,
  };
}

async function fetchEntryReservesMulticall(
  provider: providers.Provider,
  entry: V4SpokeEntry,
  timeoutMs: number,
): Promise<RuntimeReserveData[]> {
  const spokeIface = new utils.Interface(ISpokeV4_ABI as any);
  const hubIface = new utils.Interface(V4_HUB_FULL_ABI as any);

  const reserveCountResult = await callContract(provider, spokeIface, entry.spokeAddress, 'getReserveCount', [], timeoutMs);
  const reserveCount = Number(reserveCountResult[0]);
  if (reserveCount === 0) return [];

  // Batch all getReserve calls via Multicall3
  const reserveCalls: Multicall3Call[] = [];
  for (let i = 0; i < reserveCount; i++) {
    reserveCalls.push({
      target: entry.spokeAddress,
      allowFailure: true,
      callData: spokeIface.encodeFunctionData('getReserve', [i]),
    });
  }
  const reserveResults = await executeMulticall3(provider, reserveCalls, { timeoutMs, label: `getReserve batch for ${entry.spokeName}` });

  // Filter reserves matching our hub, collect asset IDs
  const matchingReserves: Array<{ underlying: string; assetId: bigint; decimals: number }> = [];
  for (let i = 0; i < reserveResults.length; i++) {
    const result = reserveResults[i];
    if (!result.success) continue;
    const decoded = spokeIface.decodeFunctionResult('getReserve', result.returnData)[0] as any;
    const reserveHub = normalizeAddress(String(decoded.hub ?? decoded[1] ?? ''));
    if (reserveHub !== normalizeAddress(entry.hubAddress)) continue;
    const underlying = normalizeAddress(String(decoded.underlying ?? decoded[0] ?? ''));
    if (!underlying) continue;
    const assetId = BigInt(String(decoded.assetId ?? decoded[2] ?? 0));
    const decimals = Number(decoded.decimals ?? decoded[3] ?? 18);
    matchingReserves.push({ underlying, assetId, decimals });
  }
  if (matchingReserves.length === 0) return [];

  // Batch all getAsset calls via Multicall3
  const assetCalls: Multicall3Call[] = matchingReserves.map(r => ({
    target: entry.hubAddress,
    allowFailure: true,
    callData: hubIface.encodeFunctionData('getAsset', [r.assetId]),
  }));
  const assetResults = await executeMulticall3(provider, assetCalls, { timeoutMs, label: `getAsset batch for ${entry.hubName}` });

  // Build RuntimeReserveData from matching reserves + hub assets
  const reserves: RuntimeReserveData[] = [];
  for (let i = 0; i < matchingReserves.length; i++) {
    const { underlying, decimals } = matchingReserves[i];
    const assetResult = assetResults[i];
    if (!assetResult.success) continue;
    const hubAsset = hubIface.decodeFunctionResult('getAsset', assetResult.returnData)[0] as any;
    reserves.push(buildReserveData(entry, underlying, decimals, hubAsset));
  }

  return reserves;
}

async function fetchEntryReservesSerial(
  provider: providers.Provider,
  entry: V4SpokeEntry,
  timeoutMs: number,
): Promise<RuntimeReserveData[]> {
  const spokeIface = new utils.Interface(ISpokeV4_ABI as any);
  const hubIface = new utils.Interface(V4_HUB_FULL_ABI as any);
  const reserveCountResult = await callContract(provider, spokeIface, entry.spokeAddress, 'getReserveCount', [], timeoutMs);
  const reserveCount = Number(reserveCountResult[0]);
  const reserves: RuntimeReserveData[] = [];

  for (let reserveIndex = 0; reserveIndex < reserveCount; reserveIndex++) {
    const spokeReserve = (await callContract(provider, spokeIface, entry.spokeAddress, 'getReserve', [reserveIndex], timeoutMs))[0] as any;
    const reserveHub = normalizeAddress(String(spokeReserve.hub ?? spokeReserve[1] ?? ''));
    if (reserveHub !== normalizeAddress(entry.hubAddress)) continue;

    const underlying = normalizeAddress(String(spokeReserve.underlying ?? spokeReserve[0] ?? ''));
    if (!underlying) continue;

    const assetId = BigInt(String(spokeReserve.assetId ?? spokeReserve[2] ?? 0));
    const decimals = Number(spokeReserve.decimals ?? spokeReserve[3] ?? 18);
    const hubAsset = (await callContract(provider, hubIface, entry.hubAddress, 'getAsset', [assetId], timeoutMs))[0] as any;
    reserves.push(buildReserveData(entry, underlying, decimals, hubAsset));
  }

  return reserves;
}

export async function fetchV4ReservesViaRpc(
  options: FetchV4ReservesViaRpcOptions,
): Promise<FetchV4ReservesViaRpcResult> {
  const activePool = options.providerPool ?? providerPool;
  const rpcUrlsByChainId = options.rpcUrlsByChainId ?? getAaveRpcUrlsByChainId;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const reserves: RuntimeReserveData[] = [];
  const errors: string[] = [];

  for (const entry of options.entries ?? getDefaultV4SpokeEntries()) {
    try {
      const entryReserves = await activePool.executeWithFallback(
        entry.chainId,
        rpcUrlsByChainId(entry.chainId),
        {
          primary: (p: providers.Provider) => fetchEntryReservesMulticall(p, entry, timeoutMs),
          fallback: (p: providers.Provider) => fetchEntryReservesSerial(p, entry, timeoutMs),
        },
        { label: `fetchV4Reserves:${entry.spokeName}` },
      );
      reserves.push(...entryReserves);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${entry.spokeName}/${entry.hubName}: ${message}`);
    }
  }

  return { reserves, errors };
}
