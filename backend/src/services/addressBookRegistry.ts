/**
 * Address Book Registry — single-source-of-truth runtime traversal of
 * @aave-dao/aave-address-book.
 *
 * Design decisions (do not regress):
 * - V3 whitelist source = AAVE_CHAIN_ID_TO_RPC_KEY. New chains only need
 *   a RPC entry in aave-shared-config to appear here — no double-write.
 *   Why: @aave-dao/aave-address-book exports have no TESTNET/IS_MAINNET
 *   field, so schema-based filtering is impossible. The only authoritative
 *   discriminator between "supported chain" and "testnet" is whether we
 *   have RPC URLs configured for that chainId.
 * - V4 also filters by AAVE_CHAIN_ID_TO_RPC_KEY (same whitelist as V3).
 *   When V4 expands to a new chain, add the chain's RPC config to
 *   aave-shared-config to enable it here.
 * - spokeKey IS spokeName (raw key, no _SPOKE suffix stripping).
 *   Consistent with onchainDataService's existing behavior.
 * - V4 spoke→hub is many-to-many (Record<string, string[]>).
 *   BLUECHIP_SPOKE → [CORE_HUB, PRIME_HUB]. Each (spoke, hub) combo
 *   produces a separate V4SpokeEntry.
 * - This is the ONLY authoritative narrowing layer for address-book.
 *   Consumers MUST NOT re-filter these entries.
 * - Per-entry traversal failures are caught and skipped. Module import
 *   failures propagate (same as pre-refactor behavior — consumers also
 *   imported @aave-dao/aave-address-book directly).
 */

import * as AaveAddressBook from '@aave-dao/aave-address-book';
import { AAVE_CHAIN_ID_TO_RPC_KEY } from '@internal/aave-shared-config';

// ============================================================
// V3 Types
// ============================================================

export interface V3PoolEntry {
  poolKey: string;                        // e.g. AaveV3Ethereum
  chainId: number;
  poolAddress: string;                    // lowercased
  oracleAddress?: string;                 // missing → not in oracle list
  uiPoolDataProviderAddress?: string;     // missing → not in onchain list
  poolAddressesProvider?: string;
}

// ============================================================
// V3 Whitelist: chains with configured RPC URLs
// ============================================================

const isSupportedChain = (chainId: number): boolean =>
  Object.prototype.hasOwnProperty.call(AAVE_CHAIN_ID_TO_RPC_KEY, chainId);

// ============================================================
// V4 Types
// ============================================================

export interface V4SpokeEntry {
  spokeKey: string;                       // raw key e.g. MAIN_SPOKE — also serves as spokeName
  chainId: number;
  spokeAddress: string;                   // lowercased
  hubKey: string;                         // e.g. CORE_HUB
  hubAddress: string;                     // lowercased
  oracleAddress?: string;                 // from SPOKES[`${spokeKey}_ORACLE`]
}

// ============================================================
// V4: Spoke-to-Hub mapping (many-to-many)
// ============================================================

const V4_SPOKE_TO_HUB: Record<string, string[]> = {
  MAIN_SPOKE: ['CORE_HUB'],
  BLUECHIP_SPOKE: ['CORE_HUB', 'PRIME_HUB'],
  LIDO_ESPOKE: ['CORE_HUB'],
  ETHERFI_ESPOKE: ['CORE_HUB'],
  KELP_ESPOKE: ['CORE_HUB'],
  ETHENA_CORRELATED_SPOKE: ['PLUS_HUB'],
  ETHENA_ECOSYSTEM_SPOKE: ['CORE_HUB', 'PLUS_HUB'],
  FOREX_SPOKE: ['CORE_HUB'],
  GOLD_SPOKE: ['CORE_HUB'],
  LOMBARD_BTC_SPOKE: ['CORE_HUB'],
};

const V4_SKIP_SPOKES = new Set(['TREASURY_SPOKE']);

// ============================================================
// Build: single-pass traversal of AaveAddressBook
// ============================================================

function buildAll(): { v3: V3PoolEntry[]; v4Spokes: V4SpokeEntry[] } {
  const v3: V3PoolEntry[] = [];
  const v4Spokes: V4SpokeEntry[] = [];

  for (const [key, value] of Object.entries(AaveAddressBook)) {
    try {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const chainId = Number(v.CHAIN_ID);
      if (!Number.isFinite(chainId) || chainId <= 0) continue;

      if (key.startsWith('AaveV3')) {
        // --- V3: whitelist via AAVE_CHAIN_ID_TO_RPC_KEY ---
        if (!isSupportedChain(chainId)) continue;

        const poolAddress = typeof v.POOL === 'string' ? v.POOL.toLowerCase().trim() : '';
        if (!poolAddress) continue;

        v3.push({
          poolKey: key,
          chainId,
          poolAddress,
          oracleAddress: typeof v.ORACLE === 'string' ? v.ORACLE.toLowerCase() : undefined,
          uiPoolDataProviderAddress: typeof v.UI_POOL_DATA_PROVIDER === 'string' ? v.UI_POOL_DATA_PROVIDER : undefined,
          poolAddressesProvider: typeof v.POOL_ADDRESSES_PROVIDER === 'string' ? v.POOL_ADDRESSES_PROVIDER : undefined,
        });
      } else if (key.startsWith('AaveV4')) {
        // --- V4: whitelist via AAVE_CHAIN_ID_TO_RPC_KEY ---
        if (!isSupportedChain(chainId)) continue;

        // --- V4: iterate spokes, expand per-hub ---
        const hubs = v.HUBS as Record<string, string> | undefined;
        const spokes = v.SPOKES as Record<string, string> | undefined;
        if (!hubs || !spokes) continue;

        for (const [spokeKey, spokeAddr] of Object.entries(spokes)) {
          if (!spokeKey.endsWith('_SPOKE') && !spokeKey.endsWith('_ESPOKE')) continue;
          if (V4_SKIP_SPOKES.has(spokeKey)) continue;
          if (typeof spokeAddr !== 'string') continue;

          const hubKeys = V4_SPOKE_TO_HUB[spokeKey];
          if (!hubKeys || hubKeys.length === 0) continue;

          for (const hubKey of hubKeys) {
            const hubAddr = hubs[hubKey];
            if (typeof hubAddr !== 'string') continue;

            v4Spokes.push({
              spokeKey,
              chainId,
              spokeAddress: spokeAddr.toLowerCase().trim(),
              hubKey,
              hubAddress: hubAddr.toLowerCase(),
              oracleAddress: typeof spokes[`${spokeKey}_ORACLE`] === 'string'
                ? spokes[`${spokeKey}_ORACLE`].toLowerCase()
                : undefined,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[addressBookRegistry] Skipping ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { v3, v4Spokes };
}

const _all = buildAll();
export const V3_ENTRIES: readonly V3PoolEntry[] = _all.v3;
export const V4_SPOKE_ENTRIES: readonly V4SpokeEntry[] = _all.v4Spokes;