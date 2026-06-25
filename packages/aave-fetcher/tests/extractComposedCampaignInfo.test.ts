import test from 'node:test';
import assert from 'node:assert/strict';

import { extractComposedCampaignInfo } from '../src/merkl-api.js';
import type { MerklOpportunity } from '../src/merkl-api.js';

function makeOpp(campaigns: any[]): MerklOpportunity {
  return { campaigns } as unknown as MerklOpportunity;
}

test('composedMultiplier: 1e9 integer string → human-readable float', () => {
  const opp = makeOpp([{
    params: {
      composedCampaignsCompute: 'min(1,2)',
      composedCampaigns: [
        { composedMultiplier: '1196000000', campaignType: 60 },
        { composedMultiplier: '1000000000', campaignType: 60 },
      ],
    },
  }]);
  const result = extractComposedCampaignInfo(opp);
  assert.ok(result.composedSubCampaigns);
  assert.equal(result.composedSubCampaigns!.length, 2);
  assert.equal(result.composedSubCampaigns![0].composedMultiplier, 1.196);
  assert.equal(result.composedSubCampaigns![1].composedMultiplier, 1.0);
});

test('composedMultiplier: 823000000 → 0.823 (cbETH borrow discount)', () => {
  const opp = makeOpp([{
    params: {
      composedCampaignsCompute: 'min(1,2)',
      composedCampaigns: [
        { composedMultiplier: '823000000', campaignType: 60 },
        { composedMultiplier: '1000000000', campaignType: 61 },
      ],
    },
  }]);
  const result = extractComposedCampaignInfo(opp);
  assert.ok(result.composedSubCampaigns);
  assert.equal(result.composedSubCampaigns![0].composedMultiplier, 0.823);
  assert.equal(result.composedSubCampaigns![1].composedMultiplier, 1.0);
});

test('composedMultiplier: numeric input (fallback) → divided by 1e9', () => {
  const opp = makeOpp([{
    params: {
      composedCampaignsCompute: '1-2',
      composedCampaigns: [
        { composedMultiplier: 1000000000, campaignType: 61 },
        { composedMultiplier: 1000000000, campaignType: 60 },
      ],
    },
  }]);
  const result = extractComposedCampaignInfo(opp);
  assert.ok(result.composedSubCampaigns);
  assert.equal(result.composedSubCampaigns![0].composedMultiplier, 1.0);
  assert.equal(result.composedSubCampaigns![1].composedMultiplier, 1.0);
});

test('composedMultiplier: missing → undefined', () => {
  const opp = makeOpp([{
    params: {
      composedCampaignsCompute: '1-2',
      composedCampaigns: [
        { campaignType: 61 },
        { campaignType: 60 },
      ],
    },
  }]);
  const result = extractComposedCampaignInfo(opp);
  assert.ok(result.composedSubCampaigns);
  assert.equal(result.composedSubCampaigns![0].composedMultiplier, undefined);
});

test('composedMultiplier: empty string → undefined (not 0)', () => {
  const opp = makeOpp([{
    params: {
      composedCampaignsCompute: '1-2',
      composedCampaigns: [
        { composedMultiplier: '', campaignType: 61 },
      ],
    },
  }]);
  const result = extractComposedCampaignInfo(opp);
  assert.ok(result.composedSubCampaigns);
  assert.equal(result.composedSubCampaigns![0].composedMultiplier, undefined);
});

test('composedCampaignsCompute extracted correctly', () => {
  const opp = makeOpp([{
    params: {
      composedCampaignsCompute: 'min(1,2)',
      composedCampaigns: [],
    },
  }]);
  const result = extractComposedCampaignInfo(opp);
  assert.equal(result.composedCampaignsCompute, 'min(1,2)');
});

test('no composedCampaigns → empty result', () => {
  const opp = makeOpp([{
    params: {
      composedCampaignsCompute: '1-2',
    },
  }]);
  const result = extractComposedCampaignInfo(opp);
  assert.ok(result.composedSubCampaigns);
  assert.equal(result.composedSubCampaigns!.length, 0);
});

test('no campaigns array → empty result', () => {
  const opp = makeOpp([]);
  const result = extractComposedCampaignInfo(opp);
  assert.equal(result.composedCampaignsCompute, undefined);
  assert.equal(result.composedSubCampaigns, undefined);
});
