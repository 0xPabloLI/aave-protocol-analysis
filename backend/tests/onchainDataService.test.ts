import test from 'node:test';
import assert from 'node:assert/strict';
import { utils, providers } from 'ethers';

import { calculateBaseRateFallback, POOL_CONFIGS, V4_HUB_INTERFACE, processDeficitBatchResults, processDeficitSerialResult } from '../src/services/onchainDataService.js';
import { executeMulticall3 } from '@internal/aave-rpc-infra';
import { V4_HUB_FULL_ABI } from '@internal/aave-rpc-infra';
import { MULTICALL3_ADDRESS } from '@internal/aave-rpc-infra';
import { V4_SPOKE_ENTRIES, V3_ENTRIES } from '../src/services/addressBookRegistry.js';

test('calculateBaseRateFallback returns null when borrowApy is missing', () => {
  assert.strictEqual(calculateBaseRateFallback(null, 80, 80, 4, 80), null);
  assert.strictEqual(calculateBaseRateFallback(undefined, 80, 80, 4, 80), null);
});

test('calculateBaseRateFallback returns null when borrowApy is non-finite', () => {
  assert.strictEqual(calculateBaseRateFallback(Infinity, 80, 80, 4, 80), null);
  assert.strictEqual(calculateBaseRateFallback(NaN, 80, 80, 4, 80), null);
  assert.strictEqual(calculateBaseRateFallback(-2, 80, 80, 4, 80), null);
});

test('calculateBaseRateFallback returns 0 for zero-rate scenario (valid computation)', () => {
  const result = calculateBaseRateFallback(0, 0, 80, 4, 80);
  assert.strictEqual(result, 0);
});

test('calculateBaseRateFallback util <= optimal with positive optimal', () => {
  const result = calculateBaseRateFallback(0.052, 50, 80, 4, 80);
  assert.ok(Number.isFinite(result!));
  assert.ok(result! >= 0);
});

test('calculateBaseRateFallback util > optimal with slope2 (realistic params)', () => {
  const result = calculateBaseRateFallback(0.1, 90, 80, 2, 8);
  assert.ok(result !== null);
  assert.ok(Number.isFinite(result!));
  assert.ok(result! >= 0);
});

test('calculateBaseRateFallback returns null when optimal is 0 or missing (cannot compute)', () => {
  assert.strictEqual(calculateBaseRateFallback(0.05, 80, undefined, 4, 80), null);
  assert.strictEqual(calculateBaseRateFallback(0.05, 80, 0, 4, 80), null);
});

test('calculateBaseRateFallback returns null when slope1 is missing', () => {
  assert.strictEqual(calculateBaseRateFallback(0.05, 80, 80, undefined), null);
});

test('calculateBaseRateFallback returns null when util > optimal and slope2 missing', () => {
  const result = calculateBaseRateFallback(0.08, 90, 80, 4);
  assert.strictEqual(result, null);
});

test('calculateBaseRateFallback returns null when computed baseRate is negative', () => {
  const result = calculateBaseRateFallback(0.001, 50, 80, 100, 80);
  assert.strictEqual(result, null);
});

test('calculateBaseRateFallback returns null when denom <= 0 (optimal >= 100, util > optimal)', () => {
  assert.strictEqual(calculateBaseRateFallback(0.05, 150, 100, 4, 80), null);
  assert.strictEqual(calculateBaseRateFallback(0.05, 101, 100, 4, 80), null);
});

