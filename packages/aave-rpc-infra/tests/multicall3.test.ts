import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utils } from 'ethers';
import { executeMulticall3, MULTICALL3_ABI, MULTICALL3_ADDRESS } from '../src/index.js';

test('executeMulticall3 encodes aggregate3 and decodes returned results', async () => {
  const iface = new utils.Interface(MULTICALL3_ABI);
  const returnData = '0x1234';
  let observedCall: { to?: string; data?: string } | undefined;

  const provider = {
    call: async (call: { to?: string; data?: string }) => {
      observedCall = call;
      return iface.encodeFunctionResult('aggregate3', [123n, [{ success: true, returnData }]]);
    },
  };

  const result = await executeMulticall3(
    provider as any,
    [{ target: '0x0000000000000000000000000000000000000001', allowFailure: true, callData: '0xabcd' }],
    { timeoutMs: 1_000, label: 'test aggregate3' },
  );

  assert.equal(observedCall?.to, MULTICALL3_ADDRESS);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { success: true, returnData });
});
