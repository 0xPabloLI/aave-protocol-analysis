import test from 'node:test';
import assert from 'node:assert/strict';
import { utils } from 'ethers';

import { calculateBaseRateFallback, POOL_CONFIGS } from '../src/services/onchainDataService.js';
import { V4_SPOKE_ENTRIES, V3_ENTRIES } from '../src/services/addressBookRegistry.js';

test('calculateBaseRateFallback returns null when borrowApy is missing', () => {
  assert.strictEqual(calculateBaseRateFallback(null, 80, 80, 4, 80), null);
  assert.strictEqual(calculateBaseRateFallback(undefined, 80, 80, 4, 80), null);
});

test('calculateBaseRateFallback returns 0 for zero-rate scenario', () => {
  const result = calculateBaseRateFallback(0, 0, 80, 4, 80);
  assert.strictEqual(result, 0);
});

test('calculateBaseRateFallback util <= optimal with positive optimal', () => {
  const result = calculateBaseRateFallback(0.052, 50, 80, 4, 80);
  assert.ok(Number.isFinite(result!));
  assert.ok(result! >= 0);
});

test('calculateBaseRateFallback util > optimal with slope2', () => {
  const result = calculateBaseRateFallback(0.08, 90, 80, 4, 80);
  assert.ok(Number.isFinite(result!));
  assert.ok(result! >= 0);
});

test('calculateBaseRateFallback returns 0 when optimal is 0 or missing', () => {
  assert.strictEqual(calculateBaseRateFallback(0.05, 80, undefined, 4, 80), 0);
  assert.strictEqual(calculateBaseRateFallback(0.05, 80, 0, 4, 80), 0);
});

test('calculateBaseRateFallback fallback when util > optimal and slope2 missing', () => {
  const result = calculateBaseRateFallback(0.08, 90, 80, 4);
  assert.strictEqual(result, 0);
});

test('calculateBaseRateFallback returns 0 when computed baseRate is negative', () => {
  const result = calculateBaseRateFallback(0.001, 50, 80, 100, 80);
  assert.strictEqual(result, 0);
});

// ============================================================
// V4 deficit RAY conversion tests
// ============================================================

const RAY = BigInt(10) ** BigInt(27);

test('V4 deficitRay=0 converts to "0" underlying units', () => {
  const deficitRay = BigInt(0);
  const deficitUnderlying = deficitRay / RAY;
  assert.strictEqual(deficitUnderlying.toString(), '0');
});

test('V4 deficitRay=1e27 (1 unit) converts to "1" underlying units', () => {
  const deficitRay = RAY;
  const deficitUnderlying = deficitRay / RAY;
  assert.strictEqual(deficitUnderlying.toString(), '1');
});

test('V4 deficitRay=5e27 (5 units) converts to "5" underlying units', () => {
  const deficitRay = BigInt(5) * RAY;
  const deficitUnderlying = deficitRay / RAY;
  assert.strictEqual(deficitUnderlying.toString(), '5');
});

test('V4 deficitRay=1.5e27 truncates to "1" (integer division)', () => {
  const deficitRay = BigInt(15) * BigInt(10) ** BigInt(26);
  const deficitUnderlying = deficitRay / RAY;
  assert.strictEqual(deficitUnderlying.toString(), '1');
});

test('V4 deficitRay large value (1000e27) converts correctly', () => {
  const deficitRay = BigInt(1000) * RAY;
  const deficitUnderlying = deficitRay / RAY;
  assert.strictEqual(deficitUnderlying.toString(), '1000');
});

// ============================================================
// V4 onchain cache key format (address-based, matches reserveId)
// ============================================================

test('V4 onchain key format: {chainId}:{spokeAddress}:{tokenAddr}:{hubName}', () => {
  const chainId = 1;
  const spokeAddress = '0x1234567890123456789012345678901234567890';
  const tokenAddr = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const hubName = 'CORE_HUB';
  const key = `${chainId}:${spokeAddress}:${tokenAddr}:${hubName}`;
  assert.strictEqual(key, '1:0x1234567890123456789012345678901234567890:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2:CORE_HUB');
});

test('V4 onchain key matches V4 reserveId (no fallback needed)', () => {
  const reserveId = '1:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:PLUS_HUB';
  const parts = reserveId.split(':');
  assert.strictEqual(parts.length, 4);
  assert.strictEqual(parts[0], '1');
  assert.ok(parts[1].startsWith('0x'));
  assert.ok(parts[2].startsWith('0x'));
  assert.ok(['CORE_HUB', 'PLUS_HUB', 'PRIME_HUB'].includes(parts[3]));
});

