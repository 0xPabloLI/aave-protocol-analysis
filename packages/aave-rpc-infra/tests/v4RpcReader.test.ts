import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utils } from 'ethers';
import {
  fetchV4ReservesViaRpc,
  ISpokeV4_ABI,
  V4_HUB_FULL_ABI,
  MULTICALL3_ABI,
  MULTICALL3_ADDRESS,
  type V4SpokeEntry,
} from '../src/index.js';

/**
 * Helper: build a fake provider that handles both direct contract calls
 * and Multicall3 aggregate3 batch calls by dispatching sub-calls internally.
 */
function buildFakeProvider(
  handlers: Array<{ address: string; iface: utils.Interface; results: Record<string, (args: any[]) => any[]> }>,
) {
  const multicallIface = new utils.Interface(MULTICALL3_ABI as any);

  async function dispatchCall(to: string, data: string): Promise<string> {
    const toLower = to.toLowerCase();

    // Multicall3 aggregate3
    if (toLower === MULTICALL3_ADDRESS.toLowerCase()) {
      const parsed = multicallIface.parseTransaction({ data });
      if (parsed.name === 'aggregate3') {
        const calls = parsed.args[0] as Array<{ target: string; allowFailure: boolean; callData: string }>;
        const results: Array<{ success: boolean; returnData: string }> = [];
        for (const call of calls) {
          try {
            const returnData = await dispatchCall(call.target, call.callData);
            results.push({ success: true, returnData });
          } catch {
            results.push({ success: false, returnData: '0x' });
          }
        }
        return multicallIface.encodeFunctionResult('aggregate3', [results]);
      }
    }

    // Direct contract call
    for (const handler of handlers) {
      if (toLower === handler.address.toLowerCase()) {
        const parsed = handler.iface.parseTransaction({ data });
        if (parsed && parsed.name && handler.results[parsed.name]) {
          const resultArgs = handler.results[parsed.name](parsed.args);
          return handler.iface.encodeFunctionResult(parsed.name, resultArgs);
        }
      }
    }

    throw new Error(`unexpected call to ${to} with data ${data.slice(0, 20)}…`);
  }

  return {
    call: async ({ to, data }: { to?: string; data?: string }) => {
      assert.ok(data, 'call data must be present');
      return dispatchCall(to!, data);
    },
  };
}

