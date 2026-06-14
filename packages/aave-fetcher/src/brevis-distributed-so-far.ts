import { providers } from 'ethers';
import {
  executeMulticall3,
  type Multicall3Call,
} from '@internal/aave-rpc-infra';

const TOKEN_CUMULATIVE_REWARDS_SELECTOR = '0xd4f3c7cc';

export interface BrevisChainCallCampaign {
  campaignId: string;
  submitAddr: string;
  submitChainId: number;
  tokenAddr: string;
  decimals: number;
  chainId: number;
}

export interface FetchBrevisDistributedSoFarOptions {
  rpcUrlsByChainId: Record<number, string[]>;
  timeoutMs?: number;
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

function chainTokenKey(chainId: number, address: string): string {
  return `${chainId}-${address.toLowerCase()}`;
}

export async function fetchBrevisDistributedSoFar(
  campaigns: BrevisChainCallCampaign[],
  tokenPrices: Map<string, number>,
  options: FetchBrevisDistributedSoFarOptions,
): Promise<Map<string, number | undefined>> {
  const result = new Map<string, number | undefined>();

  const byChain = new Map<number, BrevisChainCallCampaign[]>();
  for (const c of campaigns) {
    if (!c.submitAddr || !c.submitChainId) {
      result.set(c.campaignId, undefined);
      continue;
    }
    const group = byChain.get(c.submitChainId) ?? [];
    group.push(c);
    byChain.set(c.submitChainId, group);
  }

  for (const [chainId, group] of byChain) {
    const rpcUrls = options.rpcUrlsByChainId[chainId];
    if (!rpcUrls?.length) {
      for (const c of group) result.set(c.campaignId, undefined);
      continue;
    }

    const calls: Multicall3Call[] = group.map((c) => ({
      target: c.submitAddr,
      allowFailure: true,
      callData: encodeTokenCumulativeRewards(c.tokenAddr),
    }));

    let multicallResults: { success: boolean; returnData: string }[] | undefined;
    let lastError: unknown;
    for (const rpcUrl of rpcUrls) {
      try {
        const provider = new providers.JsonRpcProvider(rpcUrl);
        multicallResults = await executeMulticall3(provider, calls, {
          timeoutMs: options.timeoutMs ?? 15_000,
          label: `Brevis tokenCumulativeRewards chain=${chainId}`,
        });
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
      for (const c of group) result.set(c.campaignId, undefined);
      continue;
    }

    for (let i = 0; i < group.length; i++) {
      const c = group[i];
      const mcResult = multicallResults[i];

      if (!mcResult?.success) {
        result.set(c.campaignId, undefined);
        continue;
      }

      const rawValue = decodeUint256(mcResult.returnData);
      if (rawValue === null) {
        result.set(c.campaignId, undefined);
        continue;
      }

      const priceKey = chainTokenKey(c.chainId, c.tokenAddr);
      const tokenPrice = tokenPrices.get(priceKey);
      if (tokenPrice === undefined) {
        result.set(c.campaignId, undefined);
        continue;
      }

      const divisor = BigInt(10) ** BigInt(c.decimals);
      const whole = rawValue / divisor;
      const remainder = rawValue % divisor;
      const normalized = Number(whole) + Number(remainder) / Number(divisor);
      const usd = normalized * tokenPrice;

      if (!Number.isFinite(usd)) {
        result.set(c.campaignId, undefined);
        continue;
      }

      result.set(c.campaignId, usd);
    }
  }

  for (const c of campaigns) {
    if (!result.has(c.campaignId)) {
      result.set(c.campaignId, undefined);
    }
  }

  return result;
}