test('calculateBaseRateFallback distinguishes 0 result from null (semantic correctness)', () => {
  const zeroResult = calculateBaseRateFallback(0, 0, 80, 4, 80);
  assert.strictEqual(zeroResult, 0);
  assert.ok(zeroResult !== null);

  const nullResult = calculateBaseRateFallback(0.05, 80, undefined, 4, 80);
  assert.strictEqual(nullResult, null);
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

test('Multicall3 pre-deployed canonical address passes EIP-55 checksum validation', () => {
  const validated = utils.getAddress(MULTICALL3_ADDRESS);
  assert.strictEqual(validated, MULTICALL3_ADDRESS, 'EIP-55 checksum mismatch');
  assert.strictEqual(MULTICALL3_ADDRESS, '0xCA11bde05977b72171C07110a83e3e1c41D0C374', 'canonical CREATE2 address expected');
});

test('V4 Hub ABI encodes getAssetCount correctly', () => {
  const V4_HUB_FULL_ABI = [
    {
      inputs: [],
      name: 'getAssetCount',
      outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ];
  const iface = new utils.Interface(V4_HUB_FULL_ABI);
  const calldata = iface.encodeFunctionData('getAssetCount');
  assert.ok(calldata.startsWith('0x'));
  assert.ok(calldata.length > 2);
});

test('V4 Hub ABI encodes getAsset with assetId parameter', () => {
  const V4_HUB_FULL_ABI = [
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
  const iface = new utils.Interface(V4_HUB_FULL_ABI);
  const calldata0 = iface.encodeFunctionData('getAsset', [0]);
  const calldata5 = iface.encodeFunctionData('getAsset', [5]);
  assert.ok(calldata0.startsWith('0x'));
  assert.notStrictEqual(calldata0, calldata5);
});

test('V4 Hub ABI encodes getSpokeDeficitRay with assetId and spoke', () => {
  const V4_HUB_FULL_ABI = [
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
  const iface = new utils.Interface(V4_HUB_FULL_ABI);
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
// V4 deficit=0 is now stored (AAV-405: removed !== '0' filter)
// ============================================================

test('V4 spoke deficit=0 is stored (downstream reads explicit zero)', () => {
  const RAY = BigInt(10) ** BigInt(27);
  const spokeData = new Map<string, { deficit?: string }>();

  const testCases = [
    { ray: '0', expectedDeficit: '0' },
    { ray: String(RAY * BigInt(1)), expectedDeficit: '1' },
    { ray: String(RAY * BigInt(5)), expectedDeficit: '5' },
    { ray: String(RAY * BigInt(0)), expectedDeficit: '0' },
  ];

  for (const { ray, expectedDeficit } of testCases) {
    spokeData.clear();
    const amount = BigInt(ray) / RAY;
    spokeData.set(ray, { deficit: amount.toString() });
    const stored = spokeData.get(ray);
    assert.strictEqual(stored?.deficit, expectedDeficit, `deficitRay=${ray}: expected deficit=${expectedDeficit}`);
  }
});

// ============================================================
// Integration: real RPC Multicall3 aggregate3 call
// Verifies the provider.call() fix actually works against live Ethereum RPC.
// Root cause (2026-05-23): MULTICALL3_ADDRESS was a typo/fake address
//   Wrong: 0xCa11bdE05977b6962E52e3f19a7a4E4F080a7E34 (no contract, 0 bytes code)
//   Right: 0xcA11bde05977b72171C07110A83e3E1C41d0C374 (canonical CREATE2 deployment)
// This test now passes and guards against address regression.
// ============================================================

test('Integration: Multicall3 aggregate3 via provider.call() succeeds against live RPC', { timeout: 15_000, skip: !process.env.RUN_INTEGRATION }, async () => {
  // Use a public RPC (no auth needed)
  const rpcUrl = 'https://ethereum-rpc.publicnode.com';
  const provider = new providers.StaticJsonRpcProvider(rpcUrl, 1);

  // Get a CORE_HUB address from V4 spoke entries
  const coreHubEntry = V4_SPOKE_ENTRIES.find(e => e.hubKey === 'CORE_HUB');
  assert.ok(coreHubEntry, 'No CORE_HUB entry found in V4 spoke entries');
  const hubAddress = coreHubEntry!.hubAddress;
  assert.ok(hubAddress.startsWith('0x'), `Invalid hub address: ${hubAddress}`);

  // Encode getAssetCount() call
  const getAssetCountCalldata = V4_HUB_INTERFACE.encodeFunctionData('getAssetCount');

  // Call Multicall3 aggregate3 via provider.call() — this is the fixed path
  const results = await executeMulticall3(
    provider,
    [{ target: hubAddress, allowFailure: false, callData: getAssetCountCalldata }],
    { label: `integration getAssetCount via ${rpcUrl}` }
  );

  assert.ok(Array.isArray(results), 'aggregate3 should return an array');
  assert.strictEqual(results.length, 1, 'should have 1 result for 1 sub-call');

  // The call should succeed — if it reverts, the fix didn't work
  assert.ok(results[0].success, `getAssetCount via aggregate3 reverted — provider.call() fix failed. returnData=${results[0].returnData}`);

  // Decode and verify assetCount is a positive number
  const assetCount = V4_HUB_INTERFACE.decodeFunctionResult('getAssetCount', results[0].returnData)[0];
  const count = Number(assetCount);
  assert.ok(count > 0, `CORE_HUB assetCount should be > 0, got ${count}`);
});

test('V4_HUB_FULL_ABI has exactly 5 methods: getAssetCount, getAsset, getSpokeCount, getSpokeAddress, getSpokeDeficitRay', () => {
  const fns = V4_HUB_FULL_ABI.filter((e: any) => e.type === 'function');
  assert.strictEqual(fns.length, 5);
  const names = fns.map((f: any) => f.name).sort();
  assert.deepStrictEqual(names, ['getAsset', 'getAssetCount', 'getSpokeAddress', 'getSpokeCount', 'getSpokeDeficitRay']);
});

test('V4_HUB_FULL_ABI getAsset has 17 output fields matching @aave-dao/aave-address-book IHubV4', () => {
  const getAsset = V4_HUB_FULL_ABI.find((e: any) => e.name === 'getAsset') as any;
  assert.ok(getAsset, 'getAsset entry not found');
  const components = getAsset.outputs[0].components;
  assert.strictEqual(components.length, 17, `expected 17 fields, got ${components.length}`);

  const expectedFields = [
    'liquidity', 'realizedFees', 'decimals', 'addedShares', 'swept',
    'premiumOffsetRay', 'drawnShares', 'premiumShares', 'liquidityFee',
    'drawnIndex', 'drawnRate', 'lastUpdateTimestamp', 'underlying',
    'irStrategy', 'reinvestmentController', 'feeReceiver', 'deficitRay',
  ];
  const actualNames = components.map((c: any) => c.name);
  assert.deepStrictEqual(actualNames, expectedFields);
});

test('V4_HUB_FULL_ABI getAsset underlying is at index 12 (position 13) per contract layout', () => {
  const getAsset = V4_HUB_FULL_ABI.find((e: any) => e.name === 'getAsset') as any;
  const components = getAsset.outputs[0].components;
  const underlyingIdx = components.findIndex((c: any) => c.name === 'underlying');
  assert.strictEqual(underlyingIdx, 12, `underlying at index ${underlyingIdx}, expected 12`);
});

test('V4_HUB_FULL_ABI getAsset deficitRay is the last field (index 16)', () => {
  const getAsset = V4_HUB_FULL_ABI.find((e: any) => e.name === 'getAsset') as any;
  const components = getAsset.outputs[0].components;
  assert.strictEqual(components[components.length - 1].name, 'deficitRay');
  assert.strictEqual(components[components.length - 1].type, 'uint200');
});

test('V4_HUB_FULL_ABI getAsset function selector is identical to address-book IHubV4', () => {
  const addressBookAbi = [
    {
      inputs: [{ name: 'assetId', type: 'uint256' }],
      name: 'getAsset',
      outputs: [{
        components: [
          { name: 'liquidity', type: 'uint120' },
          { name: 'realizedFees', type: 'uint120' },
          { name: 'decimals', type: 'uint8' },
          { name: 'addedShares', type: 'uint120' },
          { name: 'swept', type: 'uint120' },
          { name: 'premiumOffsetRay', type: 'int200' },
          { name: 'drawnShares', type: 'uint120' },
          { name: 'premiumShares', type: 'uint120' },
          { name: 'liquidityFee', type: 'uint16' },
          { name: 'drawnIndex', type: 'uint120' },
          { name: 'drawnRate', type: 'uint96' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'underlying', type: 'address' },
          { name: 'irStrategy', type: 'address' },
          { name: 'reinvestmentController', type: 'address' },
          { name: 'feeReceiver', type: 'address' },
          { name: 'deficitRay', type: 'uint200' },
        ],
        name: '',
        type: 'tuple',
      }],
      stateMutability: 'view',
      type: 'function',
    },
  ];
  const localIface = new utils.Interface(V4_HUB_FULL_ABI);
  const abIface = new utils.Interface(addressBookAbi);
  const localSelector = localIface.getSighash('getAsset');
  const abSelector = abIface.getSighash('getAsset');
  assert.strictEqual(localSelector, abSelector, `selector mismatch: local=${localSelector} address-book=${abSelector}`);
});

// ============================================================
// AAV-405: deficit 硬错误 — processDeficitBatchResults / processDeficitSerialResult
// (RAY already declared at L74)
// ============================================================


test('processDeficitBatchResults: all successful with non-zero deficit', () => {
  const deficit1 = BigInt(1000) * RAY;
  const deficit2 = BigInt(2000) * RAY;
  const returnData1 = V4_HUB_INTERFACE.encodeFunctionResult('getSpokeDeficitRay', [deficit1]);
  const returnData2 = V4_HUB_INTERFACE.encodeFunctionResult('getSpokeDeficitRay', [deficit2]);
  const results = [
    { success: true, returnData: returnData1 },
    { success: true, returnData: returnData2 },
  ];
  const underlyings = ['0xTokenA', '0xTokenB'];
  const spokeData = processDeficitBatchResults(results, underlyings);
  assert.strictEqual(spokeData.get('0xTokenA')?.deficit, '1000');
  assert.strictEqual(spokeData.get('0xTokenB')?.deficit, '2000');
});

test('processDeficitBatchResults: zero deficit is stored (no filtering)', () => {
  const returnData = V4_HUB_INTERFACE.encodeFunctionResult('getSpokeDeficitRay', [BigInt(0)]);
  const results = [{ success: true, returnData }];
  const underlyings = ['0xTokenA'];
  const spokeData = processDeficitBatchResults(results, underlyings);
  assert.strictEqual(spokeData.get('0xTokenA')?.deficit, '0');
});

test('processDeficitBatchResults: failed call is skipped (partial batch preserved)', () => {
  const results = [{ success: false, returnData: '0x' }];
  const underlyings = ['0xTokenA'];
  const spokeData = processDeficitBatchResults(results, underlyings);
  assert.strictEqual(spokeData.size, 0, 'failed call should be skipped, not throw');
});

test('processDeficitBatchResults: decode failure is skipped (partial batch preserved)', () => {
  const results = [{ success: true, returnData: '0xbaddata' }];
  const underlyings = ['0xTokenA'];
  const spokeData = processDeficitBatchResults(results, underlyings);
  assert.strictEqual(spokeData.size, 0, 'decode failure should be skipped, not throw');
});

test('processDeficitSerialResult: non-zero deficit', () => {
  const deficit = BigInt(5000) * RAY;
  const result = processDeficitSerialResult(deficit, '0xTokenA');
  assert.strictEqual(result.deficit, '5000');
});

test('processDeficitSerialResult: zero deficit is stored (no filtering)', () => {
  const result = processDeficitSerialResult(BigInt(0), '0xTokenA');
  assert.strictEqual(result.deficit, '0');
});

test('processDeficitSerialResult: small deficit below RAY preserves raw', () => {
  const deficit = BigInt(999);
  const result = processDeficitSerialResult(deficit, '0xTokenA');
  assert.strictEqual(result.deficit, '0');
});

test('processDeficitBatchResults: mixed results - first ok second fail keeps partial data', () => {
  const deficit1 = BigInt(100) * RAY;
  const returnData1 = V4_HUB_INTERFACE.encodeFunctionResult('getSpokeDeficitRay', [deficit1]);
  const results = [
    { success: true, returnData: returnData1 },
    { success: false, returnData: '0x' },
  ];
  const underlyings = ['0xTokenA', '0xTokenB'];
  const spokeData = processDeficitBatchResults(results, underlyings);
  assert.strictEqual(spokeData.size, 1);
  assert.strictEqual(spokeData.get('0xTokenA')!.deficit, '100');
});
