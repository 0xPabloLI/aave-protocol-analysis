/**
 * ABI Bridge Layer — single entry point for all ABI consumption.
 *
 * Layer 1: Re-exported from @aave-dao/aave-address-book (upstream source of truth)
 * Layer 2: Local supplements (methods not in address-book)
 * Layer 3: Merged composites (e.g., V4_HUB_FULL_ABI = IHubV4 + hub-extensions)
 */

// ── Layer 1: Upstream ──────────────────────────────────────
export { IHubV4_ABI } from '@aave-dao/aave-address-book/abis/IHubV4';
export { ISpokeV4_ABI } from '@aave-dao/aave-address-book/abis/ISpokeV4';
export { IAaveOracle_ABI } from '@aave-dao/aave-address-book/abis/IAaveOracle';
export { IPool_ABI } from '@aave-dao/aave-address-book/abis/IPool';

// ── Layer 2: Local supplements ─────────────────────────────
export { HUB_EXTENSIONS_ABI } from './hub-extensions.js';
export { V4_ORACLE_PRICES_ABI } from './v4-oracle-prices.js';
export { MULTICALL3_ABI, MULTICALL3_ADDRESS } from './multicall3.js';

// ── Layer 3: Merged composites ─────────────────────────────
import { IHubV4_ABI } from '@aave-dao/aave-address-book/abis/IHubV4';
import { HUB_EXTENSIONS_ABI } from './hub-extensions.js';

/** Full V4 Hub ABI: address-book base + local extensions (getSpokeDeficitRay) */
export const V4_HUB_FULL_ABI = [...IHubV4_ABI, ...HUB_EXTENSIONS_ABI];
