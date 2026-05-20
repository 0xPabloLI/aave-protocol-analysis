import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterRecentExpiredCampaigns } from '../src/merkl-api.js';
import { filterRecentExpiredMerit } from '../src/merit-api.js';
import { filterRecentExpiredBrevis } from '../src/brevis-api.js';
import type { MerklCampaignBreakdown } from '@internal/aave-shared-contracts';

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

describe('filterRecentExpiredMerit', () => {
  it('3条过期meritSupply → 仅保留1条', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const entries = [
      { apr: 0.01, link: 'a', startDate: past(30), endDate: past(1) },
      { apr: 0.02, link: 'b', startDate: past(30), endDate: past(3) },
      { apr: 0.03, link: 'c', startDate: past(30), endDate: past(5) },
    ];
    const result = filterRecentExpiredMerit(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0].endDate, past(1));
  });

  it('活跃+过期混合 → 活跃全保留+1条最近过期', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
    const entries = [
      { apr: 0.02, link: 'a', startDate: past(30), endDate: future(10) },
      { apr: 0.01, link: 'b', startDate: past(30), endDate: past(1) },
      { apr: 0.03, link: 'c', startDate: past(30), endDate: past(5) },
    ];
    const result = filterRecentExpiredMerit(entries);
    assert.equal(result.length, 2);
    assert.ok(result.find(e => e.endDate === future(10)));
    assert.ok(result.find(e => e.endDate === past(1)));
  });

  it('无过期 → 原样返回', () => {
    const now = new Date();
    const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
    const entries = [
      { apr: 0.02, link: 'a', startDate: future(-30), endDate: future(10) },
    ];
    const result = filterRecentExpiredMerit(entries);
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
