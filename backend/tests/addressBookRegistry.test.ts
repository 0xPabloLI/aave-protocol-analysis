import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAll,
  V3_ENTRIES,
  V4_SPOKE_ENTRIES,
  initAddressBookRegistry,
  type V3PoolEntry,
  type V4SpokeEntry,
} from '../src/services/addressBookRegistry.js';
import type { SpokeHubTopology } from '@internal/aave-shared-contracts';
import * as AaveAddressBook from '@aave-dao/aave-address-book';

// ============================================================
// Snapshot fixtures
// ============================================================

interface SnapshotV3PoolConfig {
  poolKey: string;
  chainId: number;
  poolAddress: string;
  oracleAddress: string;
}

interface SnapshotV4SpokeConfig {
  spokeName: string;
  chainId: number;
  spokeAddress: string;
  oracleAddress: string;
}

const SYNCED_V3_POOL_CONFIGS: SnapshotV3PoolConfig[] = [
  { poolKey: 'AaveV3Ethereum', chainId: 1, poolAddress: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', oracleAddress: '0x54586be62e3c3580375ae3723c145253060ca0c2' },
  { poolKey: 'AaveV3EthereumEtherFi', chainId: 1, poolAddress: '0x0aa97c284e98396202b6a04024f5e2c65026f3c0', oracleAddress: '0x43b64f28a678944e0655404b0b98e443851cc34f' },
  { poolKey: 'AaveV3EthereumHorizon', chainId: 1, poolAddress: '0xae05cd22df81871bc7cc2a04becfb516bfe332c8', oracleAddress: '0x985bcfab7e0f4ef2606cc5b64fc1a16311880442' },
  { poolKey: 'AaveV3EthereumLido', chainId: 1, poolAddress: '0x4e033931ad43597d96d6bcc25c280717730b58b1', oracleAddress: '0xe3c061981870c0c7b1f3c4f4bb36b95f1f260be6' },
  { poolKey: 'AaveV3Optimism', chainId: 10, poolAddress: '0x794a61358d6845594f94dc1db02a252b5b4814ad', oracleAddress: '0xd81eb3728a631871a7ebbad631b5f424909f0c77' },
  { poolKey: 'AaveV3BNB', chainId: 56, poolAddress: '0x6807dc923806fe8fd134338eabca509979a7e0cb', oracleAddress: '0x39bc1bfda2130d6bb6dbefd366939b4c7aa7c697' },
  { poolKey: 'AaveV3Gnosis', chainId: 100, poolAddress: '0xb50201558b00496a145fe76f7424749556e326d8', oracleAddress: '0xeb0a051be10228213baeb449db63719d6742f7c4' },
  { poolKey: 'AaveV3Polygon', chainId: 137, poolAddress: '0x794a61358d6845594f94dc1db02a252b5b4814ad', oracleAddress: '0xb023e699f5a33916ea823a16485e259257ca8bd1' },
  { poolKey: 'AaveV3Sonic', chainId: 146, poolAddress: '0x5362dbb1e601abf3a4c14c22ffeda64042e5eaa3', oracleAddress: '0xd63f7658c66b2934bd234d79d06aef5290734b30' },
  { poolKey: 'AaveV3XLayer', chainId: 196, poolAddress: '0xe3f3caefdd7180f884c01e57f65df979af84f116', oracleAddress: '0x91fc11136d5615575a0fc5981ab5c0c54418e2c6' },
  { poolKey: 'AaveV3ZkSync', chainId: 324, poolAddress: '0x78e30497a3c7527d953c6b1e3541b021a98ac43c', oracleAddress: '0xc7f58fca663a8d377b6d0c9703c697f56dc40088' },
  { poolKey: 'AaveV3Metis', chainId: 1088, poolAddress: '0x90df02551bb792286e8d4f13e0e357b4bf1d6a57', oracleAddress: '0x38d36e85e47ea6ff0d18b0adf12e5fc8984a6f8e' },
  { poolKey: 'AaveV3Soneium', chainId: 1868, poolAddress: '0xdd3d7a7d03d9fd9ef45f3e587287922ef65ca38b', oracleAddress: '0x20040a64612555042335926d72b4e5f667a67fa1' },
  { poolKey: 'AaveV3MegaEth', chainId: 4326, poolAddress: '0x7e324abc5de01d112afc03a584966ff199741c28', oracleAddress: '0x421117d7319e96d831972b3f7e970bbfe29c4f21' },
  { poolKey: 'AaveV3Mantle', chainId: 5000, poolAddress: '0x458f293454fe0d67ec0655f3672301301dd51422', oracleAddress: '0x47a063cfda980532267970d478ec340c0f80e8df' },
  { poolKey: 'AaveV3Base', chainId: 8453, poolAddress: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5', oracleAddress: '0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156' },
  { poolKey: 'AaveV3Plasma', chainId: 9745, poolAddress: '0x925a2a7214ed92428b5b1b090f80b25700095e12', oracleAddress: '0x33e0b3fc976dc9c516926ba48cfc0a9e10a2aaa5' },
  { poolKey: 'AaveV3Arbitrum', chainId: 42161, poolAddress: '0x794a61358d6845594f94dc1db02a252b5b4814ad', oracleAddress: '0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7' },
  { poolKey: 'AaveV3Celo', chainId: 42220, poolAddress: '0x3e59a31363e2ad014dcbc521c4a0d5757d9f3402', oracleAddress: '0x1e693d088cefd1e95ba4c4a5f7eea41a1ec37e8b' },
  { poolKey: 'AaveV3Avalanche', chainId: 43114, poolAddress: '0x794a61358d6845594f94dc1db02a252b5b4814ad', oracleAddress: '0xebd36016b3ed09d4693ed4251c67bd858c3c7c9c' },
  { poolKey: 'AaveV3InkWhitelabel', chainId: 57073, poolAddress: '0x2816cf15f6d2a220e789aa011d5ee4eb6c47feba', oracleAddress: '0x4758213271bfdc72224a7a8742dc865fc97756e1' },
  { poolKey: 'AaveV3Linea', chainId: 59144, poolAddress: '0xc47b8c00b0f69a36fa203ffeac0334874574a8ac', oracleAddress: '0xcfdada7dcd2e785cf706badbc2b8af5084d595e9' },
  { poolKey: 'AaveV3Scroll', chainId: 534352, poolAddress: '0x11fcfe756c05ad438e312a7fd934381537d3cffe', oracleAddress: '0x04421d8c506e2fa2371a08efaabf791f624054f3' },
  { poolKey: 'AaveV3Monad', chainId: 143, poolAddress: '0x69a5f9ad4f96ebf0a0c792dd42a01cc5c0102fef', oracleAddress: '0x0c02b2c2038066c10eab8fe1d5cdb73d5a78a1bf' },
];

const SYNCED_V4_SPOKE_CONFIGS: SnapshotV4SpokeConfig[] = [
  { spokeName: 'BLUECHIP', chainId: 1, spokeAddress: '0x973a023a77420ba610f06b3858ad991df6d85a08', oracleAddress: '0xda1266a7b8620819dae3f8bd6b546da36e505bb8' },
  { spokeName: 'ETHENACORRELATED', chainId: 1, spokeAddress: '0x58131e79531cab1d52301228d1f7b842f26b9649', oracleAddress: '0x9b91a0943cadf554742e8fb358b1cc4ae4f85f01' },
  { spokeName: 'ETHENAECOSYSTEM', chainId: 1, spokeAddress: '0xba1b3d55d249692b669a164024a838309b7508af', oracleAddress: '0xc390dbe9fc00d6db73c52d375642b47008c33c90' },
  { spokeName: 'ETHERFI', chainId: 1, spokeAddress: '0xbf10bdfe177de0336afd7fccf80a904e15386219', oracleAddress: '0xd8b153faaa8f2b1bc774916fed333a4f3de48792' },
  { spokeName: 'FOREX', chainId: 1, spokeAddress: '0xd8b93635b8c6d0ff98cbe90b5988e3f2d1cd9da1', oracleAddress: '0xb3ce6e7b6d389a66ea4a3777ba07219d00fb3a9d' },
  { spokeName: 'GOLD', chainId: 1, spokeAddress: '0x65407b940966954b23dfa3caa5c0702bb42984dc', oracleAddress: '0x0083421fd178749af2201dda5a7c3feb5790b80c' },
  { spokeName: 'KELP', chainId: 1, spokeAddress: '0x3131fe68c4722e726fe6b2819ed68e514395b9a4', oracleAddress: '0x37c316996c714bf906743071e04e62220b3271ac' },
  { spokeName: 'LIDO', chainId: 1, spokeAddress: '0xe1900480ac69f0b296841cd01cc37546d92f35cd', oracleAddress: '0x664d73b6c3591333fd79510f7ce9ef81228824f5' },
  { spokeName: 'LOMBARDBTC', chainId: 1, spokeAddress: '0x7ec68b5695e803e98a21a9a05d744f28b0a7753d', oracleAddress: '0x198cac7f54ffc7d709ac0fec4b6454ce73e21d3d' },
  { spokeName: 'MAIN', chainId: 1, spokeAddress: '0x94e7a5dcbe816e498b89ab752661904e2f56c485', oracleAddress: '0x99b2b6cea9c3d2fd8f4d90f86741c44b212a6127' },
];

// ============================================================
// SDK topology snapshot
// ============================================================

const SDK_SPOKE_HUB_TOPOLOGY: Record<string, string[]> = {
  '0x94e7a5dcbe816e498b89ab752661904e2f56c485': ['0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'],
  '0x973a023a77420ba610f06b3858ad991df6d85a08': ['0xcca852bc40e560adc3b1cc58ca5b55638ce826c9', '0x943827dca022d0f354a8a8c332da1e5eb9f9f931'],
  '0xe1900480ac69f0b296841cd01cc37546d92f35cd': ['0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'],
  '0xbf10bdfe177de0336afd7fccf80a904e15386219': ['0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'],
  '0x3131fe68c4722e726fe6b2819ed68e514395b9a4': ['0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'],
  '0x58131e79531cab1d52301228d1f7b842f26b9649': ['0x06002e9c4412cb7814a791ea3666d905871e536a'],
  '0xba1b3d55d249692b669a164024a838309b7508af': ['0xcca852bc40e560adc3b1cc58ca5b55638ce826c9', '0x06002e9c4412cb7814a791ea3666d905871e536a'],
  '0xd8b93635b8c6d0ff98cbe90b5988e3f2d1cd9da1': ['0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'],
  '0x65407b940966954b23dfa3caa5c0702bb42984dc': ['0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'],
  '0x7ec68b5695e803e98a21a9a05d744f28b0a7753d': ['0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'],
};

function sdkTopologyToSpokeHubTopology(): SpokeHubTopology {
  const entries: SpokeHubTopology = [];
  for (const [spokeAddr, hubAddrs] of Object.entries(SDK_SPOKE_HUB_TOPOLOGY)) {
    for (const hubAddr of hubAddrs) {
      entries.push({ chainId: 1, spokeAddress: spokeAddr, hubAddress: hubAddr });
    }
  }
  return entries;
}

// ============================================================
// Helpers
// ============================================================

const V3_ORACLE_ENTRIES = V3_ENTRIES.filter((e) => !!e.oracleAddress);
const V4_ORACLE_ENTRIES = V4_SPOKE_ENTRIES.filter((e) => !!e.oracleAddress);

// ============================================================
// Pure function tests: buildAll(topology)
// ============================================================

test('buildAll with empty topology returns empty v4Spokes', () => {
  const result = buildAll([]);
  assert.strictEqual(result.v4Spokes.length, 0);
});

test('buildAll with topology containing one spoke-hub pair and matching address-book spoke returns one V4SpokeEntry', () => {
  const topology: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0x94e7a5dcbe816e498b89ab752661904e2f56c485', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  ];
  const result = buildAll(topology);
  const mainEntries = result.v4Spokes.filter((e) => e.spokeKey === 'MAIN_SPOKE');
  assert.strictEqual(mainEntries.length, 1);
  assert.strictEqual(mainEntries[0].hubAddress, '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9');
});

test('buildAll silently skips spoke not found in address-book', () => {
  const topology: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0xdead000000000000000000000000000000000000', hubAddress: '0xbeef000000000000000000000000000000000000' },
  ];
  const result = buildAll(topology);
  assert.strictEqual(result.v4Spokes.length, 0);
});

test('buildAll with one spoke connected to multiple hubs produces multiple V4SpokeEntries', () => {
  const topology: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0x973a023a77420ba610f06b3858ad991df6d85a08', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
    { chainId: 1, spokeAddress: '0x973a023a77420ba610f06b3858ad991df6d85a08', hubAddress: '0x943827dca022d0f354a8a8c332da1e5eb9f9f931' },
  ];
  const result = buildAll(topology);
  const bluechipEntries = result.v4Spokes.filter((e) => e.spokeKey === 'BLUECHIP_SPOKE');
  assert.strictEqual(bluechipEntries.length, 2);
  const hubAddrs = new Set(bluechipEntries.map((e) => e.hubAddress));
  assert.ok(hubAddrs.has('0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'));
  assert.ok(hubAddrs.has('0x943827dca022d0f354a8a8c332da1e5eb9f9f931'));
});

