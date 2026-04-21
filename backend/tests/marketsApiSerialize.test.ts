import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeReserveForApi } from '../src/services/marketsApiSerialize.js';
import type { RuntimeReserveData } from '../src/services/marketsService.js';

test('serializeReserveForApi scales ratio yield fields to HTTP percents', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xabc',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Test',
    tokenSymbol: 'TST',
    tokenAddress: '0xabc',
    supplyApy: 0.052,
    borrowApy: 0.04,
    supplyIncentives: [0.01, 0.002],
    borrowIncentives: [0.005],
    meritSupplys: [
      {
        apr: 0.03,
        selfApr: 0.01,
        link: 'https://merit.example/s',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
      },
    ],
    merklSupplys: [
      {
        link: 'https://merkl.example/o',
        breakdowns: [
          {
            campaignApr: 0.04,
            aprCap: 0.06,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'cmp-1',
          },
        ],
      },
    ],
    brevisSupplys: [
      {
        link: 'https://brevis.example/c',
        name: 'MetaMask Card',
        message: 'Eligible MetaMask Card users',
        breakdowns: [
          {
            campaignApr: 0.024,
            campaignStartedAt: '2025-08-13T13:00:00.000Z',
            campaignEndedAt: '2026-08-08T00:00:00.000Z',
            campaignId: '1754995104',
            latestTvl: 4_151_203.07,
            totalBudget: 9_998_600,
            perUserRewardCapUsd: 5000,
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);

  assert.equal(api.supplyApy, 5.2);
  assert.equal(api.borrowApy, 4);
  assert.deepEqual(api.supplyIncentives, [1, 0.2]);
  assert.deepEqual(api.borrowIncentives, [0.5]);
  assert.equal(api.meritSupplys?.[0]?.apr, 3);
  assert.equal(api.meritSupplys?.[0]?.selfApr, 1);
  const bd = api.merklSupplys?.[0]?.breakdowns?.[0];
  assert.equal(bd?.campaignApr, 4);
  assert.equal(bd?.aprCap, 6);
  assert.equal(api.brevisSupplys?.[0]?.name, 'MetaMask Card');
  assert.equal(api.brevisSupplys?.[0]?.message, 'Eligible MetaMask Card users');
  assert.equal(api.brevisSupplys?.[0]?.breakdowns?.[0]?.campaignApr, 2.4);
  assert.equal(api.brevisSupplys?.[0]?.breakdowns?.[0]?.perUserRewardCapUsd, 5000);
});

test('serializeReserveForApi preserves null aprCap on Merkl breakdown', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'x',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    merklBorrows: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.01,
            aprCap: null,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'id',
          },
        ],
      },
    ],
  };
  const api = serializeReserveForApi(reserve);
  assert.equal(api.merklBorrows?.[0]?.breakdowns?.[0]?.aprCap, null);
});

test('serializeReserveForApi omits DUTCH-only unused Merkl breakdown fields', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'dutch',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    merklSupplys: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.01,
            campaignType: 'DUTCH_AUCTION',
            aprCap: null,
            totalBudget: 1000,
            latestTvl: 5000,
            plannedDaily: 100,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'dutch-id',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignType, 'DUTCH_AUCTION');
  assert.equal('aprCap' in (breakdown ?? {}), false);
  assert.equal('totalBudget' in (breakdown ?? {}), false);
  assert.equal(breakdown?.latestTvl, 5000);
  assert.equal(breakdown?.plannedDaily, 100);
});

test('serializeReserveForApi omits plannedDaily for FIX_REWARD Merkl breakdowns', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'fix',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    merklSupplys: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.01,
            campaignType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
            aprCap: 0.02,
            totalBudget: 1000,
            latestTvl: 5000,
            plannedDaily: 100,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'fix-id',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignType, 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
  assert.equal('plannedDaily' in (breakdown ?? {}), false);
  assert.equal(breakdown?.totalBudget, 1000);
  assert.equal(breakdown?.latestTvl, 5000);
});

test('serializeReserveForApi preserves plannedDaily for MAX_REWARD Merkl breakdowns', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'max',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    merklSupplys: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.01,
            campaignType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
            aprCap: 0.02,
            totalBudget: 1000,
            latestTvl: 5000,
            plannedDaily: 100,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'max-id',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignType, 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
  assert.equal(breakdown?.plannedDaily, 100);
});

test('serializeReserveForApi passes through aaveProReserveId for V4 reserves', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV4Ethereum:1:0x973a023A7742',
    marketName: 'AaveV4Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Test',
    tokenSymbol: 'TST',
    tokenAddress: '0x973a023A7742',
    aaveProReserveId: 'MTo6MHg5NzNhMDIzQTc3NDIwYmE2MTBmMDZiMzg1OGFEOTkxRGY2ZDg1QTA4Ojo0',
  };

  const api = serializeReserveForApi(reserve);

  assert.equal(api.aaveProReserveId, 'MTo6MHg5NzNhMDIzQTc3NDIwYmE2MTBmMDZiMzg1OGFEOTkxRGY2ZDg1QTA4Ojo0');
});

test('serializeReserveForApi omits aaveProReserveId when absent', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xabc',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Test',
    tokenSymbol: 'TST',
    tokenAddress: '0xabc',
  };

  const api = serializeReserveForApi(reserve);

  assert.equal('aaveProReserveId' in api, false);
});

test('serializeReserveForApi omits aaveProReserveId when empty string', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV4Ethereum:1:0xdef',
    marketName: 'AaveV4Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Test',
    tokenSymbol: 'TST',
    tokenAddress: '0xdef',
    aaveProReserveId: '',
  };

  const api = serializeReserveForApi(reserve);

  assert.equal('aaveProReserveId' in api, false);
});
