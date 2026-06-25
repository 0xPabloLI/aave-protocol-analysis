export function normalizeAddress(addr: string): string {
  return addr.toLowerCase().trim();
}

export function spokeKey(chainId: number, spokeAddress: string): string {
  return `${chainId}:${normalizeAddress(spokeAddress)}`;
}

export function v4SpokeCacheKey(spokeAddress: string, hubAddress: string): string {
  return `${normalizeAddress(spokeAddress)}:${normalizeAddress(hubAddress)}`;
}

export function v3PriceKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${normalizeAddress(tokenAddress)}`;
}

export function v4PriceKey(chainId: number, spokeAddress: string, tokenAddress: string): string {
  return `${chainId}:${normalizeAddress(spokeAddress)}:${normalizeAddress(tokenAddress)}`;
}

export function v3OnchainKey(chainId: number, poolAddress: string, tokenAddress: string): string {
  return `${chainId}:${normalizeAddress(poolAddress)}:${normalizeAddress(tokenAddress)}`;
}

export function v4OnchainKey(
  chainId: number,
  spokeAddress: string,
  tokenAddress: string,
  hubAddress: string,
): string {
  return `${chainId}:${normalizeAddress(spokeAddress)}:${normalizeAddress(tokenAddress)}:${normalizeAddress(hubAddress)}`;
}

export function chainTokenKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${normalizeAddress(tokenAddress)}`;
}

export function chainSymbolKey(chainId: number, symbol: string): string {
  return `${chainId}:${symbol}`;
}

export function topologySortKey(
  chainId: number,
  spokeAddress: string,
  hubAddress: string,
): string {
  return `${chainId}:${normalizeAddress(spokeAddress)}:${normalizeAddress(hubAddress)}`;
}

export function v4ReserveId(
  chainId: number,
  spokeAddress: string,
  tokenAddress: string,
  hubAddress: string,
): string {
  return `${chainId}:${normalizeAddress(spokeAddress)}:${normalizeAddress(tokenAddress)}:${normalizeAddress(hubAddress)}`;
}

/** 3-component key for Hub-level matching (no spoke — Hub applies across all spokes). */
export function v4HubScopeKey(
  chainId: number,
  tokenAddress: string,
  hubAddress: string,
): string {
  return `${chainId}:${normalizeAddress(tokenAddress)}:${normalizeAddress(hubAddress)}`;
}

export function aaveProReserveId(
  chainId: number,
  spokeAddress: string,
  underlying: string,
  hubAddress: string,
  hubName: string,
): string {
  return `${chainId}:${normalizeAddress(spokeAddress)}:${normalizeAddress(underlying)}:${normalizeAddress(hubAddress)}:${hubName}`;
}