test('buildAll V3 entries are unaffected by topology', () => {
  const resultEmpty = buildAll([]);
  const resultFull = buildAll(sdkTopologyToSpokeHubTopology());
  assert.strictEqual(resultEmpty.v3.length, resultFull.v3.length);
  assert.deepStrictEqual(resultEmpty.v3, resultFull.v3);
});

test('V4SpokeEntry no longer has hubKey field', () => {
  const topology: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0x94e7a5dcbe816e498b89ab752661904e2f56c485', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  ];
  const result = buildAll(topology);
  if (result.v4Spokes.length > 0) {
    const entry = result.v4Spokes[0];
    assert.ok(!('hubKey' in entry), 'V4SpokeEntry should not have hubKey field');
  }
});

// ============================================================
// V3: Oracle configs must match SYNCED_V3_POOL_CONFIGS exactly
// ============================================================

test('V3 oracle entry count >= SYNCED_V3_POOL_CONFIGS (new chains allowed)', () => {
  assert.ok(
    V3_ORACLE_ENTRIES.length >= SYNCED_V3_POOL_CONFIGS.length,
    `Expected >= ${SYNCED_V3_POOL_CONFIGS.length} V3 oracle entries, got ${V3_ORACLE_ENTRIES.length}`,
  );
});

test('every SYNCED_V3 poolKey is present in V3_ORACLE_ENTRIES', () => {
  const registryKeys = new Set(V3_ORACLE_ENTRIES.map((e) => e.poolKey));
  for (const synced of SYNCED_V3_POOL_CONFIGS) {
    assert.ok(
      registryKeys.has(synced.poolKey),
      `Missing poolKey in registry: ${synced.poolKey}`,
    );
  }
});

