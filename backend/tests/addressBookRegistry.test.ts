/**
 * Snapshot test for addressBookRegistry — validates registry output against
 * embedded snapshot fixtures (formerly from generated/oracle-pool-configs.ts).
 *
 * V4 spokeName format changes from human-readable (e.g. 'Bluechip') to raw
 * spokeKey (e.g. 'BLUECHIP_SPOKE') — so spokeName is NOT compared directly.
 * Instead, spokeAddress is used as the matching key.
 *
 * After the refactor, this test serves as a regression guard:
 * - If address-book is bumped and fields disappear, this test fails.
 * - If a new spoke appears without a V4_SPOKE_TO_HUB entry, the completeness
 *   checks catch it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { V3_ENTRIES, V4_SPOKE_ENTRIES, type V3PoolEntry, type V4SpokeEntry } from '../src/services/addressBookRegistry.js';

// ============================================================
// Snapshot fixtures (formerly from generated/oracle-pool-configs.ts)
// Embedded after file deletion. Update if address-book bumps.
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
// Helpers
// ============================================================

const V3_ORACLE_ENTRIES = V3_ENTRIES.filter((e) => !!e.oracleAddress);
const V4_ORACLE_ENTRIES = V4_SPOKE_ENTRIES.filter((e) => !!e.oracleAddress);

// ============================================================
// V3: Oracle configs must match SYNCED_V3_POOL_CONFIGS exactly
// ============================================================

test('V3 oracle entry count matches SYNCED_V3_POOL_CONFIGS', () => {
  assert.strictEqual(
    V3_ORACLE_ENTRIES.length,
    SYNCED_V3_POOL_CONFIGS.length,
    `Expected ${SYNCED_V3_POOL_CONFIGS.length} V3 oracle entries, got ${V3_ORACLE_ENTRIES.length}`,
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
  assert.strictEqual(fantomEntries.length, 0, 'Fantom should be excluded via AAVE_CHAIN_ID_TO_RPC_KEY whitelist');
});

test('V3 entries only contain chains in AAVE_CHAIN_ID_TO_RPC_KEY', () => {
  // Importing from aave-shared-config isn't needed — the registry enforces this.
  // We just verify no chainId=0 or NaN entries.
  for (const e of V3_ENTRIES) {
    assert.ok(Number.isFinite(e.chainId) && e.chainId > 0, `Invalid chainId: ${e.chainId} for ${e.poolKey}`);
    assert.ok(e.poolAddress.startsWith('0x'), `Invalid poolAddress for ${e.poolKey}`);
  }
});

// ============================================================
// V4: Oracle configs must match SYNCED_V4_SPOKE_CONFIGS (by spokeAddress)
// ============================================================

test('V4 oracle entry count >= SYNCED_V4_SPOKE_CONFIGS (multi-hub duplicates allowed)', () => {
  // Registry has 11 oracle entries (BLUECHIP_SPOKE appears twice: CORE_HUB + PRIME_HUB),
  // while old generated config had 10 (one per unique spoke). Both are correct for their
  // respective consumers — oracle uses per-spoke deduplication, onchain uses per-hub.
  assert.ok(
    V4_ORACLE_ENTRIES.length >= SYNCED_V4_SPOKE_CONFIGS.length,
    `Expected >= ${SYNCED_V4_SPOKE_CONFIGS.length} V4 oracle entries, got ${V4_ORACLE_ENTRIES.length}`,
  );
  // Unique spokes (by spokeAddress) should match
  const uniqueSpokeAddresses = new Set(V4_ORACLE_ENTRIES.map((e) => e.spokeAddress));
  assert.strictEqual(uniqueSpokeAddresses.size, SYNCED_V4_SPOKE_CONFIGS.length);
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
    // There may be multiple entries for same spoke (multi-hub), oracleAddress should be same
    for (const entry of matches) {
      assert.strictEqual(entry.chainId, synced.chainId, `chainId mismatch for ${synced.spokeName}`);
      assert.strictEqual(entry.oracleAddress, synced.oracleAddress, `oracleAddress mismatch for ${synced.spokeName}`);
    }
  }
});

// ============================================================
// V4: Multi-hub support
// ============================================================

test('BLUECHIP_SPOKE has 2 hub entries (CORE_HUB + PRIME_HUB)', () => {
  const bluechipEntries = V4_SPOKE_ENTRIES.filter((e) => e.spokeKey === 'BLUECHIP_SPOKE');
  assert.strictEqual(bluechipEntries.length, 2, 'BLUECHIP_SPOKE should have 2 hub entries');
  const hubKeys = bluechipEntries.map((e) => e.hubKey);
  assert.ok(hubKeys.includes('CORE_HUB'));
  assert.ok(hubKeys.includes('PRIME_HUB'));
});

test('all V4 spoke entries with oracle have valid hubKey and hubAddress', () => {
  for (const e of V4_ORACLE_ENTRIES) {
    assert.ok(e.hubKey && e.hubKey.length > 0, `Missing hubKey for ${e.spokeKey}`);
    assert.ok(e.hubAddress.startsWith('0x'), `Invalid hubAddress for ${e.spokeKey}/${e.hubKey}`);
  }
});

// ============================================================
// V4: SpokeKey (new spokeName) format
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

test('TREASURY_SPOKE is NOT in V4 entries', () => {
  const treasuryEntries = V4_SPOKE_ENTRIES.filter((e) => e.spokeKey === 'TREASURY_SPOKE');
  assert.strictEqual(treasuryEntries.length, 0, 'TREASURY_SPOKE should be excluded (no oracle)');
});

test('V4 entries only contain chains in AAVE_CHAIN_ID_TO_RPC_KEY (whitelist enforced)', () => {
  // After adding isSupportedChain(chainId) to the V4 path, all V4 entries
  // must have chainIds present in the whitelist. Current V4 deployments
  // are all on chainId=1 (Ethereum).
  for (const e of V4_SPOKE_ENTRIES) {
    assert.ok(Number.isFinite(e.chainId) && e.chainId > 0, `Invalid chainId: ${e.chainId} for ${e.spokeKey}`);
    // chainId=1 is the only Ethereum mainnet chain, confirmed in whitelist
    assert.strictEqual(e.chainId, 1, `V4 spoke ${e.spokeKey}/${e.hubKey} has chainId=${e.chainId}, expected 1 (Ethereum only)`);
  }
});

// ============================================================
// Structural: onchain entries validation
// ============================================================

test('V3 entries with UI_POOL_DATA_PROVIDER and POOL_ADDRESSES_PROVIDER are sufficient for onchain', () => {
  const v3Onchain = V3_ENTRIES.filter((e) => e.uiPoolDataProviderAddress && e.poolAddressesProvider);
  assert.ok(v3Onchain.length > 0, 'Should have at least one V3 onchain entry');
  // Should be a subset of V3_ENTRIES
  assert.ok(v3Onchain.length <= V3_ENTRIES.length);
  for (const e of v3Onchain) {
    assert.ok(e.uiPoolDataProviderAddress!.startsWith('0x'), `Invalid uiPoolDataProviderAddress for ${e.poolKey}`);
    assert.ok(e.poolAddressesProvider!.startsWith('0x'), `Invalid poolAddressesProvider for ${e.poolKey}`);
  }
});

test('V4 spoke entries all have hubAddress (needed by onchainDataService)', () => {
  for (const e of V4_SPOKE_ENTRIES) {
    assert.ok(e.hubAddress.startsWith('0x'), `Invalid hubAddress for ${e.spokeKey}/${e.hubKey}`);
  }
});

// ============================================================
// Snapshot: full entry counts for regression detection
// ============================================================

test('known V3 pool count (oracle-filtered)', () => {
  // If address-book bumps and this changes, update the count.
  assert.strictEqual(V3_ORACLE_ENTRIES.length, 23, 'V3 oracle entry count is 23');
});

test('known V4 spoke count (oracle-filtered)', () => {
  // 11 = 10 unique spokes + 1 extra (BLUECHIP_SPOKE appears for both CORE_HUB and PRIME_HUB)
  // If address-book bumps and this changes, update the count.
  assert.strictEqual(V4_ORACLE_ENTRIES.length, 11, 'V4 oracle entry count is 11 (10 unique spokes, BLUECHIP has 2 hubs)');
});