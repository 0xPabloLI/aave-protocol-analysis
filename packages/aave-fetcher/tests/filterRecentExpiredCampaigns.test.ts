import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterRecentExpiredCampaigns } from '../src/merkl-api.js';
import { filterRecentExpiredMeritCampaigns } from '../src/merit-api.js';
import { filterRecentExpiredBrevis } from '../src/brevis-api.js';
import type { MerklCampaignBreakdown, MeritCampaignGroup } from '@internal/aave-shared-contracts';

describe('filterRecentExpiredCampaigns (Merkl)', () => {
  it('5条DUTCH_AUCTION过期 → 仅保留endDate最大的1条', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const breakdowns: MerklCampaignBreakdown[] = Array.from({ length: 5 }, (_, i) => ({
      campaignApr: 0.01,
      campaignStartedAt: past(30 + i),
      campaignEndedAt: past(i + 1),
      campaignId: `expired-${i}`,
      campaignType: 'DUTCH_AUCTION' as const,
    }));
    const result = filterRecentExpiredCampaigns(breakdowns);
    assert.equal(result.length, 1);
    assert.equal(result[0].campaignId, 'expired-0');
  });

  it('活跃+过期混合 → 活跃全保留+每组1条最近过期', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
    const breakdowns: MerklCampaignBreakdown[] = [
      { campaignApr: 0.02, campaignStartedAt: past(30), campaignEndedAt: future(10), campaignId: 'active-1', campaignType: 'DUTCH_AUCTION' },
      { campaignApr: 0.01, campaignStartedAt: past(30), campaignEndedAt: future(5), campaignId: 'active-2', campaignType: 'DUTCH_AUCTION' },
      { campaignApr: 0.005, campaignStartedAt: past(30), campaignEndedAt: past(1), campaignId: 'expired-1', campaignType: 'DUTCH_AUCTION' },
      { campaignApr: 0.003, campaignStartedAt: past(30), campaignEndedAt: past(5), campaignId: 'expired-2', campaignType: 'DUTCH_AUCTION' },
      { campaignApr: 0.004, campaignStartedAt: past(30), campaignEndedAt: past(3), campaignId: 'expired-3', campaignType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' },
    ];
    const result = filterRecentExpiredCampaigns(breakdowns);
    assert.equal(result.filter(b => b.campaignId!.startsWith('active')).length, 2);
    assert.equal(result.filter(b => b.campaignId!.startsWith('expired')).length, 2);
    assert.ok(result.find(b => b.campaignId === 'expired-1'));
    assert.ok(result.find(b => b.campaignId === 'expired-3'));
  });

  it('无过期campaign → 原样返回', () => {
    const now = new Date();
    const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
    const breakdowns: MerklCampaignBreakdown[] = [
      { campaignApr: 0.02, campaignStartedAt: future(-30), campaignEndedAt: future(10), campaignId: 'active-1' },
    ];
    const result = filterRecentExpiredCampaigns(breakdowns);
    assert.equal(result.length, 1);
  });

  it('campaignType缺失 → 归为UNKNOWN分组', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const breakdowns: MerklCampaignBreakdown[] = [
      { campaignApr: 0.005, campaignStartedAt: past(30), campaignEndedAt: past(1), campaignId: 'expired-no-type-1' },
      { campaignApr: 0.003, campaignStartedAt: past(30), campaignEndedAt: past(5), campaignId: 'expired-no-type-2' },
    ];
    const result = filterRecentExpiredCampaigns(breakdowns);
    assert.equal(result.length, 1);
    assert.equal(result[0].campaignId, 'expired-no-type-1');
  });
});

describe('filterRecentExpiredMeritCampaigns', () => {
  it('3条过期meritSupply → 仅保留1条', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const groups: MeritCampaignGroup[] = [
      { link: 'a', breakdowns: [{ campaignApr: 0.01, campaignId: 'a-base', campaignStartedAt: past(30), campaignEndedAt: past(1) }] },
      { link: 'b', breakdowns: [{ campaignApr: 0.02, campaignId: 'b-base', campaignStartedAt: past(30), campaignEndedAt: past(3) }] },
      { link: 'c', breakdowns: [{ campaignApr: 0.03, campaignId: 'c-base', campaignStartedAt: past(30), campaignEndedAt: past(5) }] },
    ];
    const result = filterRecentExpiredMeritCampaigns(groups);
    assert.equal(result.length, 1);
    assert.equal(result[0].breakdowns[0].campaignEndedAt, past(1));
  });

  it('活跃+过期混合 → 活跃全保留+1条最近过期', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
    const groups: MeritCampaignGroup[] = [
      { link: 'a', breakdowns: [{ campaignApr: 0.02, campaignId: 'a-base', campaignStartedAt: past(30), campaignEndedAt: future(10) }] },
      { link: 'b', breakdowns: [{ campaignApr: 0.01, campaignId: 'b-base', campaignStartedAt: past(30), campaignEndedAt: past(1) }] },
      { link: 'c', breakdowns: [{ campaignApr: 0.03, campaignId: 'c-base', campaignStartedAt: past(30), campaignEndedAt: past(5) }] },
    ];
    const result = filterRecentExpiredMeritCampaigns(groups);
    assert.equal(result.length, 2);
    assert.ok(result.find(g => g.breakdowns[0].campaignEndedAt === future(10)));
    assert.ok(result.find(g => g.breakdowns[0].campaignEndedAt === past(1)));
  });

  it('无过期 → 原样返回', () => {
    const now = new Date();
    const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
    const groups: MeritCampaignGroup[] = [
      { link: 'a', breakdowns: [{ campaignApr: 0.02, campaignId: 'a-base', campaignStartedAt: future(-30), campaignEndedAt: future(10) }] },
    ];
    const result = filterRecentExpiredMeritCampaigns(groups);
    assert.equal(result.length, 1);
  });
});

describe('filterRecentExpiredBrevis', () => {
  it('2条过期brevis → 仅保留1条', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const items = [
      { link: 'a', breakdowns: [{ campaignApr: 0.01, campaignStartedAt: past(30), campaignEndedAt: past(1) }] },
      { link: 'b', breakdowns: [{ campaignApr: 0.02, campaignStartedAt: past(30), campaignEndedAt: past(5) }] },
    ];
    const result = filterRecentExpiredBrevis(items);
    assert.equal(result.length, 1);
    assert.equal(result[0].link, 'a');
  });

  it('无过期 → 原样返回', () => {
    const now = new Date();
    const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
    const items = [
      { link: 'a', breakdowns: [{ campaignApr: 0.01, campaignStartedAt: future(-30), campaignEndedAt: future(10) }] },
    ];
    const result = filterRecentExpiredBrevis(items);
    assert.equal(result.length, 1);
  });
});