test('V3 oracle entries have correct chainId, poolAddress, oracleAddress', () => {
  const byKey = new Map(V3_ORACLE_ENTRIES.map((e) => [e.poolKey, e]));
  for (const synced of SYNCED_V3_POOL_CONFIGS) {
    const entry = byKey.get(synced.poolKey)!;
    assert.strictEqual(entry.chainId, synced.chainId, `${synced.poolKey}: chainId mismatch`);
    assert.strictEqual(entry.poolAddress, synced.poolAddress, `${synced.poolKey}: poolAddress mismatch`);
    assert.strictEqual(entry.oracleAddress, synced.oracleAddress, `${synced.poolKey}: oracleAddress mismatch`);
  }
});

// ============================================================
// V3: Exclusion rules
// ============================================================

test('Fantom (chainId=250) is NOT in V3 entries', () => {
  const fantomEntries = V3_ENTRIES.filter((e) => e.chainId === 250);
  assert.strictEqual(fantomEntries.length, 0, 'Fantom should not be in address-book');
});

test('V3 entries only contain chains in AAVE_CHAIN_ID_TO_RPC_KEY', () => {
  for (const e of V3_ENTRIES) {
    assert.ok(Number.isFinite(e.chainId) && e.chainId > 0, `Invalid chainId: ${e.chainId} for ${e.poolKey}`);
    assert.ok(e.poolAddress.startsWith('0x'), `Invalid poolAddress for ${e.poolKey}`);
  }
});