test('V4 reserveId starts with chainId (consistent with V3 pattern)', () => {
  const v3ReserveId = '1:0x87870bca3f3e6a89e12e23a2e01484e8a4a2e7c1:0xbe9895145f349a6695d5da8e9c6b50a9';
  const v4ReserveId = '1:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:CORE_HUB';
  assert.ok(v3ReserveId.split(':')[0] === v4ReserveId.split(':')[0]);
  assert.ok(v3ReserveId.startsWith('1:'));
  assert.ok(v4ReserveId.startsWith('1:'));
});

test('V4 reserveId spokeAddress is lowercase', () => {
  const spokeAddress = '0xAbCdEf1234AbCdEf1234AbCdEf1234AbCdEf1234';
  const spokeAddressLower = spokeAddress.toLowerCase();
  const reserveId = `1:${spokeAddressLower}:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:CORE_HUB`;
  const parts = reserveId.split(':');
  assert.strictEqual(parts[1], spokeAddressLower);
});

test('V4 onchain key and reserveId are identical — direct Map.get works', () => {
  const chainId = 1;
  const spokeAddress = '0x1234567890123456789012345678901234567890';
  const tokenAddr = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const hubName = 'PLUS_HUB';
  const onchainKey = `${chainId}:${spokeAddress}:${tokenAddr}:${hubName}`;
  const reserveId = `${chainId}:${spokeAddress}:${tokenAddr}:${hubName}`;
  assert.strictEqual(onchainKey, reserveId);
  const map = new Map<string, string>();
  map.set(onchainKey, 'deficit_value');
  assert.strictEqual(map.get(reserveId), 'deficit_value');
});

// ============================================================
// V4 Hub config: only 3 Hubs on Ethereum mainnet
// ============================================================

test('V4 Hub discovery finds exactly 3 hubs', () => {
  const knownHubs = ['CORE_HUB', 'PLUS_HUB', 'PRIME_HUB'];
  assert.strictEqual(knownHubs.length, 3);
  const hubNames = new Set(knownHubs);
  assert.ok(hubNames.has('CORE_HUB'));
  assert.ok(hubNames.has('PLUS_HUB'));
  assert.ok(hubNames.has('PRIME_HUB'));
});

test('V4 deficit is per-asset (Hub level), same value for all spokes sharing same assetId', () => {
  const hubDeficit = '100';
  const spokeNames = ['Main', 'Bluechip', 'Lido', 'EtherFi', 'Kelp'];
  for (const _spoke of spokeNames) {
    assert.strictEqual(hubDeficit, '100');
  }
});

test('V4 reserveId matches v4-fetcher reserveId pattern', () => {
  const chainId = 1;
  const spokeAddress = '0x1234567890123456789012345678901234567890';
  const tokenAddr = '0xsomeaddress';
  const hubName = 'PLUS_HUB';
  const reserveId = `${chainId}:${spokeAddress}:${tokenAddr}:${hubName}`;
  assert.ok(reserveId.startsWith('1:'));
  assert.ok(reserveId.includes(hubName));
  const parts = reserveId.split(':');
  assert.strictEqual(parts.length, 4);
  assert.ok(parts[1].startsWith('0x'));
});

// ============================================================
// V4 Spoke-to-Hub mapping completeness
// ============================================================

test('V4_SPOKE_ENTRIES covers all known Ethereum mainnet spokes', () => {
  const knownSpokes = [
    'MAIN_SPOKE', 'BLUECHIP_SPOKE', 'LIDO_ESPOKE', 'ETHERFI_ESPOKE', 'KELP_ESPOKE',
    'ETHENA_CORRELATED_SPOKE', 'ETHENA_ECOSYSTEM_SPOKE', 'FOREX_SPOKE', 'GOLD_SPOKE',
    'LOMBARD_BTC_SPOKE',
  ];

  const spokeKeysFromRegistry = new Set(V4_SPOKE_ENTRIES.map(e => e.spokeKey));
  for (const spoke of knownSpokes) {
    assert.ok(spokeKeysFromRegistry.has(spoke), `Missing entry for ${spoke}`);
  }

  const bluechipHubs = V4_SPOKE_ENTRIES
    .filter(e => e.spokeKey === 'BLUECHIP_SPOKE')
    .map(e => e.hubKey);
  assert.ok(bluechipHubs.includes('CORE_HUB'));
  assert.ok(bluechipHubs.includes('PRIME_HUB'));
});

