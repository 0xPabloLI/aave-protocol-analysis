import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterRecentExpiredCampaigns } from '../src/merkl-api.js';
import { filterRecentExpiredMeritCampaigns } from '../src/merit-api.js';
import { filterRecentExpiredBrevis } from '../src/brevis-api.js';
import type { MerklCampaignBreakdown, MeritCampaignGroup } from '@internal/aave-shared-contracts';

describe('filterRecentExpiredCampaigns (Merkl)', () => {
  it('5条同rewardTokenSymbol的DUTCH_AUCTION过期 → 仅保留endDate最大的1条', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const breakdowns: MerklCampaignBreakdown[] = Array.from({ length: 5 }, (_, i) => ({
      campaignApr: 0.01,
      campaignStartedAt: past(30 + i),
      campaignEndedAt: past(i + 1),
      campaignId: `0xexpired${i}a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6`,
      campaignType: 'DUTCH_AUCTION' as const,
      rewardTokenSymbol: 'WXPL',
    }));
    const result = filterRecentExpiredCampaigns(breakdowns);
    assert.equal(result.length, 1);
    assert.equal(result[0].campaignId, '0xexpired0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6');
  });

  it('活跃+过期混合 → 活跃全保留+每组1条最近过期', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
    const breakdowns: MerklCampaignBreakdown[] = [
      { campaignApr: 0.02, campaignStartedAt: past(30), campaignEndedAt: future(10), campaignId: '0xactive1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', campaignType: 'DUTCH_AUCTION' },
      { campaignApr: 0.01, campaignStartedAt: past(30), campaignEndedAt: future(5), campaignId: '0xactive2a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', campaignType: 'DUTCH_AUCTION' },
      { campaignApr: 0.005, campaignStartedAt: past(30), campaignEndedAt: past(1), campaignId: '0xexpired1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', campaignType: 'DUTCH_AUCTION', rewardTokenSymbol: 'WXPL' },
      { campaignApr: 0.003, campaignStartedAt: past(30), campaignEndedAt: past(5), campaignId: '0xexpired2a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', campaignType: 'DUTCH_AUCTION', rewardTokenSymbol: 'WXPL' },
      { campaignApr: 0.004, campaignStartedAt: past(30), campaignEndedAt: past(3), campaignId: '0xexpired3a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', campaignType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE', rewardTokenSymbol: 'USDe' },
    ];
    const result = filterRecentExpiredCampaigns(breakdowns);
    assert.equal(result.filter(b => b.campaignId!.startsWith('0xactive')).length, 2);
    assert.equal(result.filter(b => b.campaignId!.startsWith('0xexpired')).length, 2);
    assert.ok(result.find(b => b.campaignId === '0xexpired1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6'));
    assert.ok(result.find(b => b.campaignId === '0xexpired3a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6'));
  });

  it('同campaignType不同rewardToken → 各保留1条', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const breakdowns: MerklCampaignBreakdown[] = [
      { campaignApr: 0.01, campaignStartedAt: past(30), campaignEndedAt: past(1), campaignId: '0xwxpl1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', campaignType: 'DUTCH_AUCTION', rewardTokenSymbol: 'WXPL' },
      { campaignApr: 0.02, campaignStartedAt: past(30), campaignEndedAt: past(5), campaignId: '0xwxpl2a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', campaignType: 'DUTCH_AUCTION', rewardTokenSymbol: 'WXPL' },
      { campaignApr: 0.03, campaignStartedAt: past(30), campaignEndedAt: past(2), campaignId: '0xagho1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', campaignType: 'DUTCH_AUCTION', rewardTokenSymbol: 'aGHO' },
      { campaignApr: 0.04, campaignStartedAt: past(30), campaignEndedAt: past(6), campaignId: '0xagho2a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6', campaignType: 'DUTCH_AUCTION', rewardTokenSymbol: 'aGHO' },
    ];
    const result = filterRecentExpiredCampaigns(breakdowns);
    assert.equal(result.length, 2);
    assert.ok(result.find(b => b.campaignId === '0xwxpl1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6'));
    assert.ok(result.find(b => b.campaignId === '0xagho1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6'));
  });

  it('无过期campaign → 原样返回', () => {
    const now = new Date();
    const future = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
    const breakdowns: MerklCampaignBreakdown[] = [
      { campaignApr: 0.02, campaignStartedAt: future(-30), campaignEndedAt: future(10), campaignId: '0xactive1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6' },
    ];
    const result = filterRecentExpiredCampaigns(breakdowns);
    assert.equal(result.length, 1);
  });

  it('rewardTokenSymbol缺失 → fallback到campaignType分组', () => {
    const now = new Date();
    const past = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    const breakdowns: MerklCampaignBreakdown[] = [
      { campaignApr: 0.005, campaignStartedAt: past(30), campaignEndedAt: past(1), campaignId: '0xexpirednotype1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2' },
      { campaignApr: 0.003, campaignStartedAt: past(30), campaignEndedAt: past(5), campaignId: '0xexpirednotype2a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2' },
    ];
    const result = filterRecentExpiredCampaigns(breakdowns);
    assert.equal(result.length, 1);
    assert.equal(result[0].campaignId, '0xexpirednotype1a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2');
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