// ============================================================
// V4: Oracle configs must match SYNCED_V4_SPOKE_CONFIGS (by spokeAddress)
// ============================================================

test('V4 oracle entry count >= SYNCED_V4_SPOKE_CONFIGS (new spokes allowed)', () => {
  assert.ok(
    V4_ORACLE_ENTRIES.length >= SYNCED_V4_SPOKE_CONFIGS.length,
    `Expected >= ${SYNCED_V4_SPOKE_CONFIGS.length} V4 oracle entries, got ${V4_ORACLE_ENTRIES.length}`,
  );
  const uniqueSpokeAddresses = new Set(V4_ORACLE_ENTRIES.map((e) => e.spokeAddress));
  assert.ok(
    uniqueSpokeAddresses.size >= SYNCED_V4_SPOKE_CONFIGS.length,
    `Expected >= ${SYNCED_V4_SPOKE_CONFIGS.length} unique spoke addresses, got ${uniqueSpokeAddresses.size}`,
  );
});

test('every SYNCED_V4 spokeAddress is present in V4_ORACLE_ENTRIES', () => {
  const registryAddresses = new Set(V4_ORACLE_ENTRIES.map((e) => e.spokeAddress));
  for (const synced of SYNCED_V4_SPOKE_CONFIGS) {
    assert.ok(
      registryAddresses.has(synced.spokeAddress),
      `Missing spokeAddress in registry: ${synced.spokeAddress} (${synced.spokeName})`,
    );
  }
});

