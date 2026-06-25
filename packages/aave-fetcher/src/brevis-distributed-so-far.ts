import { providers } from 'ethers';
import {
  executeMulticall3,
  type Multicall3Call,
  type ProviderPoolLike,
} from '@internal/aave-rpc-infra';
import { chainTokenKey } from '@internal/aave-shared-contracts';

const TOKEN_CUMULATIVE_REWARDS_SELECTOR = '0xd4f3c7cc';

const BREVIS_CHAIN_CALL_CACHE_TTL_MS = 60 * 60 * 1000;
const BREVIS_CHAIN_CALL_CACHE_MAX = 100;

interface CacheEntry {
  value: number | undefined;
  fetchedAt: number;
}

const chainCallCache = new Map<string, CacheEntry>();

function cacheKey(campaign: BrevisChainCallCampaign): string {
  return `${campaign.submitChainId}-${campaign.submitAddr.toLowerCase()}-${campaign.tokenAddr.toLowerCase()}`;
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of chainCallCache) {
    if (now - entry.fetchedAt > BREVIS_CHAIN_CALL_CACHE_TTL_MS * 2) {
      chainCallCache.delete(key);
    }
  }
  if (chainCallCache.size > BREVIS_CHAIN_CALL_CACHE_MAX) {
    const keys = Array.from(chainCallCache.keys());
    const excess = chainCallCache.size - BREVIS_CHAIN_CALL_CACHE_MAX;
    for (let i = 0; i < excess; i++) {
      chainCallCache.delete(keys[i]);
    }
  }
}

export interface BrevisChainCallCampaign {
  campaignId: string;
  submitAddr: string;
  submitChainId: number;
  tokenAddr: string;
  decimals: number;
  chainId: number;
}

export interface FetchBrevisDistributedSoFarOptions {
  rpcUrlsByChainId?: Record<number, string[]>;
  providerPool?: ProviderPoolLike;
  timeoutMs?: number;
  _mockExecuteMulticall3?: (provider: unknown, calls: Multicall3Call[], options: { timeoutMs: number; label: string }) => Promise<{ success: boolean; returnData: string }[]>;
}

function encodeTokenCumulativeRewards(tokenAddr: string): string {
  const padded = tokenAddr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return TOKEN_CUMULATIVE_REWARDS_SELECTOR + padded;
}

function decodeUint256(returnData: string): bigint | null {
  try {
    const hex = returnData.replace(/^0x/, '');
    if (hex.length !== 64) return null;
    return BigInt('0x' + hex);
  } catch {
    return null;
  }
}

