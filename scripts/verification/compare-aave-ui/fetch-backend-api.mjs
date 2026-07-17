const DEFAULT_BACKEND_URL = 'https://staging-api.aaveapy.com/api/markets';

async function fetchBackendApi(backendUrl = DEFAULT_BACKEND_URL) {
  console.log(`[Backend] Fetching from ${backendUrl}...`);

  const response = await fetch(backendUrl);
  if (!response.ok) {
    throw new Error(`Backend API request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const reserves = json.reserves ?? [];
  console.log(`[Backend] Got ${reserves.length} reserves`);

  const normalized = reserves.map((r) => {
    const parts = (r.reserveId ?? '').split(':');
    const chainId = parseInt(parts[0], 10);
    const poolAddress = parts[1]?.toLowerCase();
    const tokenAddress = parts[2]?.toLowerCase();
    const isV4 = !!(r.hubId || r.spokeId || (r.marketName && /v4/i.test(r.marketName)));

    let supplyCapValue = r.supplyCap;
    let borrowCapValue = r.borrowCap;
    const decimals = r.decimals || r.tokenDecimals || undefined;

    let spokeChainId;
    if (isV4 && r.spokeId) {
      try {
        const decoded = Buffer.from(r.spokeId, 'base64').toString('utf-8');
        const match = decoded.match(/^(\d+):/);
        if (match) spokeChainId = parseInt(match[1], 10);
      } catch {}
    }

    let aaveProReserveId;
    if (isV4 && r.aaveProReserveId) {
      aaveProReserveId = r.aaveProReserveId;
    }

    return {
      version: isV4 ? 'v4' : 'v3',
      reserveId: r.reserveId,
      chainId,
      poolAddress,
      tokenAddress,
      tokenSymbol: r.tokenSymbol,
      decimals,
      supplyApy: r.supplyApy,
      borrowApy: r.borrowApy,
      totalSupplyUsd: r.totalSupplyUsd,
      totalBorrowUsd: r.totalBorrowUsd,
      utilizationPct: r.utilizationPct,
      ltv: r.ltv,
      liquidationThreshold: r.liquidationThreshold,
      supplyCap: supplyCapValue,
      borrowCap: borrowCapValue,
      supplyCapRaw: r.supplyCap,
      borrowCapRaw: r.borrowCap,
      isFrozen: r.isFrozen,
      isPaused: r.isPaused,
      collateralFactor: r.collateralFactor,
      isV4,
      marketName: r.marketName,
      hubChainId: r.hubChainId ?? (isV4 ? chainId : undefined),
      spokeChainId: r.spokeChainId ?? spokeChainId ?? (isV4 ? chainId : undefined),
      spokeName: r.spokeName,
      aaveProReserveId,
    };
  });

  console.log(`[Backend] Normalized ${normalized.length} reserves (V3: ${normalized.filter((r) => r.version === 'v3').length}, V4: ${normalized.filter((r) => r.version === 'v4').length})`);
  return normalized;
}

export { fetchBackendApi, DEFAULT_BACKEND_URL };