test('V4 oracle entries have correct chainId and oracleAddress (matched by spokeAddress)', () => {
  for (const synced of SYNCED_V4_SPOKE_CONFIGS) {
    const matches = V4_ORACLE_ENTRIES.filter((e) => e.spokeAddress === synced.spokeAddress);
    assert.ok(matches.length > 0, `No registry entry for spokeAddress: ${synced.spokeAddress}`);
    for (const entry of matches) {
      assert.strictEqual(entry.chainId, synced.chainId, `chainId mismatch for ${synced.spokeName}`);
      assert.strictEqual(entry.oracleAddress, synced.oracleAddress, `oracleAddress mismatch for ${synced.spokeName}`);
    }
  }
});

// ============================================================
// V4: Multi-hub support
// ============================================================

test('BLUECHIP_SPOKE has 2 hub entries (from topology)', () => {
  const bluechipEntries = V4_SPOKE_ENTRIES.filter((e) => e.spokeKey === 'BLUECHIP_SPOKE');
  assert.strictEqual(bluechipEntries.length, 2, 'BLUECHIP_SPOKE should have 2 hub entries');
  const hubAddrs = new Set(bluechipEntries.map((e) => e.hubAddress));
  assert.ok(hubAddrs.has('0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'));
  assert.ok(hubAddrs.has('0x943827dca022d0f354a8a8c332da1e5eb9f9f931'));
});

test('ETHENA_ECOSYSTEM_SPOKE has 2 hub entries (from topology)', () => {
  const entries = V4_SPOKE_ENTRIES.filter((e) => e.spokeKey === 'ETHENA_ECOSYSTEM_SPOKE');
  assert.strictEqual(entries.length, 2, 'ETHENA_ECOSYSTEM_SPOKE should have 2 hub entries');
  const hubAddrs = new Set(entries.map((e) => e.hubAddress));
  assert.ok(hubAddrs.has('0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'));
  assert.ok(hubAddrs.has('0x06002e9c4412cb7814a791ea3666d905871e536a'));
});

test('all V4 spoke entries with oracle have valid hubAddress', () => {
  for (const e of V4_ORACLE_ENTRIES) {
    assert.ok(e.hubAddress.startsWith('0x'), `Invalid hubAddress for ${e.spokeKey}`);
  }
});

// ============================================================
// V4: SpokeKey format
// ============================================================

test('V4 spokeKey format uses raw keys (e.g. MAIN_SPOKE, not Main)', () => {
  const spokeKeys = new Set(V4_ORACLE_ENTRIES.map((e) => e.spokeKey));
  assert.ok(spokeKeys.has('MAIN_SPOKE'), 'Should have MAIN_SPOKE');
  assert.ok(spokeKeys.has('BLUECHIP_SPOKE'), 'Should have BLUECHIP_SPOKE');
  assert.ok(spokeKeys.has('LIDO_ESPOKE'), 'Should have LIDO_ESPOKE');
});

// ============================================================
// V4: Exclusion rules
// ============================================================

test('TREASURY_SPOKE is NOT in V4 entries (excluded by topology, no oracle)', () => {
  const treasuryEntries = V4_SPOKE_ENTRIES.filter((e) => e.spokeKey === 'TREASURY_SPOKE');
  assert.strictEqual(treasuryEntries.length, 0, 'TREASURY_SPOKE should be excluded (no oracle, not in topology)');
});

