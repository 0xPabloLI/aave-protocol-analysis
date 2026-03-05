import { providers } from 'ethers';

type ProviderCandidate = {
  rpcUrl: string;
  provider: providers.StaticJsonRpcProvider;
};

class EthProviderService {
  private providerByKey = new Map<string, providers.StaticJsonRpcProvider>();

  getProvidersForChain(chainId: number, fallbackUrls: string[]): ProviderCandidate[] {
    const urls = fallbackUrls;
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
