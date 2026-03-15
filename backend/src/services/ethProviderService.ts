import { providers } from 'ethers';

type ProviderCandidate = {
  rpcUrl: string;
  provider: providers.StaticJsonRpcProvider;
};

type EndpointHealth = {
  consecutiveFailures: number;
  suppressedUntil: number;
  lastError: string;
  lastFailureAt: number;
};

type UnhealthyEndpoint = {
  chainId: number;
  rpcUrl: string;
  lastError: string;
  suppressedUntil: string;
};

type EthProviderServiceOptions = {
  failureThreshold?: number;
  suppressionMs?: number;
  now?: () => number;
};

const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_SUPPRESSION_MS = 5 * 60_000;

export class EthProviderService {
  private providerByKey = new Map<string, providers.StaticJsonRpcProvider>();
  private endpointHealthByKey = new Map<string, EndpointHealth>();
  private readonly failureThreshold: number;
  private readonly suppressionMs: number;
  private readonly now: () => number;

  constructor(options: EthProviderServiceOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.suppressionMs = Math.max(1_000, options.suppressionMs ?? DEFAULT_SUPPRESSION_MS);
    this.now = options.now ?? Date.now;
  }

  private endpointKey(chainId: number, rpcUrl: string): string {
    return `${chainId}:${rpcUrl}`;
  }

  private isSuppressed(health: EndpointHealth | undefined): boolean {
    if (!health) return false;
    return health.suppressedUntil > this.now();
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
    });
  }

  reportProviderSuccess(chainId: number, rpcUrl: string): void {
    const key = this.endpointKey(chainId, rpcUrl);
    const current = this.endpointHealthByKey.get(key);
    if (!current) return;
    this.endpointHealthByKey.set(key, {
      consecutiveFailures: 0,
      suppressedUntil: 0,
      lastError: current.lastError,
      lastFailureAt: current.lastFailureAt,
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
    const urls = fallbackUrls;
    const healthyCandidates: ProviderCandidate[] = [];
    const suppressedCandidates: ProviderCandidate[] = [];

    for (const rpcUrl of urls) {
      const key = `${chainId}:${rpcUrl}`;
      let provider = this.providerByKey.get(key);
      if (!provider) {
        provider = new providers.StaticJsonRpcProvider(rpcUrl, chainId);
        this.providerByKey.set(key, provider);
      }
      const candidate = { rpcUrl, provider };
      const health = this.endpointHealthByKey.get(key);
      if (this.isSuppressed(health)) {
        suppressedCandidates.push(candidate);
      } else {
        healthyCandidates.push(candidate);
      }
    }

    // Try healthy endpoints first. If all are currently suppressed, keep suppressed as a last resort.
    return [...healthyCandidates, ...suppressedCandidates];
  }
}

export const ethProviderService = new EthProviderService();