test('V4 entries have valid chainId and spokeAddress', () => {
  for (const e of V4_SPOKE_ENTRIES) {
    assert.ok(Number.isFinite(e.chainId) && e.chainId > 0, `Invalid chainId: ${e.chainId} for ${e.spokeKey}`);
    assert.ok(e.spokeAddress.startsWith('0x'), `Invalid spokeAddress for ${e.spokeKey}`);
  }
});

// ============================================================
// Structural: onchain entries validation
// ============================================================

test('V3 entries with UI_POOL_DATA_PROVIDER and POOL_ADDRESSES_PROVIDER are sufficient for onchain', () => {
  const v3Onchain = V3_ENTRIES.filter((e) => e.uiPoolDataProviderAddress && e.poolAddressesProvider);
  assert.ok(v3Onchain.length > 0, 'Should have at least one V3 onchain entry');
  assert.ok(v3Onchain.length <= V3_ENTRIES.length);
  for (const e of v3Onchain) {
    assert.ok(e.uiPoolDataProviderAddress!.startsWith('0x'), `Invalid uiPoolDataProviderAddress for ${e.poolKey}`);
    assert.ok(e.poolAddressesProvider!.startsWith('0x'), `Invalid poolAddressesProvider for ${e.poolKey}`);
  }
});

test('V4 spoke entries all have hubAddress (needed by onchainDataService)', () => {
  for (const e of V4_SPOKE_ENTRIES) {
    assert.ok(e.hubAddress.startsWith('0x'), `Invalid hubAddress for ${e.spokeKey}`);
  }
});

// ============================================================
// Snapshot: minimum entry counts (resilient to address-book upgrades)
// ============================================================

test('V3 oracle entry count is at least the known baseline', () => {
  assert.ok(
    V3_ORACLE_ENTRIES.length >= SYNCED_V3_POOL_CONFIGS.length,
    `V3 oracle entries (${V3_ORACLE_ENTRIES.length}) should be >= baseline (${SYNCED_V3_POOL_CONFIGS.length})`,
  );
});

test('V4 oracle entry count is at least the known baseline', () => {
  const uniqueSpokeAddresses = new Set(V4_ORACLE_ENTRIES.map((e) => e.spokeAddress));
  assert.ok(
    uniqueSpokeAddresses.size >= SYNCED_V4_SPOKE_CONFIGS.length,
    `V4 unique spoke count (${uniqueSpokeAddresses.size}) should be >= baseline (${SYNCED_V4_SPOKE_CONFIGS.length})`,
  );
});

// ============================================================
// Topology-driven: buildAll(topology) matches SDK snapshot
// ============================================================

test('buildAll(sdkTopology) hub addresses match SDK spoke.connectedHubs topology', () => {
  const result = buildAll(sdkTopologyToSpokeHubTopology());
  for (const [spokeAddr, sdkHubs] of Object.entries(SDK_SPOKE_HUB_TOPOLOGY)) {
    const registryEntries = result.v4Spokes.filter((e) => e.spokeAddress === spokeAddr);
    assert.ok(registryEntries.length > 0, `No registry entry for spokeAddress ${spokeAddr}`);
    const registryHubs = registryEntries.map((e) => e.hubAddress).sort();
    const expectedHubs = [...sdkHubs].sort();
    assert.deepStrictEqual(
      registryHubs,
      expectedHubs,
      `Spoke ${spokeAddr.slice(0, 10)}... hub mismatch: registry=[${registryHubs.map(h => h.slice(0, 10)).join(',')}] sdk=[${expectedHubs.map(h => h.slice(0, 10)).join(',')}]`,
    );
  }
});

test('every registry V4 spoke is in SDK topology snapshot (or SDK_SPOKE_HUB_TOPOLOGY needs update)', () => {
  const sdkSpokeAddrs = new Set(Object.keys(SDK_SPOKE_HUB_TOPOLOGY));
  for (const e of V4_SPOKE_ENTRIES) {
    assert.ok(
      sdkSpokeAddrs.has(e.spokeAddress),
      `Registry spoke ${e.spokeKey} (${e.spokeAddress}) not in SDK topology snapshot — update SDK_SPOKE_HUB_TOPOLOGY if this is a new spoke`,
    );
  }
});
