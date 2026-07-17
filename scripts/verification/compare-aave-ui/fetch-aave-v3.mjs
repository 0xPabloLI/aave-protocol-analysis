const V3_GRAPHQL_URL = 'https://api.v3.aave.com/graphql';

const V3_CHAIN_IDS = [1, 42161, 10, 137, 8453, 43114, 1088];

const V3_MARKETS_QUERY = `query Markets($request: MarketsRequest!) {
  value: markets(request: $request) {
    chain { chainId }
    address
    supplyReserves: reserves(request: { reserveType: SUPPLY }) {
      underlyingToken { address symbol decimals chainId }
      supplyInfo {
        apy { raw value formatted }
        total { raw value decimals }
        maxLTV { value formatted }
        liquidationThreshold { value formatted }
        liquidationBonus { value formatted }
        supplyCap { amount { raw value } usd }
        supplyCapReached
        canBeCollateral
      }
      borrowInfo {
        apy { raw value formatted }
        total { usd amount { raw value } }
        utilizationRate { raw value formatted }
        availableLiquidity { usd }
        borrowCap { amount { raw value } usd }
        borrowCapReached
        baseVariableBorrowRate { raw value formatted }
        variableRateSlope1 { raw value formatted }
        variableRateSlope2 { raw value formatted }
        optimalUsageRate { raw value formatted }
        reserveFactor { raw value formatted }
      }
      isFrozen
      isPaused
    }
  }
}`;

async function fetchV3Markets(chainIds = V3_CHAIN_IDS) {
  console.log(`[V3] Fetching markets from ${V3_GRAPHQL_URL} for chains [${chainIds}]...`);

  const response = await fetch(V3_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: V3_MARKETS_QUERY,
      variables: { request: { chainIds } },
    }),
  });

  if (!response.ok) {
    throw new Error(`V3 GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.errors?.length) {
    const msgs = json.errors.map((e) => e.message).join('; ');
    throw new Error(`V3 GraphQL errors: ${msgs}`);
  }

  const markets = json.data?.value ?? [];
  console.log(`[V3] Got ${markets.length} markets, ${markets.reduce((s, m) => s + (m.supplyReserves?.length ?? 0), 0)} supply reserves total`);

  const reserves = [];
  for (const market of markets) {
    const chainId = market.chain?.chainId;
    const poolAddress = market.address;
    if (!chainId || !market.supplyReserves) continue;

    for (const r of market.supplyReserves) {
      const tokenAddress = r.underlyingToken?.address;
      const tokenSymbol = r.underlyingToken?.symbol;
      const decimals = r.underlyingToken?.decimals ?? 18;
      if (!tokenAddress) continue;

      reserves.push({
        version: 'v3',
        chainId,
        poolAddress,
        tokenAddress: tokenAddress.toLowerCase(),
        tokenSymbol,
        decimals,
        supplyApy: parseFloat(r.supplyInfo?.apy?.value ?? '0') * 100,
        supplyApyRaw: r.supplyInfo?.apy?.raw,
        supplyApyFormatted: r.supplyInfo?.apy?.formatted,
        totalSupply: r.supplyInfo?.total?.value,
        totalSupplyRaw: r.supplyInfo?.total?.raw,
        ltv: parseFloat(r.supplyInfo?.maxLTV?.value ?? '0') * 100,
        ltvFormatted: r.supplyInfo?.maxLTV?.formatted,
        liquidationThreshold: parseFloat(r.supplyInfo?.liquidationThreshold?.value ?? '0') * 100,
        liquidationBonus: parseFloat(r.supplyInfo?.liquidationBonus?.value ?? '0') * 100,
        supplyCap: r.supplyInfo?.supplyCap?.amount?.value,
        supplyCapRaw: r.supplyInfo?.supplyCap?.amount?.raw,
        supplyCapUsd: r.supplyInfo?.supplyCap?.usd,
        supplyCapReached: r.supplyInfo?.supplyCapReached,
        canBeCollateral: r.supplyInfo?.canBeCollateral,
        borrowApy: r.borrowInfo ? parseFloat(r.borrowInfo.apy?.value ?? '0') * 100 : null,
        borrowApyRaw: r.borrowInfo?.apy?.raw,
        borrowApyFormatted: r.borrowInfo?.apy?.formatted,
        totalBorrowUsd: r.borrowInfo?.total?.usd,
        totalBorrow: r.borrowInfo?.total?.amount?.value,
        utilizationRate: r.borrowInfo ? parseFloat(r.borrowInfo.utilizationRate?.value ?? '0') * 100 : null,
        utilizationRateRaw: r.borrowInfo?.utilizationRate?.raw,
        availableLiquidityUsd: r.borrowInfo?.availableLiquidity?.usd,
        borrowCap: r.borrowInfo?.borrowCap?.amount?.value,
        borrowCapRaw: r.borrowInfo?.borrowCap?.amount?.raw,
        borrowCapUsd: r.borrowInfo?.borrowCap?.usd,
        borrowCapReached: r.borrowInfo?.borrowCapReached,
        baseVariableBorrowRate: r.borrowInfo ? parseFloat(r.borrowInfo.baseVariableBorrowRate?.value ?? '0') * 100 : null,
        variableRateSlope1: r.borrowInfo ? parseFloat(r.borrowInfo.variableRateSlope1?.value ?? '0') * 100 : null,
        variableRateSlope2: r.borrowInfo ? parseFloat(r.borrowInfo.variableRateSlope2?.value ?? '0') * 100 : null,
        optimalUsageRate: r.borrowInfo ? parseFloat(r.borrowInfo.optimalUsageRate?.value ?? '0') * 100 : null,
        reserveFactor: r.borrowInfo ? parseFloat(r.borrowInfo.reserveFactor?.value ?? '0') * 100 : null,
        isFrozen: r.isFrozen,
        isPaused: r.isPaused,
      });
    }
  }

  console.log(`[V3] Normalized ${reserves.length} reserves`);
  return reserves;
}

export { fetchV3Markets, V3_GRAPHQL_URL, V3_CHAIN_IDS };
