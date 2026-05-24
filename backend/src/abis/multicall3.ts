/**
 * Multicall3 is a pre-deployed contract on most EVM chains.
 * Not part of Aave address-book — maintained locally.
 */
export const MULTICALL3_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'target', type: 'address' },
          { internalType: 'bool', name: 'allowFailure', type: 'bool' },
          { internalType: 'bytes', name: 'callData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Call3[]', name: 'calls', type: 'tuple[]',
      },
    ],
    name: 'aggregate3',
    outputs: [
      { internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
      {
        components: [
          { internalType: 'bool', name: 'success', type: 'bool' },
          { internalType: 'bytes', name: 'returnData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Result[]', name: 'returnData', type: 'tuple[]',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export const MULTICALL3_ADDRESS = '0xCA11bde05977b72171C07110a83e3e1c41D0C374';
