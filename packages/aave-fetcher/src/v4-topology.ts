import type { SpokeHubTopology } from '@internal/aave-shared-contracts';
import { topologySortKey } from '@internal/aave-shared-contracts';

export interface V4SdkReserveForTopology {
  spoke: {
    address: string;
    chain: { id: number };
    connectedHubs: {
      hub: { address: string };
    }[];
  };
}

export function extractSpokeHubTopology(reserves: V4SdkReserveForTopology[]): SpokeHubTopology {
  const seen = new Set<string>();
  const topology: SpokeHubTopology = [];

  for (const reserve of reserves) {
    const spokeAddress = reserve.spoke.address.toLowerCase();
    const chainId = reserve.spoke.chain.id;

    for (const connected of reserve.spoke.connectedHubs) {
      const hubAddress = connected.hub.address.toLowerCase();
      const key = topologySortKey(chainId, spokeAddress, hubAddress);
      if (seen.has(key)) continue;
      seen.add(key);
      topology.push({ chainId, spokeAddress, hubAddress });
    }
  }

  return topology;
}