export async function fetchBrevisDistributedSoFar(
  campaigns: BrevisChainCallCampaign[],
  tokenPrices: Map<string, number>,
  options: FetchBrevisDistributedSoFarOptions,
): Promise<Map<string, number | undefined>> {
  pruneCache();

  const result = new Map<string, number | undefined>();
  const now = Date.now();
  const uncached: BrevisChainCallCampaign[] = [];

  for (const c of campaigns) {
    if (!c.submitAddr || !c.submitChainId) {
      result.set(c.campaignId, undefined);
      continue;
    }
    const key = cacheKey(c);
    const cached = chainCallCache.get(key);
    if (cached && (now - cached.fetchedAt) <= BREVIS_CHAIN_CALL_CACHE_TTL_MS) {
      result.set(c.campaignId, cached.value);
    } else {
      uncached.push(c);
    }
  }

  const byChain = new Map<number, BrevisChainCallCampaign[]>();
  for (const c of uncached) {
    if (!c.submitAddr || !c.submitChainId) {
      result.set(c.campaignId, undefined);
      continue;
    }
    const group = byChain.get(c.submitChainId) ?? [];
    group.push(c);
    byChain.set(c.submitChainId, group);
  }

  for (const [chainId, group] of byChain) {
    const calls: Multicall3Call[] = group.map((c) => ({
      target: c.submitAddr,
      allowFailure: true,
      callData: encodeTokenCumulativeRewards(c.tokenAddr),
    }));

    const multicallOptions = {
      timeoutMs: options.timeoutMs ?? 15_000,
      label: `Brevis tokenCumulativeRewards chain=${chainId}`,
    };

    let multicallResults: { success: boolean; returnData: string }[] | undefined;

    if (options.providerPool) {
      try {
        const poolResult = await options.providerPool.executeWithAutoRpc(chainId, {
          primary: async (provider: providers.Provider) => {
            if (options._mockExecuteMulticall3) {
              return options._mockExecuteMulticall3(provider, calls, multicallOptions);
            }
            return executeMulticall3(provider, calls, multicallOptions);
          },
        }, { label: multicallOptions.label });
        multicallResults = poolResult ?? undefined;
      } catch (err) {
        if (err instanceof Error && err.stack) {
          console.warn(`Brevis multicall3 via ProviderPool failed for chain=${chainId}: ${err.message}`, err.stack);
        } else if (err !== undefined) {
          console.warn(`Brevis multicall3 via ProviderPool failed for chain=${chainId}:`, err);
        }
      }
    } else if (options.rpcUrlsByChainId) {
      const rpcUrls = options.rpcUrlsByChainId[chainId];
      if (!rpcUrls?.length) {
        for (const c of group) result.set(c.campaignId, undefined);
        continue;
      }
      let lastError: unknown;
      for (const rpcUrl of rpcUrls) {
        try {
          const provider = new providers.JsonRpcProvider(rpcUrl);
          multicallResults = await executeMulticall3(provider, calls, multicallOptions);
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (!multicallResults) {
        if (lastError instanceof Error && lastError.stack) {
          console.warn(`Brevis multicall3 failed for chain=${chainId}: ${lastError.message}`, lastError.stack);
        } else if (lastError !== undefined) {
          console.warn(`Brevis multicall3 failed for chain=${chainId}:`, lastError);
        }
        for (const c of group) {
          result.set(c.campaignId, undefined);
          chainCallCache.set(cacheKey(c), { value: undefined, fetchedAt: now });
        }
        continue;
      }
    } else {
      for (const c of group) result.set(c.campaignId, undefined);
      continue;
    }

    if (!multicallResults) {
      for (const c of group) {
        result.set(c.campaignId, undefined);
        chainCallCache.set(cacheKey(c), { value: undefined, fetchedAt: now });
      }
      continue;
    }

    for (let i = 0; i < group.length; i++) {
      const c = group[i];
      const mcResult = multicallResults[i];

      if (!mcResult?.success) {
        result.set(c.campaignId, undefined);
        chainCallCache.set(cacheKey(c), { value: undefined, fetchedAt: now });
        continue;
      }

      const rawValue = decodeUint256(mcResult.returnData);
      if (rawValue === null) {
        result.set(c.campaignId, undefined);
        chainCallCache.set(cacheKey(c), { value: undefined, fetchedAt: now });
        continue;
      }

      const priceKey = chainTokenKey(c.chainId, c.tokenAddr);
      const tokenPrice = tokenPrices.get(priceKey);
      if (tokenPrice === undefined) {
        result.set(c.campaignId, undefined);
        chainCallCache.set(cacheKey(c), { value: undefined, fetchedAt: now });
        continue;
      }

      const divisor = BigInt(10) ** BigInt(c.decimals);
      const whole = rawValue / divisor;
      const remainder = rawValue % divisor;
      const normalized = Number(whole) + Number(remainder) / Number(divisor);
      const usd = normalized * tokenPrice;

      if (!Number.isFinite(usd)) {
        result.set(c.campaignId, undefined);
        chainCallCache.set(cacheKey(c), { value: undefined, fetchedAt: now });
        continue;
      }

      result.set(c.campaignId, usd);
      chainCallCache.set(cacheKey(c), { value: usd, fetchedAt: now });
    }
  }

  for (const c of uncached) {
    if (!result.has(c.campaignId)) {
      result.set(c.campaignId, undefined);
    }
  }

  return result;
}

export function getBrevisCacheStats(): { chainCallCache: number } {
  return { chainCallCache: chainCallCache.size };
}

export function __resetBrevisChainCallCacheForTests(): void {
  chainCallCache.clear();
}
