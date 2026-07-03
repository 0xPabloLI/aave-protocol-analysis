/**
 * Address Book Registry — single-source-of-truth runtime traversal of
 * @aave-dao/aave-address-book.
 *
 * Design decisions (do not regress):
 * - All mainnet chains present in address-book are included. RPC availability
 *   is handled by ProviderPool.executeWithAutoRpc which auto-discovers RPCs
 *   from viem/chains + chainlist.org when no hardcoded URL exists.
 * - Testnet chains (name contains 'Sepolia' or 'Fuji') are excluded.
 * - spokeKey IS spokeName (raw key, no _SPOKE suffix stripping).
 * - V4 spoke→hub is topology-driven: buildAll(topology) is a pure function
 *   that joins address-book SPOKES with SpokeHubTopology. Many-to-many
 *   (e.g. BLUECHIP_SPOKE → CORE_HUB + PRIME_HUB). Each (spoke, hub) combo
 *   produces a separate V4SpokeEntry.
 * - This is the ONLY authoritative narrowing layer for address-book.
 *   Consumers MUST NOT re-filter these entries.
 * - Per-entry traversal failures are caught and skipped.
 */

import * as AaveAddressBook from '@aave-dao/aave-address-book';
import { DEFAULT_SPOKE_HUB_TOPOLOGY } from '@internal/aave-shared-config';
import type { SpokeHubTopology } from '@internal/aave-shared-contracts';
import { spokeKey, topologySortKey } from '@internal/aave-shared-contracts';

// ============================================================
// V3 Types
// ============================================================

// ============================================================
// Testnet filter: exclude known testnet chains by name
// ============================================================

const isTestnetKey = (key: string): boolean =>
  key.includes('Sepolia') || key.includes('Fuji');
// ============================================================

export interface V3PoolEntry {
  poolKey: string;
  chainId: number;
  poolAddress: string;
  oracleAddress?: string;
  uiPoolDataProviderAddress?: string;
  poolAddressesProvider?: string;
}

// ============================================================
// V4 Types
// ============================================================

export interface V4SpokeEntry {
  spokeKey: string;
  chainId: number;
  spokeAddress: string;
  hubAddress: string;
  oracleAddress?: string;
}

// ============================================================
// Build: single-pass traversal of AaveAddressBook
// ============================================================

export function buildAll(topology: SpokeHubTopology): { v3: V3PoolEntry[]; v4Spokes: V4SpokeEntry[] } {
  const v3: V3PoolEntry[] = [];
  const v4Spokes: V4SpokeEntry[] = [];

  const topologyBySpoke = new Map<string, string[]>();
  for (const entry of topology) {
    const key = spokeKey(entry.chainId, entry.spokeAddress);
    const existing = topologyBySpoke.get(key);
    if (existing) {
      existing.push(entry.hubAddress.toLowerCase());
    } else {
      topologyBySpoke.set(key, [entry.hubAddress.toLowerCase()]);
    }
  }

  for (const [key, value] of Object.entries(AaveAddressBook)) {
    try {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const chainId = Number(v.CHAIN_ID);
      if (!Number.isFinite(chainId) || chainId <= 0) continue;

      if (key.startsWith('AaveV3')) {
        if (isTestnetKey(key)) continue;

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
        if (isTestnetKey(key)) continue;

        const spokes = v.SPOKES as Record<string, string> | undefined;
        if (!spokes) continue;

        for (const [spokeName, spokeAddr] of Object.entries(spokes)) {
          if (!spokeName.endsWith('_SPOKE') && !spokeName.endsWith('_ESPOKE')) continue;
          if (typeof spokeAddr !== 'string') continue;

          const spokeAddressLower = spokeAddr.toLowerCase().trim();
          const topoCacheKey = spokeKey(chainId, spokeAddr);
          const hubAddresses = topologyBySpoke.get(topoCacheKey);
          if (!hubAddresses || hubAddresses.length === 0) continue;

          const oracleAddress = typeof spokes[`${spokeName}_ORACLE`] === 'string'
            ? spokes[`${spokeName}_ORACLE`].toLowerCase()
            : undefined;

          for (const hubAddress of hubAddresses) {
            v4Spokes.push({
              spokeKey: spokeName,
              chainId,
              spokeAddress: spokeAddressLower,
              hubAddress,
              oracleAddress,
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

// ============================================================
// Lazy init exports (downstream compatibility)
// ============================================================

export let V3_ENTRIES: readonly V3PoolEntry[] = [];
export let V4_SPOKE_ENTRIES: readonly V4SpokeEntry[] = [];

let currentTopologySignature: string | null = null;

export function topologySignature(topology: SpokeHubTopology): string {
  const sorted = [...topology].sort((a, b) => {
    const keyA = topologySortKey(a.chainId, a.spokeAddress, a.hubAddress);
    const keyB = topologySortKey(b.chainId, b.spokeAddress, b.hubAddress);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  return JSON.stringify(sorted);
}

export function getCurrentTopologySignature(): string | null {
  return currentTopologySignature;
}

/**
 * Rebuild V3_ENTRIES and V4_SPOKE_ENTRIES from the given topology.
 * Thread-safety: caller must ensure no concurrent reads of V3_ENTRIES /
 * V4_SPOKE_ENTRIES during this call. In the current cron-write / API-read-only
 * architecture, the cron handler is the sole writer, so this is safe.
 */
export function initAddressBookRegistry(topology: SpokeHubTopology): void {
  const result = buildAll(topology);
  V3_ENTRIES = result.v3;
  V4_SPOKE_ENTRIES = result.v4Spokes;
  currentTopologySignature = topologySignature(topology);
}

initAddressBookRegistry(DEFAULT_SPOKE_HUB_TOPOLOGY);
