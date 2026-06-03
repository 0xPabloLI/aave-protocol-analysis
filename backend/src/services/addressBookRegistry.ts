/**
 * Address Book Registry — single-source-of-truth runtime traversal of
 * @aave-dao/aave-address-book.
 *
 * Design decisions (do not regress):
 * - V3 whitelist source = AAVE_CHAIN_ID_TO_RPC_KEY. New chains only need
 *   a RPC entry in aave-shared-config to appear here — no double-write.
 * - V4 also filters by AAVE_CHAIN_ID_TO_RPC_KEY (same whitelist as V3).
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
import { AAVE_CHAIN_ID_TO_RPC_KEY, V4_SKIP_SPOKES } from '@internal/aave-shared-config';
import type { SpokeHubTopology } from '@internal/aave-shared-contracts';

// ============================================================
// V3 Types
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
// V3 Whitelist: chains with configured RPC URLs
// ============================================================

const isSupportedChain = (chainId: number): boolean =>
  Object.prototype.hasOwnProperty.call(AAVE_CHAIN_ID_TO_RPC_KEY, chainId);

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
    const key = `${entry.chainId}:${entry.spokeAddress.toLowerCase()}`;
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
        if (!isSupportedChain(chainId)) continue;

        const spokes = v.SPOKES as Record<string, string> | undefined;
        if (!spokes) continue;

        for (const [spokeKey, spokeAddr] of Object.entries(spokes)) {
          if (!spokeKey.endsWith('_SPOKE') && !spokeKey.endsWith('_ESPOKE')) continue;
          if (V4_SKIP_SPOKES.includes(spokeKey)) continue;
          if (typeof spokeAddr !== 'string') continue;

          const spokeAddressLower = spokeAddr.toLowerCase().trim();
          const topoKey = `${chainId}:${spokeAddressLower}`;
          const hubAddresses = topologyBySpoke.get(topoKey);
          if (!hubAddresses || hubAddresses.length === 0) continue;

          const oracleAddress = typeof spokes[`${spokeKey}_ORACLE`] === 'string'
            ? spokes[`${spokeKey}_ORACLE`].toLowerCase()
            : undefined;

          for (const hubAddress of hubAddresses) {
            v4Spokes.push({
              spokeKey,
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
  return JSON.stringify(topology);
}

export function getCurrentTopologySignature(): string | null {
  return currentTopologySignature;
}

export function initAddressBookRegistry(topology: SpokeHubTopology): void {
  const result = buildAll(topology);
  V3_ENTRIES = result.v3;
  V4_SPOKE_ENTRIES = result.v4Spokes;
  currentTopologySignature = topologySignature(topology);
}

export const DEFAULT_TOPOLOGY: SpokeHubTopology = [
  { chainId: 1, spokeAddress: '0x94e7a5dcbe816e498b89ab752661904e2f56c485', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x973a023a77420ba610f06b3858ad991df6d85a08', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x973a023a77420ba610f06b3858ad991df6d85a08', hubAddress: '0x943827dca022d0f354a8a8c332da1e5eb9f9f931' },
  { chainId: 1, spokeAddress: '0xe1900480ac69f0b296841cd01cc37546d92f35cd', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0xbf10bdfe177de0336afd7fccf80a904e15386219', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x3131fe68c4722e726fe6b2819ed68e514395b9a4', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x58131e79531cab1d52301228d1f7b842f26b9649', hubAddress: '0x06002e9c4412cb7814a791ea3666d905871e536a' },
  { chainId: 1, spokeAddress: '0xba1b3d55d249692b669a164024a838309b7508af', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0xba1b3d55d249692b669a164024a838309b7508af', hubAddress: '0x06002e9c4412cb7814a791ea3666d905871e536a' },
  { chainId: 1, spokeAddress: '0xd8b93635b8c6d0ff98cbe90b5988e3f2d1cd9da1', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x65407b940966954b23dfa3caa5c0702bb42984dc', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  { chainId: 1, spokeAddress: '0x7ec68b5695e803e98a21a9a05d744f28b0a7753d', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
];

initAddressBookRegistry(DEFAULT_TOPOLOGY);
