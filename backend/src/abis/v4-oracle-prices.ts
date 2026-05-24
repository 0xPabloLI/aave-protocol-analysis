/**
 * V4 Oracle extension method not available in @aave-dao/aave-address-book.
 * address-book's IAaveOracleV4_ABI has only: getReserveSource
 * This file adds: getReservesPrices (batch price fetch for V4 spokes)
 */
export const V4_ORACLE_PRICES_ABI = [
  {
    inputs: [{ internalType: 'uint256[]', name: 'reserveIds', type: 'uint256[]' }],
    name: 'getReservesPrices',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
