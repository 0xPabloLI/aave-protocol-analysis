const { AaveClient } = require('@aave/client-v4');
const { chains, reserves } = require('@aave/client-v4/actions');

async function main() {
  const client = AaveClient.create();

  console.log('=== Step 1: Chains ===');
  const chainsResult = await chains(client, { query: { filter: 'ALL' } });
  if (chainsResult.isErr()) {
    console.error('Chains error:', chainsResult.error.message);
    return;
  }
  const mainnetChains = chainsResult.value.filter(c => !c.isTestnet);
  console.log('Mainnet chains:', mainnetChains.length);
  mainnetChains.forEach(c => console.log('  chainId=' + c.chainId + ', name=' + c.name));

  const chainIds = mainnetChains.map(c => c.chainId);

  console.log('\n=== Step 2: Reserves ===');
  const reservesResult = await reserves(client, { query: { chainIds } });
  if (reservesResult.isErr()) {
    console.error('Reserves error:', reservesResult.error.message);
    return;
  }

  const rawReserves = reservesResult.value;
  console.log('Total raw reserves from SDK:', rawReserves.length);

  rawReserves.slice(0, 2).forEach((r, i) => {
    console.log('\n--- Reserve ' + i + ' ---');
    console.log('  spoke.name:', r.spoke?.name);
    console.log('  spoke.address:', r.spoke?.address);
    console.log('  chain.name:', r.chain?.name);
    console.log('  chain.chainId:', r.chain?.chainId);
    console.log('  token symbol:', r.asset?.underlying?.info?.symbol);
    console.log('  hub.name:', r.asset?.hub?.name);
    console.log('  canSupply:', r.canSupply);
    console.log('  canBorrow:', r.canBorrow);
  });

  const spokeCounts = {};
  rawReserves.forEach(r => {
    const name = r.spoke?.name || 'Unknown';
    spokeCounts[name] = (spokeCounts[name] || 0) + 1;
  });
  console.log('\n=== By Spoke ===');
  Object.entries(spokeCounts).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log('  ' + n + ': ' + c));

  let missingSpoke = 0, missingToken = 0;
  rawReserves.forEach(r => {
    if (!r.spoke?.address) missingSpoke++;
    if (!r.asset?.underlying?.address) missingToken++;
  });
  console.log('\nMissing spokeAddress:', missingSpoke, 'Missing tokenAddress:', missingToken);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });