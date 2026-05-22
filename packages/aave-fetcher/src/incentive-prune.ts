import type {
  MeritAprEntry,
  MerklOpportunityGroup,
  MerklCampaignBreakdown,
  BrevisCampaignItem,
  BrevisCampaignBreakdown,
} from '@internal/aave-shared-contracts';

export function pruneMeritEntry(e: MeritAprEntry): MeritAprEntry {
  return {
    apr: e.apr,
    ...(e.selfApr !== undefined ? { selfApr: e.selfApr } : {}),
    link: e.link,
    ...(e.name ? { name: e.name } : {}),
    ...(e.message ? { message: e.message } : {}),
    startDate: e.startDate,
    endDate: e.endDate,
    ...(e.lastRoundRewardUsd !== undefined ? { lastRoundRewardUsd: e.lastRoundRewardUsd } : {}),
  };
}

function pruneMerklBreakdown(b: MerklCampaignBreakdown): MerklCampaignBreakdown {
  return {
    campaignApr: b.campaignApr,
    campaignStartedAt: b.campaignStartedAt,
    campaignEndedAt: b.campaignEndedAt,
    campaignId: b.campaignId,
    ...(b.whitelistOnly !== undefined ? { whitelistOnly: b.whitelistOnly } : {}),
    ...(b.pointsPerThousandUsd !== undefined ? { pointsPerThousandUsd: b.pointsPerThousandUsd } : {}),
    ...(b.campaignType ? {
      campaignType: b.campaignType,
      totalBudget: b.totalBudget,
      aprCap: b.aprCap,
      latestTvl: b.latestTvl,
      plannedDaily: b.plannedDaily,
    } : {}),
  };
}

export function pruneMerklGroup(g: MerklOpportunityGroup): MerklOpportunityGroup {
  return {
    link: g.link,
    ...(g.name ? { name: g.name } : {}),
    ...(g.message ? { message: g.message } : {}),
    ...(g.opportunityType ? { opportunityType: g.opportunityType } : {}),
    breakdowns: (g.breakdowns ?? []).map(pruneMerklBreakdown),
  };
}

function pruneBrevisBreakdown(b: BrevisCampaignBreakdown): BrevisCampaignBreakdown {
  return {
    campaignApr: b.campaignApr,
    campaignStartedAt: b.campaignStartedAt,
    campaignEndedAt: b.campaignEndedAt,
    ...(b.latestTvl !== undefined ? { latestTvl: b.latestTvl } : {}),
    ...(b.totalBudget !== undefined ? { totalBudget: b.totalBudget } : {}),
    ...(b.perUserRewardCapUsd !== undefined ? { perUserRewardCapUsd: b.perUserRewardCapUsd } : {}),
    ...(b.campaignId ? { campaignId: b.campaignId } : {}),
  };
}

export function pruneBrevisItem(g: BrevisCampaignItem): BrevisCampaignItem {
  return {
    link: g.link,
    ...(g.name ? { name: g.name } : {}),
    ...(g.message ? { message: g.message } : {}),
    breakdowns: (g.breakdowns ?? []).map(pruneBrevisBreakdown),
  };
}
