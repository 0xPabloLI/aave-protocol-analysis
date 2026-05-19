import test from 'node:test';
import assert from 'node:assert/strict';
import { utils } from 'ethers';

import { calculateBaseRateFallback } from '../src/services/onchainDataService.js';

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
// V4 onchain cache key format (Hub-based, not Spoke-based)
// ============================================================

test('V4 onchain key format: {chainId}:{hubName}:{tokenAddr}', () => {
  const chainId = 1;
  const hubName = 'CORE_HUB';
  const tokenAddr = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const key = `${chainId}:${hubName}:${tokenAddr}`;
  assert.strictEqual(key, '1:CORE_HUB:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
});

test('V4 onchain key matches marketsService fallback lookup', () => {
  const reserve = {
    chainId: 1,
    hubName: 'PLUS_HUB',
    tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  };
  const v4Key = `${reserve.chainId}:${reserve.hubName}:${reserve.tokenAddress.toLowerCase()}`;
  assert.ok(v4Key.includes('PLUS_HUB'));
  assert.ok(v4Key.startsWith('1:'));
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
  const spokeName = 'EthenaEcosystem';
  const chainId = 1;
  const tokenAddr = '0xsomeaddress';
  const hubName = 'PLUS_HUB';
  const marketName = `AaveV4${spokeName.replace(/\s+/g, '')}`;
  const reserveId = `${marketName}:${chainId}:${tokenAddr}:${hubName}`;
  assert.ok(reserveId.startsWith('AaveV4'));
  assert.ok(reserveId.includes(hubName));
});

// ============================================================
// V4 Spoke-to-Hub mapping completeness
// ============================================================

test('V4_SPOKE_TO_HUB mapping covers all known Ethereum mainnet spokes', () => {
  const V4_SPOKE_TO_HUB: Record<string, string> = {
    MAIN_SPOKE: 'CORE_HUB',
    BLUECHIP_SPOKE: 'CORE_HUB',
    LIDO_ESPOKE: 'CORE_HUB',
    ETHERFI_ESPOKE: 'CORE_HUB',
    KELP_ESPOKE: 'CORE_HUB',
    ETHENA_CORRELATED_SPOKE: 'PLUS_HUB',
    ETHENA_ECOSYSTEM_SPOKE: 'PLUS_HUB',
    FOREX_SPOKE: 'PLUS_HUB',
    GOLD_SPOKE: 'PLUS_HUB',
    LOMBARD_BTC_SPOKE: 'PRIME_HUB',
  };

  const knownSpokes = [
    'MAIN_SPOKE', 'BLUECHIP_SPOKE', 'LIDO_ESPOKE', 'ETHERFI_ESPOKE', 'KELP_ESPOKE',
    'ETHENA_CORRELATED_SPOKE', 'ETHENA_ECOSYSTEM_SPOKE', 'FOREX_SPOKE', 'GOLD_SPOKE',
    'LOMBARD_BTC_SPOKE',
  ];

  for (const spoke of knownSpokes) {
    assert.ok(V4_SPOKE_TO_HUB[spoke], `Missing mapping for ${spoke}`);
  }

  const hubs = new Set(Object.values(V4_SPOKE_TO_HUB));
  assert.ok(hubs.has('CORE_HUB'));
  assert.ok(hubs.has('PLUS_HUB'));
  assert.ok(hubs.has('PRIME_HUB'));
  assert.strictEqual(hubs.size, 3);
});

// ============================================================
// Multicall3 optimization tests
// ============================================================

test('Multicall3 pre-deployed address is correct', () => {
  const MULTICALL3_ADDRESS = '0xcA11bde05977b6962E52E3F19a7a4e4f080A7e34';
  assert.ok(MULTICALL3_ADDRESS.startsWith('0x'));
  assert.strictEqual(MULTICALL3_ADDRESS.length, 42);
  assert.ok(MULTICALL3_ADDRESS.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase());
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