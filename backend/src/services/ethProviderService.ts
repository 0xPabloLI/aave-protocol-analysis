import { providers } from 'ethers';
import { logger } from '../logger.js';

type ProviderCandidate = {
  rpcUrl: string;
  provider: providers.StaticJsonRpcProvider;
};

function parseRpcOverrides(raw: string | undefined): Record<number, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string | string[]>;
    const out: Record<number, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const chainId = Number(key);
      if (!Number.isFinite(chainId) || chainId <= 0) continue;
      if (typeof value === 'string' && value.trim()) {
        out[chainId] = [value.trim()];
        continue;
      }
      if (Array.isArray(value)) {
        out[chainId] = value.map((item) => String(item).trim()).filter(Boolean);
      }
    }
    return out;
  } catch (error) {
    logger.warn(`Invalid RATE_INPUTS_RPC_URLS JSON, ignoring override: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function resolveRpcUrls(chainId: number, fallbackUrls: string[]): string[] {
  const envKey = `RATE_INPUTS_RPC_URL_${chainId}`;
  const singleOverride = process.env[envKey];
  if (singleOverride && singleOverride.trim()) return [singleOverride.trim()];

  const mapOverrides = parseRpcOverrides(process.env.RATE_INPUTS_RPC_URLS);
  const mapValue = mapOverrides[chainId];
  if (mapValue && mapValue.length > 0) return mapValue;

  return fallbackUrls;
}

class EthProviderService {
  private providerByKey = new Map<string, providers.StaticJsonRpcProvider>();

  getProvidersForChain(chainId: number, fallbackUrls: string[]): ProviderCandidate[] {
    const urls = resolveRpcUrls(chainId, fallbackUrls);
    const candidates: ProviderCandidate[] = [];

    for (const rpcUrl of urls) {
      const key = `${chainId}:${rpcUrl}`;
      let provider = this.providerByKey.get(key);
      if (!provider) {
        provider = new providers.StaticJsonRpcProvider(rpcUrl, chainId);
        this.providerByKey.set(key, provider);
      }
      candidates.push({ rpcUrl, provider });
    }

    return candidates;
  }
}

export const ethProviderService = new EthProviderService();
