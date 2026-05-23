/**
 * Quick V4 SDK test — run with: npx tsx backend/scripts/test-v4-sdk.ts
 */
import { AaveClient, chainId as v4ChainId } from '@aave/client-v4';
import { chains, reserves } from '@aave/client-v4/actions';

async function main() {
  const client = AaveClient.create();

  // Step 1: Discover chains
  console.log('=== Step 1: Chains ===');
  const chainsResult = await chains(client, { query: { filter: 'ALL' as any } });
  if (chainsResult.isErr()) {
    console.error('Chains error:', chainsResult.error.message);
    return;
  }
  const mainnetChains = chainsResult.value.filter((c: any) => !c.isTestnet);
  console.log(`Mainnet chains: ${mainnetChains.length}`);
  mainnetChains.forEach((c: any) => console.log(`  chainId=${c.chainId}, name=${c.name}`));

  const chainIds = mainnetChains.map((c: any) => v4ChainId(Number(c.chainId)));

  // Step 2: Fetch reserves
  console.log('\n=== Step 2: Reserves ===');
  const reservesResult = await reserves(client, { query: { chainIds } });
  if (reservesResult.isErr()) {
    console.error('Reserves error:', reservesResult.error.message);
    return;
  }

  const rawReserves = reservesResult.value;
  console.log(`Total raw reserves from SDK: ${rawReserves.length}`);

  // Show first 3 reserves detail
  rawReserves.slice(0, 3).forEach((r: any, i: number) => {
    console.log(`\n--- Reserve ${i} ---`);
    console.log(`  spoke.name:        ${r.spoke?.name}`);
    console.log(`  spoke.address:     ${r.spoke?.address}`);
    console.log(`  chain.name:        ${r.chain?.name}`);
    console.log(`  chain.chainId:     ${r.chain?.chainId}`);
    console.log(`  token symbol:      ${r.asset?.underlying?.info?.symbol}`);
    console.log(`  token address:     ${r.asset?.underlying?.address}`);
    console.log(`  hub.name:          ${r.asset?.hub?.name}`);
    console.log(`  hub.address:       ${r.asset?.hub?.address}`);
    console.log(`  supplyApy.value:   ${r.summary?.supplyApy?.value}`);
    console.log(`  borrowApy.value:   ${r.summary?.borrowApy?.value}`);
    console.log(`  canSupply:         ${r.canSupply}`);
    console.log(`  canBorrow:         ${r.canBorrow}`);
    console.log(`  status:            frozen=${r.status?.frozen} paused=${r.status?.paused} active=${r.status?.active}`);
    console.log(`  exchangeRate:      ${r.summary?.supplied?.exchangeRate?.value}`);
    console.log(`  supplied (onChain): ${r.summary?.supplied?.amount?.onChainValue}`);
    console.log(`  borrowed (onChain): ${r.summary?.borrowed?.amount?.onChainValue}`);
    console.log(`  supplyCap (onChain): ${r.settings?.supplyCap?.amount?.onChainValue}`);
    console.log(`  borrowCap (onChain): ${r.settings?.borrowCap?.amount?.onChainValue}`);
    console.log(`  utilizationRate:   ${r.asset?.summary?.utilizationRate?.value}`);
    console.log(`  liquidityFee:      ${r.asset?.settings?.liquidityFee?.value}`);
  });

  // Summary by spoke
  const spokeCounts: Record<string, number> = {};
  rawReserves.forEach((r: any) => {
    const name = r.spoke?.name ?? 'Unknown';
    spokeCounts[name] = (spokeCounts[name] || 0) + 1;
  });
  console.log('\n=== Reserves by Spoke ===');
  Object.entries(spokeCounts).sort((a, b) => b[1] - a[1]).forEach(([name, count]) => {
    console.log(`  ${name}: ${count}`);
  });

  // Data quality checks
  let missingSpokeAddress = 0;
  let missingTokenAddress = 0;
  rawReserves.forEach((r: any) => {
    if (!r.spoke?.address) missingSpokeAddress++;
    if (!r.asset?.underlying?.address) missingTokenAddress++;
  });
  console.log('\n=== Data Quality ===');
  console.log(`  Reserves missing spokeAddress: ${missingSpokeAddress}`);
  console.log(`  Reserves missing tokenAddress: ${missingTokenAddress}`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});