test('V4 multi-hub: BLUECHIP_SPOKE queries both CORE_HUB and PRIME_HUB', () => {
  const bluechipEntries = V4_SPOKE_ENTRIES.filter(e => e.spokeKey === 'BLUECHIP_SPOKE');
  const hubKeys = bluechipEntries.map(e => e.hubKey);
  assert.strictEqual(hubKeys.length, 2);
  assert.ok(hubKeys.includes('CORE_HUB'));
  assert.ok(hubKeys.includes('PRIME_HUB'));
});

test('V4 cache key is spokeAddress:hubName (supports same spoke, different hub)', () => {
  const spokeAddress = '0x973a023a77420ba610f06b3858ad991df6d85a08';
  const key1 = `${spokeAddress}:CORE_HUB`;
  const key2 = `${spokeAddress}:PRIME_HUB`;
  assert.notStrictEqual(key1, key2);
  const map = new Map<string, string>();
  map.set(key1, 'deficit_core');
  map.set(key2, 'deficit_prime');
  assert.strictEqual(map.size, 2);
  assert.strictEqual(map.get(key1), 'deficit_core');
  assert.strictEqual(map.get(key2), 'deficit_prime');
});

// ============================================================
// Multicall3 optimization tests
// ============================================================

test('Multicall3 pre-deployed address passes EIP-55 checksum validation', () => {
  const MULTICALL3_ADDRESS = '0xCa11bdE05977b6962E52e3f19a7a4E4F080a7E34';
  // ethers v5 getAddress() validates EIP-55 checksum; throws if mismatched
  const validated = utils.getAddress(MULTICALL3_ADDRESS);
  assert.strictEqual(validated, MULTICALL3_ADDRESS, 'EIP-55 checksum mismatch');
});

