/**
 * Hub contract extension methods not available in @aave-dao/aave-address-book.
 * address-book's IHubV4_ABI has: getAssetCount, getAsset, getSpokeCount, getSpokeAddress
 * This file adds: getSpokeDeficitRay
 */
export const HUB_EXTENSIONS_ABI = [
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
] as const;
