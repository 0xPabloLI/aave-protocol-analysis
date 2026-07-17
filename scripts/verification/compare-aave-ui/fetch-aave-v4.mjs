const V4_GRAPHQL_URL = 'https://api.aave.com/graphql';

const V4_HUB_CHAIN_IDS = [1];

const V4_RESERVES_QUERY = `query Reserves($request: ReservesRequest!) {
  reserves(request: $request) {
    id
    onChainId
    chain { chainId }
    spoke { chain { chainId } name }
    summary {
      supplied {
        amount { onChainValue value decimals }
        token { info { symbol decimals } address }
      }
      borrowed {
        amount { onChainValue value decimals }
      }
      supplyApy { onChainValue value normalized }
      borrowApy { onChainValue value normalized }
    }
    settings {
      collateralFactor { onChainValue value normalized }
      supplyCap { amount { onChainValue value decimals } }
      borrowCap { amount { onChainValue value decimals } }
      borrowable
      collateral
      suppliable
    }
    status { frozen paused active }
  }
}`;

async function fetchV4Reserves(chainIds = V4_HUB_CHAIN_IDS) {
  console.log(`[V4] Fetching reserves from ${V4_GRAPHQL_URL} for hub chains [${chainIds}]...`);

  const allReserves = [];

  for (const hubChainId of chainIds) {
    const response = await fetch(V4_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: V4_RESERVES_QUERY,
        variables: { request: { query: { chainIds: [hubChainId] } } },
      }),
    });

    if (!response.ok) {
      console.error(`[V4] Hub chain ${hubChainId} request failed: ${response.status}`);
      continue;
    }

    const json = await response.json();
    if (json.errors?.length) {
      const msgs = json.errors.map((e) => e.message).join('; ');
      console.error(`[V4] Hub chain ${hubChainId} GraphQL errors: ${msgs}`);
      continue;
    }

    const reserves = json.data?.reserves ?? [];
    console.log(`[V4] Hub chain ${hubChainId}: got ${reserves.length} reserves`);

    for (const r of reserves) {
      const spokeChainId = r.spoke?.chain?.chainId ?? r.chain?.chainId;
      const spokeName = r.spoke?.name;
      const tokenSymbol = r.summary?.supplied?.token?.info?.symbol;
      const tokenAddress = r.summary?.supplied?.token?.address;
      const decimals = r.summary?.supplied?.token?.info?.decimals ?? r.summary?.supplied?.amount?.decimals ?? 18;

      if (!spokeChainId) continue;

      allReserves.push({
        version: 'v4',
        hubChainId: r.chain?.chainId,
        spokeChainId,
        spokeName,
        reserveGraphqlId: r.id,
        onChainId: r.onChainId,
        tokenAddress: tokenAddress?.toLowerCase(),
        tokenSymbol,
        decimals,
        supplyApy: parseFloat(r.summary?.supplyApy?.normalized ?? r.summary?.supplyApy?.value ?? '0'),
        supplyApyOnChain: r.summary?.supplyApy?.onChainValue,
        supplyApyValue: r.summary?.supplyApy?.value,
        borrowApy: parseFloat(r.summary?.borrowApy?.normalized ?? r.summary?.borrowApy?.value ?? '0'),
        borrowApyOnChain: r.summary?.borrowApy?.onChainValue,
        borrowApyValue: r.summary?.borrowApy?.value,
        totalSupply: r.summary?.supplied?.amount?.value,
        totalSupplyRaw: r.summary?.supplied?.amount?.onChainValue,
        totalBorrow: r.summary?.borrowed?.amount?.value,
        totalBorrowRaw: r.summary?.borrowed?.amount?.onChainValue,
        collateralFactor: parseFloat(r.summary?.settings?.collateralFactor?.normalized ?? r.settings?.collateralFactor?.value ?? '0'),
        collateralFactorOnChain: r.settings?.collateralFactor?.onChainValue,
        supplyCap: r.settings?.supplyCap?.amount?.value,
        supplyCapRaw: r.settings?.supplyCap?.amount?.onChainValue,
        borrowCap: r.settings?.borrowCap?.amount?.value,
        borrowCapRaw: r.settings?.borrowCap?.amount?.onChainValue,
        borrowable: r.settings?.borrowable,
        collateral: r.settings?.collateral,
        suppliable: r.settings?.suppliable,
        isFrozen: r.status?.frozen,
        isPaused: r.status?.paused,
        isActive: r.status?.active,
      });
    }
  }

  console.log(`[V4] Normalized ${allReserves.length} reserves`);
  return allReserves;
}

export { fetchV4Reserves, V4_GRAPHQL_URL, V4_HUB_CHAIN_IDS };