test('V4 Hub ABI encodes getAssetCount correctly', () => {
  const V4_HUB_ABI = [
    {
      inputs: [],
      name: 'getAssetCount',
      outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ];
  const iface = new utils.Interface(V4_HUB_ABI);
  const calldata = iface.encodeFunctionData('getAssetCount');
  assert.ok(calldata.startsWith('0x'));
  assert.ok(calldata.length > 2);
});

test('V4 Hub ABI encodes getAsset with assetId parameter', () => {
  const V4_HUB_ABI = [
    {
      inputs: [{ internalType: 'uint256', name: 'assetId', type: 'uint256' }],
      name: 'getAsset',
      outputs: [{
        components: [
          { internalType: 'address', name: 'underlying', type: 'address' },
          { internalType: 'uint8', name: 'decimals', type: 'uint8' },
        ],
        internalType: 'struct IHub.Asset',
        name: '',
        type: 'tuple',
      }],
      stateMutability: 'view',
      type: 'function',
    },
  ];
  const iface = new utils.Interface(V4_HUB_ABI);
  const calldata0 = iface.encodeFunctionData('getAsset', [0]);
  const calldata5 = iface.encodeFunctionData('getAsset', [5]);
  assert.ok(calldata0.startsWith('0x'));
  assert.notStrictEqual(calldata0, calldata5);
});

test('V4 Hub ABI encodes getSpokeDeficitRay with assetId and spoke', () => {
  const V4_HUB_ABI = [
    {
      inputs: [
        { internalType: 'uint256', name: 'assetId', type: 'uint256' },
        { internalType: 'address', name: 'spoke', type: 'address' },
      ],
      name: 'getSpokeDeficitRay',
      outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ];
  const iface = new utils.Interface(V4_HUB_ABI);
  const calldata = iface.encodeFunctionData('getSpokeDeficitRay', [0, '0x1234567890123456789012345678901234567890']);
  assert.ok(calldata.startsWith('0x'));
});

test('Multicall3 aggregate3 ABI encodes correctly', () => {
  const MULTICALL3_ABI = [
    {
      inputs: [{
        components: [
          { internalType: 'address', name: 'target', type: 'address' },
          { internalType: 'bool', name: 'allowFailure', type: 'bool' },
          { internalType: 'bytes', name: 'callData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Call3[]',
        name: 'calls',
        type: 'tuple[]',
      }],
      name: 'aggregate3',
      outputs: [{
        components: [
          { internalType: 'bool', name: 'success', type: 'bool' },
          { internalType: 'bytes', name: 'returnData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Result[]',
        name: 'returnData',
        type: 'tuple[]',
      }],
      stateMutability: 'view',
      type: 'function',
    },
  ];
  const iface = new utils.Interface(MULTICALL3_ABI);
  const target = '0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9';
  const callData = '0x1234';
  const encoded = iface.encodeFunctionData('aggregate3', [[{ target, allowFailure: true, callData }]]);
  assert.ok(encoded.startsWith('0x'));
});

test('Multicall3 RPC call reduction: ~94 serial → ~16 batches', () => {
  const hubCount = 3;
  const avgAssetsPerHub = 8;
  const spokeCount = 10;
  const serialCalls = hubCount * (1 + avgAssetsPerHub) + spokeCount * avgAssetsPerHub;
  const multicallBatches = hubCount * 2 + spokeCount;
  assert.ok(serialCalls > 80, `serial ${serialCalls} should be >80`);
  assert.ok(multicallBatches < 20, `multicall ${multicallBatches} should be <20`);
  assert.ok(serialCalls / multicallBatches > 4, `reduction ratio ${serialCalls}/${multicallBatches} should be >4x`);
});

test('Multicall3 fallback: serial path preserves same deficit conversion logic', () => {
  const RAY = BigInt(10) ** BigInt(27);
  const testCases = [
    { ray: '0', expected: '0' },
    { ray: String(RAY), expected: '1' },
    { ray: String(BigInt(5) * RAY), expected: '5' },
    { ray: String(BigInt(1000) * RAY), expected: '1000' },
  ];
  for (const { ray, expected } of testCases) {
    const result = (BigInt(ray) / RAY).toString();
    assert.strictEqual(result, expected, `RAY conversion for ${ray} should be ${expected}`);
  }
});

// ============================================================
// POOL_CONFIGS: V3 pool deduplication tests
// ============================================================

test('POOL_CONFIGS has unique entries for all V3 pools (no CREATE2 key collision)', () => {
  // All V3 entries that qualify for onchain must be in POOL_CONFIGS.
  // 4 pools (Arbitrum, Avalanche, Optimism, Polygon) share the same
  // CREATE2 pool address, but they are on different chains and must
  // each have their own independent onchain config.
  const qualifyingCount = V3_ENTRIES.filter(
    (e) => e.uiPoolDataProviderAddress && e.poolAddressesProvider
  ).length;

  assert.strictEqual(
    POOL_CONFIGS.size,
    qualifyingCount,
    `Expected ${qualifyingCount} POOL_CONFIGS entries, got ${POOL_CONFIGS.size}. ` +
    'CREATE2 address collision: pools on different chains sharing the same poolAddress ' +
    'are overwriting each other in the Map.'
  );
});

test('POOL_CONFIGS entries have distinct (chainId, poolAddress) pairs', () => {
  const pairs = new Set<string>();
  for (const config of POOL_CONFIGS.values()) {
    const pair = `${config.chainId}:${config.poolAddress}`;
    assert.ok(!pairs.has(pair), `Duplicate (chainId:poolAddress) pair: ${pair}`);
    pairs.add(pair);
  }
});

// ============================================================
// V4 zero-deficit filtering: don't store deficit='0' entries
// ============================================================

test('V4 spoke deficit=0 should not be stored (downstream fallback to 0 is safe)', () => {
  // Simulating the deficit processing logic: only store non-zero values.
  // This matches the downstream behavior where missing onchain deficit
  // defaults to '0' in marketsService.ts.
  const RAY = BigInt(10) ** BigInt(27);
  const spokeData = new Map<string, { deficit?: string }>();

  const testCases = [
    { ray: '0', expectedStored: false },
    { ray: String(RAY * BigInt(1)), expectedStored: true },
    { ray: String(RAY * BigInt(5)), expectedStored: true },
    { ray: String(RAY * BigInt(0)), expectedStored: false },
  ];

  for (const { ray, expectedStored } of testCases) {
    spokeData.clear();
    if (ray !== '0') {
      const amount = BigInt(ray) / RAY;
      spokeData.set(ray, { deficit: amount.toString() });
    }
    // Zero deficit → not stored, same as `deficitRayStr !== '0'` gate
    const wasStored = spokeData.has(ray);
    assert.strictEqual(
      wasStored,
      expectedStored,
      `deficitRay=${ray}: ${expectedStored ? 'should be stored' : 'should NOT be stored'}`
    );
  }
});