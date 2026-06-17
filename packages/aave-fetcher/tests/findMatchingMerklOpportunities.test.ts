import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findMatchingMerklOpportunities } from '../src/merkl-api.js';
import type { MerklOpportunityData } from '../src/merkl-api.js';

const v3SupplyOpp: MerklOpportunityData = {
  supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
  borrow: [],
  hold: [],
  marketName: 'AaveV3Ethereum',
  chainId: 1,
  protocolVersion: 'v3',
  opportunityType: 'AAVE_SUPPLY',
};

const v3BorrowOpp: MerklOpportunityData = {
  supply: [],
  borrow: [{ campaignApr: 0.03, campaignId: 'c2', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
  hold: [],
  marketName: 'AaveV3Ethereum',
  chainId: 1,
  protocolVersion: 'v3',
  opportunityType: 'AAVE_BORROW',
};

const v4HubSupplyOpp: MerklOpportunityData = {
  supply: [{ campaignApr: 0.07, campaignId: 'c3', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
  borrow: [],
  hold: [],
  marketName: 'AaveV4EthereumCore',
  chainId: 1,
  protocolVersion: 'v4',
  opportunityType: 'AAVE_V4_HUB_SUPPLY',
};

const v4SpokeSupplyOpp: MerklOpportunityData = {
  supply: [{ campaignApr: 0.06, campaignId: 'c4', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
  borrow: [],
  hold: [],
  marketName: 'AaveV4EthereumCore',
  chainId: 1,
  protocolVersion: 'v4',
  opportunityType: 'AAVE_V4_SPOKE_SUPPLY',
};

function buildMerklIndex(...opps: { key: string; opp: MerklOpportunityData }[]): Record<string, MerklOpportunityData[]> {
  const index: Record<string, MerklOpportunityData[]> = {};
  for (const { key, opp } of opps) {
    if (!index[key]) index[key] = [];
    index[key]!.push(opp);
  }
  return index;
}

describe('findMatchingMerklOpportunities — address-type-driven matching', () => {

  describe('V3 reserve: only queries aToken/vToken', () => {
    const merklData = buildMerklIndex(
      { key: '1-0xatoken', opp: v3SupplyOpp },
      { key: '1-0xvtoken', opp: v3BorrowOpp },
      { key: '1-0xunderlying', opp: v4HubSupplyOpp },
      { key: '1-0xspoke', opp: v4SpokeSupplyOpp },
    );

    it('matches V3 supply opp via aToken', () => {
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV3Ethereum', tokenAddress: '0xunderlying', aTokenAddress: '0xaToken', vTokenAddress: '0xvToken' },
        merklData,
      );
      assert.equal(result.length, 2);
      assert.ok(result.some(o => o.opportunityType === 'AAVE_SUPPLY'));
      assert.ok(result.some(o => o.opportunityType === 'AAVE_BORROW'));
    });

    it('does NOT match V4 HUB_SUPPLY opp via underlying token', () => {
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV3Ethereum', tokenAddress: '0xUnderlying', aTokenAddress: '0xaToken', vTokenAddress: '0xvToken' },
        merklData,
      );
      assert.ok(!result.some(o => o.opportunityType === 'AAVE_V4_HUB_SUPPLY'));
    });

    it('does NOT match V4 SPOKE_SUPPLY opp', () => {
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV3Ethereum', tokenAddress: '0xunderlying', aTokenAddress: '0xaToken', vTokenAddress: '0xvToken' },
        merklData,
      );
      assert.ok(!result.some(o => o.opportunityType === 'AAVE_V4_SPOKE_SUPPLY'));
    });

    it('returns empty when no aToken/vToken matches exist', () => {
      const emptyMerkl: Record<string, MerklOpportunityData[]> = {};
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV3Ethereum', tokenAddress: '0xunderlying', aTokenAddress: '0xaToken', vTokenAddress: '0xvToken' },
        emptyMerkl,
      );
      assert.equal(result.length, 0);
    });
  });

  describe('V4 reserve: only queries underlying + spokeAddress', () => {
    const merklData = buildMerklIndex(
      { key: '1-0xatoken', opp: v3SupplyOpp },
      { key: '1-0xvtoken', opp: v3BorrowOpp },
      { key: '1-0xunderlying', opp: v4HubSupplyOpp },
      { key: '1-0xspoke', opp: v4SpokeSupplyOpp },
    );

    it('matches V4 HUB_SUPPLY opp via underlying token', () => {
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV4EthereumCore', tokenAddress: '0xUnderlying', spokeAddress: '0xSpoke' },
        merklData,
      );
      assert.ok(result.some(o => o.opportunityType === 'AAVE_V4_HUB_SUPPLY'));
    });

    it('matches V4 SPOKE_SUPPLY opp via spokeAddress (AAV-908 fix)', () => {
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV4EthereumCore', tokenAddress: '0xunderlying', spokeAddress: '0xSpoke' },
        merklData,
      );
      assert.ok(result.some(o => o.opportunityType === 'AAVE_V4_SPOKE_SUPPLY'));
    });

    it('does NOT match V3 opps via aToken/vToken', () => {
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV4EthereumCore', tokenAddress: '0xunderlying', aTokenAddress: '0xaToken', vTokenAddress: '0xvToken', spokeAddress: '0xspoke' },
        merklData,
      );
      assert.ok(!result.some(o => o.protocolVersion === 'v3'));
    });

    it('returns empty when neither underlying nor spokeAddress matches', () => {
      const emptyMerkl: Record<string, MerklOpportunityData[]> = {};
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV4EthereumCore', tokenAddress: '0xunderlying', spokeAddress: '0xspoke' },
        emptyMerkl,
      );
      assert.equal(result.length, 0);
    });
  });

  describe('V3/V4 natural isolation — no post-filter needed', () => {
    const merklData = buildMerklIndex(
      { key: '1-0xusdt', opp: v4HubSupplyOpp },
      { key: '1-0xatoken', opp: v3SupplyOpp },
      { key: '1-0xspokeusdt', opp: v4SpokeSupplyOpp },
    );

    it('V3 reserve querying underlying=USDT does NOT get V4 HUB_SUPPLY', () => {
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV3Ethereum', tokenAddress: '0xUSDT', aTokenAddress: '0xaToken', vTokenAddress: '0xvToken' },
        merklData,
      );
      assert.ok(!result.some(o => o.opportunityType === 'AAVE_V4_HUB_SUPPLY'));
    });

    it('V4 reserve querying underlying=USDT gets V4 HUB_SUPPLY', () => {
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV4EthereumCore', tokenAddress: '0xusdt', spokeAddress: '0xspokeusdt' },
        merklData,
      );
      assert.ok(result.some(o => o.opportunityType === 'AAVE_V4_HUB_SUPPLY'));
    });
  });

  describe('protocolVersion inferred from match type', () => {
    it('matched opps have correct protocolVersion from index data', () => {
      const merklData = buildMerklIndex(
        { key: '1-0xatoken', opp: v3SupplyOpp },
        { key: '1-0xunderlying', opp: v4HubSupplyOpp },
      );

      const v3Result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV3Ethereum', tokenAddress: '0xunderlying', aTokenAddress: '0xaToken' },
        merklData,
      );
      assert.ok(v3Result.every(o => o.protocolVersion === 'v3'));

      const v4Result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV4EthereumCore', tokenAddress: '0xunderlying', spokeAddress: '0xspoke' },
        merklData,
      );
      assert.ok(v4Result.every(o => o.protocolVersion === 'v4'));
    });
  });

  describe('signature: no protocolVersion parameter', () => {
    it('function accepts 2 arguments (item, merklData) without protocolVersion', () => {
      const merklData = buildMerklIndex();
      const result = findMatchingMerklOpportunities(
        { chainId: 1, marketName: 'AaveV3Ethereum', tokenAddress: '0xtoken' },
        merklData,
      );
      assert.ok(Array.isArray(result));
    });
  });
});
