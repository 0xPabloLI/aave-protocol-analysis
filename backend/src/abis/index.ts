/**
 * ABI Bridge Layer — single entry point for all ABI consumption.
 *
 * Layer 1: Re-exported from @aave-dao/aave-address-book (upstream source of truth)
 * Layer 2: Re-exported from @internal/aave-rpc-infra (shared RPC infra)
 * Layer 3: Local supplements (methods not in either upstream)
 */

// ── Layer 1: Upstream (address-book) ───────────────────────
export { ISpokeV4_ABI } from '@aave-dao/aave-address-book/abis/ISpokeV4';
export { IAaveOracle_ABI } from '@aave-dao/aave-address-book/abis/IAaveOracle';
export { IPool_ABI } from '@aave-dao/aave-address-book/abis/IPool';

// ── Layer 2: Shared RPC infra ──────────────────────────────
export { V4_HUB_FULL_ABI } from '@internal/aave-rpc-infra';

// ── Layer 3: Local supplements ─────────────────────────────
export { V4_ORACLE_PRICES_ABI } from './v4-oracle-prices.js';
