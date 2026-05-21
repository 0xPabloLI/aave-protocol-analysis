import type { MerklCampaignAccess } from '@internal/aave-shared-contracts';
import { logger } from '../logger.js';

let snapshot: MerklCampaignAccess[] | null = null;
let updatedAt: string | null = null;

export function setCampaignAccessSnapshot(data: MerklCampaignAccess[]): void {
  snapshot = data;
  updatedAt = new Date().toISOString();
  logger.info(`📋 Campaign access snapshot updated: ${data.length} campaigns with whitelist/blacklist`);
}

export function getCampaignAccessSnapshot(): {
  campaigns: Record<string, { chainId: number; whitelist: string[]; blacklist: string[] }>;
  updatedAt: string;
} | null {
  if (!snapshot || !updatedAt) return null;
  const campaigns: Record<string, { chainId: number; whitelist: string[]; blacklist: string[] }> = {};
  for (const entry of snapshot) {
    campaigns[entry.campaignId] = {
      chainId: entry.chainId,
      whitelist: entry.whitelist,
      blacklist: entry.blacklist,
    };
  }
  return { campaigns, updatedAt };
}
