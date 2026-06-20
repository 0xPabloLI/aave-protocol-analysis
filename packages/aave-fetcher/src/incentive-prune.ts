import type {
  MeritCampaignGroup,
  MeritCampaignBreakdown,
  MerklOpportunityGroup,
  MerklCampaignBreakdown,
  BrevisCampaignItem,
  BrevisCampaignBreakdown,
} from '@internal/aave-shared-contracts';

function pruneMeritCampaignBreakdown(b: MeritCampaignBreakdown): MeritCampaignBreakdown {
  return {
    campaignApr: b.campaignApr,
    campaignStartedAt: b.campaignStartedAt,
    campaignEndedAt: b.campaignEndedAt,
    campaignId: b.campaignId,
    ...(b.campaignType ? { campaignType: b.campaignType } : {}),
    ...(b.positionCap !== undefined ? { positionCap: b.positionCap } : {}),
    ...(b.message ? { message: b.message } : {}),
    ...(b.aprCap !== undefined ? { aprCap: b.aprCap } : {}),
    ...(b.rewardTokenSymbol ? { rewardTokenSymbol: b.rewardTokenSymbol } : {}),
    ...(b.totalBudget !== undefined ? { totalBudget: b.totalBudget } : {}),
    ...(b.latestTvl !== undefined ? { latestTvl: b.latestTvl } : {}),
  };
}

export function pruneMeritCampaignGroup(g: MeritCampaignGroup): MeritCampaignGroup {
  return {
    link: g.link,
    ...(g.name ? { name: g.name } : {}),
    ...(g.message ? { message: g.message } : {}),
    breakdowns: (g.breakdowns ?? []).map(pruneMeritCampaignBreakdown),
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
    ...(b.rewardTokenSymbol ? { rewardTokenSymbol: b.rewardTokenSymbol } : {}),
    ...(b.rewardTokenIconUrl ? { rewardTokenIconUrl: b.rewardTokenIconUrl } : {}),
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
    ...(g.netPositionConstraint !== undefined ? { netPositionConstraint: g.netPositionConstraint } : {}),
    breakdowns: (g.breakdowns ?? []).map(pruneMerklBreakdown),
  };
}

function pruneBrevisBreakdown(b: BrevisCampaignBreakdown): BrevisCampaignBreakdown {
  return {
    campaignApr: b.campaignApr,
    campaignStartedAt: b.campaignStartedAt,
    campaignEndedAt: b.campaignEndedAt,
    campaignId: b.campaignId,
    ...(b.campaignType ? { campaignType: b.campaignType } : {}),
    ...(b.aprCap !== undefined ? { aprCap: b.aprCap } : {}),
    ...(b.latestTvl !== undefined ? { latestTvl: b.latestTvl } : {}),
    ...(b.totalBudget !== undefined ? { totalBudget: b.totalBudget } : {}),
    ...(b.positionCap !== undefined ? { positionCap: b.positionCap } : {}),
    ...(b.rewardTokenSymbol ? { rewardTokenSymbol: b.rewardTokenSymbol } : {}),
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