test('fetchV4ReservesViaRpc maps V4 Hub+Spoke data into RuntimeReserveData', async () => {
  const spokeAddress = '0x0000000000000000000000000000000000000a01';
  const hubAddress = '0x0000000000000000000000000000000000000b01';
  const underlying = '0x0000000000000000000000000000000000000c01';
  const spokeIface = new utils.Interface(ISpokeV4_ABI as any);
  const hubIface = new utils.Interface(V4_HUB_FULL_ABI as any);

  const provider = buildFakeProvider([
    {
      address: spokeAddress,
      iface: spokeIface,
      results: {
        getReserveCount: () => [1],
        getReserve: () => [[
          underlying,
          hubAddress,
          7,
          6,
          0,
          0,
          0,
        ]],
      },
    },
    {
      address: hubAddress,
      iface: hubIface,
      results: {
        getAsset: () => [[
          1_000_000n,
          0,
          6,
          3_000_000n,
          0,
          0,
          1_000_000n,
          0,
          1_000,
          1_000_000_000_000_000_000_000_000_000n,
          50_000_000_000_000_000_000_000_000n,
          0,
          underlying,
          '0x0000000000000000000000000000000000000d01',
          '0x0000000000000000000000000000000000000e01',
          '0x0000000000000000000000000000000000000f01',
          0,
        ]],
      },
    },
  ]);

  const entries: V4SpokeEntry[] = [{
    spokeName: 'BLUECHIP_SPOKE',
    chainId: 1,
    spokeAddress,
    hubName: 'CORE_HUB',
    hubAddress,
  }];

  const mockProvider = provider as any;
  const result = await fetchV4ReservesViaRpc({
    entries,
    providerPool: {
      getProvidersForChain: () => [{ rpcUrl: 'mock-rpc', provider: mockProvider }],
      reportProviderSuccess: () => undefined,
      reportProviderFailure: () => undefined,
      errorClassifier: () => 'retry_next_rpc' as const,
      executeWithAutoRpc: async (_chainId: number, execs: { primary: (p: any) => Promise<any> }) =>
        execs.primary(mockProvider),
    },
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.reserves.length, 1);
  assert.equal(result.reserves[0].reserveId, `1:${spokeAddress.toLowerCase()}:${underlying.toLowerCase()}:${hubAddress.toLowerCase()}`);
  assert.equal(result.reserves[0].marketName, 'AaveV4BLUECHIP_SPOKE');
  assert.equal(result.reserves[0].hubName, 'CORE_HUB');
  assert.equal(result.reserves[0].spokeName, 'BLUECHIP_SPOKE');
  assert.equal(result.reserves[0].tokenAddress, underlying.toLowerCase());
  assert.equal(result.reserves[0].decimals, 6);
  assert.equal(result.reserves[0].aTokenAddress, null);
  assert.equal(result.reserves[0].vTokenAddress, null);
});

test('fetchV4ReservesViaRpc returns partial results when one entry fails', async () => {
  const spokeA = '0x0000000000000000000000000000000000000a01';
  const hubA = '0x0000000000000000000000000000000000000b01';
  const underlying = '0x0000000000000000000000000000000000000c01';
  const spokeB = '0x0000000000000000000000000000000000000a02';
  const hubB = '0x0000000000000000000000000000000000000b02';
  const spokeIface = new utils.Interface(ISpokeV4_ABI as any);
  const hubIface = new utils.Interface(V4_HUB_FULL_ABI as any);

  const provider = buildFakeProvider([
    // Spoke A + Hub A: succeed
    {
      address: spokeA,
      iface: spokeIface,
      results: {
        getReserveCount: () => [1],
        getReserve: () => [[underlying, hubA, 7, 6, 0, 0, 0]],
      },
    },
    {
      address: hubA,
      iface: hubIface,
      results: {
        getAsset: () => [[
          1_000_000n, 0, 6, 3_000_000n, 0, 0, 1_000_000n, 0, 1_000,
          1_000_000_000_000_000_000_000_000n, 50_000_000_000_000_000_000_000_000n, 0,
          underlying, '0x0000000000000000000000000000000000000d01',
          '0x0000000000000000000000000000000000000e01',
          '0x0000000000000000000000000000000000000f01', 0,
        ]],
      },
    },
    // Spoke B + Hub B: throw (not in handlers → dispatchCall throws)
  ]);

  const entries: V4SpokeEntry[] = [
    { spokeName: 'BLUECHIP_SPOKE', chainId: 1, spokeAddress: spokeA, hubName: 'CORE_HUB', hubAddress: hubA },
    { spokeName: 'LIDO_ESPOKE', chainId: 1, spokeAddress: spokeB, hubName: 'CORE_HUB', hubAddress: hubB },
  ];

  const mockProvider2 = provider as any;
  const result = await fetchV4ReservesViaRpc({
    entries,
    providerPool: {
      getProvidersForChain: () => [{ rpcUrl: 'mock-rpc', provider: mockProvider2 }],
      reportProviderSuccess: () => undefined,
      reportProviderFailure: () => undefined,
      errorClassifier: () => 'retry_next_rpc' as const,
      executeWithAutoRpc: async (_chainId: number, execs: { primary: (p: any) => Promise<any> }) =>
        execs.primary(mockProvider2),
    },
  });

  assert.equal(result.reserves.length, 1, 'should have reserves from the successful entry');
  assert.equal(result.reserves[0].spokeName, 'BLUECHIP_SPOKE');
  assert.ok(result.errors.length > 0, 'should have errors from the failed entry');
});
