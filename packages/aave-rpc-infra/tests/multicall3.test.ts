import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utils, providers, Contract } from 'ethers';
import { executeMulticall3, MULTICALL3_ABI, MULTICALL3_ADDRESS } from '../src/index.js';

const CANONICAL_MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

test('MULTICALL3_ADDRESS matches canonical mds1/multicall deployment', () => {
  assert.strictEqual(
    MULTICALL3_ADDRESS,
    CANONICAL_MC3,
    'must match https://github.com/mds1/multicall canonical address',
  );
});

test('MULTICALL3_ADDRESS is not any of the previously-known wrong addresses', () => {
  const wrongAddresses = [
    '0xCa11bdE05977b6962E52e3f19a7a4E4F080a7e34',
    '0xCA11bde05977b72171C07110a83e3e1c41D0C374',
    '0xcA11BDe05977b7215DA6A5100C9CD0849c8f7bE5',
  ];
  for (const wrong of wrongAddresses) {
    assert.notStrictEqual(MULTICALL3_ADDRESS, wrong, `must not be the previously-wrong address ${wrong}`);
  }
});

test('executeMulticall3 encodes aggregate3 and decodes returned results', async () => {
  const iface = new utils.Interface(MULTICALL3_ABI);
  const returnData = '0x1234';
  let observedCall: { to?: string; data?: string } | undefined;

  const provider = {
    call: async (call: { to?: string; data?: string }) => {
      observedCall = call;
      return iface.encodeFunctionResult('aggregate3', [[{ success: true, returnData }]]);
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

// ============================================================
// Integration: verify Multicall3 contract exists and aggregate3
// works on key chains. Set RUN_INTEGRATION=1 to enable.
// ============================================================

const AGG3_HUMAN_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
];
const CHAINS_TO_VERIFY: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  56: 'https://bsc.publicnode.com',
  100: 'https://gnosis-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  146: 'https://rpc.soniclabs.com',
  196: 'https://rpc.xlayer.tech',
  324: 'https://mainnet.era.zksync.io',
  1868: 'https://soneium.drpc.org',
  42220: 'https://celo.drpc.org',
  5000: 'https://rpc.mantle.xyz',
  4326: 'https://mainnet.megaeth.com/rpc',
  8453: 'https://base-rpc.publicnode.com',
  9745: 'https://rpc.plasma.to',
  1088: 'https://andromeda.metis.io/?owner=1088',
  57073: 'https://ink.drpc.org',
  59144: 'https://linea-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  43114: 'https://avalanche-c-chain-rpc.publicnode.com',
  534352: 'https://rpc.scroll.io',
  1666600000: 'https://api.harmony.one',
  81457: 'https://rpc.blast.io',
  // 11297108109 (Palm) skipped — no public RPC, requires Infura key
  204: 'https://opbnb-mainnet-rpc.bnbchain.org',
  // 810180 (zkLinkNova) skipped — Multicall3 not deployed on this chain
  169: 'https://pacific-rpc.manta.network/http',
  80094: 'https://rpc.berachain.com',
  // 2741 (Abstract) skipped — no public RPC, requires Alchemy key
  14: 'https://flare-api.flare.network/ext/C/rpc',
};

for (const [chainId, rpcUrl] of Object.entries(CHAINS_TO_VERIFY)) {
  test(`Integration: MC3 aggregate3 on chain ${chainId} (eth_getCode + call)`, { timeout: 15_000, skip: !process.env.RUN_INTEGRATION }, async () => {
    const provider = new providers.JsonRpcProvider(rpcUrl);
    const code = await provider.getCode(MULTICALL3_ADDRESS);
    assert.notStrictEqual(code, '0x', `Multicall3 must have bytecode on chain ${chainId}`);

    const mc3 = new Contract(MULTICALL3_ADDRESS, AGG3_HUMAN_ABI, provider);
    const bnIface = new utils.Interface(['function getBlockNumber() view returns (uint256)']);
    const callData = bnIface.encodeFunctionData('getBlockNumber');
    const result = await mc3.callStatic.aggregate3([{ target: MULTICALL3_ADDRESS, allowFailure: true, callData }]);
    assert.strictEqual(result[0].success, true, `aggregate3.getBlockNumber must succeed on chain ${chainId}`);
  });
}
