import { fifoEvict } from '@internal/aave-shared-contracts';

export interface DynamicRpcCacheOptions {
  fetchChainIdNetwork?: (chainId: number) => Promise<string[]>;
  fetchChainListOrg?: (chainId: number) => Promise<string[]>;
}

const CHAINID_NETWORK_URL = 'https://chainid.network/chains';
const CHAINLIST_ORG_URL = 'https://chainlist.org/rpcs';

async function defaultFetchChainIdNetwork(chainId: number): Promise<string[]> {
  const res = await fetch(`${CHAINID_NETWORK_URL}/${chainId}.json`);
  if (!res.ok) return [];
  const data = await res.json() as { rpc?: string[] };
  return Array.isArray(data?.rpc) ? data.rpc.filter((u): u is string => typeof u === 'string') : [];
}

async function defaultFetchChainListOrg(chainId: number): Promise<string[]> {
  const res = await fetch(`${CHAINLIST_ORG_URL}/${chainId}.json`);
  if (!res.ok) return [];
  const data = await res.json() as { rpc?: string[] };
  return Array.isArray(data?.rpc) ? data.rpc.filter((u): u is string => typeof u === 'string') : [];
}

function filterHttps(urls: string[]): string[] {
  return urls.filter((u) => u.startsWith('https://'));
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

const MAX_CACHE_ENTRIES = 50;

export class DynamicRpcCache {
  private cache = new Map<number, string[]>();
  private readonly fetchChainIdNetwork: (chainId: number) => Promise<string[]>;
  private readonly fetchChainListOrg: (chainId: number) => Promise<string[]>;

  constructor(options: DynamicRpcCacheOptions = {}) {
    this.fetchChainIdNetwork = options.fetchChainIdNetwork ?? defaultFetchChainIdNetwork;
    this.fetchChainListOrg = options.fetchChainListOrg ?? defaultFetchChainListOrg;
  }

  get(chainId: number): string[] | undefined {
    return this.cache.get(chainId);
  }

  get size(): number {
    return this.cache.size;
  }

  set(chainId: number, urls: string[]): void {
    this.cache.set(chainId, urls);
    this.evictOverflow();
  }

  invalidate(chainId: number): void {
    this.cache.delete(chainId);
  }

  private evictOverflow(): void {
    fifoEvict(this.cache, MAX_CACHE_ENTRIES);
  }

  startFetch(chainId: number): void {
    Promise.allSettled([
      this.fetchChainIdNetwork(chainId),
      this.fetchChainListOrg(chainId),
    ])
      .then(([cidResult, clResult]) => {
        const urls: string[] = [];
        if (cidResult.status === 'fulfilled') urls.push(...cidResult.value);
        if (clResult.status === 'fulfilled') urls.push(...clResult.value);
        const merged = dedupe(filterHttps(urls));
        if (merged.length > 0 && !this.cache.has(chainId)) {
          this.cache.set(chainId, merged);
          this.evictOverflow();
        }
      })
      .catch(() => {});
  }
}
