import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeReserveForApi, roundTo6 } from '../src/services/marketsApiSerialize.js';
import type { RuntimeReserveData } from '../src/services/marketsService.js';
import { EXPECTED_RUNTIME_FIELDS } from '@internal/aave-shared-contracts';

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
    meritSupplys: [
      {
        link: 'https://merit.example/s',
        breakdowns: [
          {
            campaignApr: 0.03,
            campaignId: 'test-base',
            campaignStartedAt: '2025-01-01',
            campaignEndedAt: '2025-12-31',
            campaignType: 'DUTCH_AUCTION',
          },
          {
            campaignApr: 0.01,
            campaignId: 'test-self',
            campaignStartedAt: '2025-01-01',
            campaignEndedAt: '2025-12-31',
            campaignType: 'DUTCH_AUCTION',
            positionCap: 10000,
          },
        ],
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
            positionCap: 5000,
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);

  assert.equal(api.supplyApy, 5.2);
  assert.equal(api.borrowApy, 4);
  assert.equal(api.meritSupplys?.[0]?.breakdowns?.[0]?.campaignApr, 3);
  assert.equal(api.meritSupplys?.[0]?.breakdowns?.[1]?.campaignApr, 1);
  assert.equal(api.meritSupplys?.[0]?.breakdowns?.[1]?.positionCap, 10000);
  const bd = api.merklSupplys?.[0]?.breakdowns?.[0];
  assert.equal(bd?.campaignApr, 4);
  assert.equal(bd?.aprCap, 6);
  assert.equal(api.brevisSupplys?.[0]?.name, 'MetaMask Card');
  assert.equal(api.brevisSupplys?.[0]?.message, 'Eligible MetaMask Card users');
  assert.equal(api.brevisSupplys?.[0]?.breakdowns?.[0]?.campaignApr, 2.4);
  assert.equal(api.brevisSupplys?.[0]?.breakdowns?.[0]?.positionCap, 5000);
});

test('serializeReserveForApi scales Brevis aprCap to percent', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'brevis-cap',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    brevisSupplys: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.024,
            aprCap: 0.024,
            campaignId: '1754995104',
            campaignStartedAt: '2025-08-13T13:00:00.000Z',
            campaignEndedAt: '2026-08-08T00:00:00.000Z',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const bd = api.brevisSupplys?.[0]?.breakdowns?.[0];
  assert.equal(bd?.campaignApr, 2.4);
  assert.equal(bd?.aprCap, 2.4);
});

test('serializeReserveForApi omits Brevis aprCap when absent', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'brevis-nocap',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    brevisBorrows: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.01,
            campaignId: '123',
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const bd = api.brevisBorrows?.[0]?.breakdowns?.[0];
  assert.equal(bd?.campaignApr, 1);
  assert.equal('aprCap' in (bd ?? {}), false);
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

test('serializeReserveForApi includes budgetBoundMode for TARGET_TOTAL_APR Merkl breakdowns', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'tta',
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
            campaignType: 'TARGET_TOTAL_APR',
            aprCap: 0.047,
            totalBudget: 1000,
            latestTvl: 5000,
            plannedDaily: 100,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'tta-id',
            budgetBoundMode: 'MAX_APR',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignType, 'TARGET_TOTAL_APR');
  assert.equal(breakdown?.budgetBoundMode, 'MAX_APR');
});

test('serializeReserveForApi omits budgetBoundMode when undefined for non-TARGET_TOTAL_APR breakdowns', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'max-no-mode',
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
  assert.equal('budgetBoundMode' in (breakdown ?? {}), false);
});

test('serializeReserveForApi omits plannedDaily for TARGET_TOTAL_APR with FIX_APR budgetBoundMode', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'tta-fix',
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
            campaignType: 'TARGET_TOTAL_APR',
            aprCap: 0.047,
            totalBudget: 1000,
            latestTvl: 5000,
            plannedDaily: 100,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'tta-fix-id',
            budgetBoundMode: 'FIX_APR',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignType, 'TARGET_TOTAL_APR');
  assert.equal(breakdown?.budgetBoundMode, 'FIX_APR');
  assert.equal('plannedDaily' in (breakdown ?? {}), false);
});

test('serializeReserveForApi preserves plannedDaily for TARGET_TOTAL_APR with MAX_APR budgetBoundMode', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'tta-max',
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
            campaignType: 'TARGET_TOTAL_APR',
            aprCap: 0.047,
            totalBudget: 1000,
            latestTvl: 5000,
            plannedDaily: 100,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'tta-max-id',
            budgetBoundMode: 'MAX_APR',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignType, 'TARGET_TOTAL_APR');
  assert.equal(breakdown?.budgetBoundMode, 'MAX_APR');
  assert.equal(breakdown?.plannedDaily, 100);
});

test('serializeReserveForApi preserves plannedDaily for TARGET_TOTAL_APR without budgetBoundMode (fallback to MAX rules)', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'tta-no-mode',
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
            campaignType: 'TARGET_TOTAL_APR',
            aprCap: 0.047,
            totalBudget: 1000,
            latestTvl: 5000,
            plannedDaily: 100,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'tta-no-mode-id',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignType, 'TARGET_TOTAL_APR');
  assert.equal('budgetBoundMode' in (breakdown ?? {}), false);
  assert.equal(breakdown?.plannedDaily, 100);
});

test('serializeReserveForApi passes through aaveProReserveId for V4 reserves', () => {
  const reserve: RuntimeReserveData = {
    reserveId: '1:0x973a023a77420ba610f06b3858ad991df6d85a01:0x973a023a77420ba610f06b3858ad991df6d85a02:0xcca852bc40e560adc3b1cc58ca5b55638ce826c9',
    marketName: 'AaveV4Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Test',
    tokenSymbol: 'TST',
    tokenAddress: '0x973a023a77420ba610f06b3858ad991df6d85a02',
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
    reserveId: '1:0xdefdefdefdefdefdefdefdefdefdefdefdefdef1:0xdefdefdefdefdefdefdefdefdefdefdefdefdef2:0x06002e9c4412cb7814a791ea3666d905871e536a',
    marketName: 'AaveV4Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Test',
    tokenSymbol: 'TST',
    tokenAddress: '0xdefdefdefdefdefdefdefdefdefdefdefdefdef2',
    aaveProReserveId: '',
  };

  const api = serializeReserveForApi(reserve);

  assert.equal('aaveProReserveId' in api, false);
});

test('serializeReserveForApi passes through isFrozen and isPaused when true', () => {
  const frozen: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xfrozen',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Frozen',
    tokenSymbol: 'FRZ',
    tokenAddress: '0xfrozen',
    isFrozen: true,
  };
  const paused: RuntimeReserveData = { ...frozen, isFrozen: undefined, isPaused: true };
  const both: RuntimeReserveData = { ...frozen, isPaused: true };

  const api1 = serializeReserveForApi(frozen);
  const api2 = serializeReserveForApi(paused);
  const api3 = serializeReserveForApi(both);

  assert.equal(api1.isFrozen, true);
  assert.equal('isPaused' in api1, false);
  assert.equal(api2.isPaused, true);
  assert.equal('isFrozen' in api2, false);
  assert.equal(api3.isFrozen, true);
  assert.equal(api3.isPaused, true);
});

test('serializeReserveForApi omits isFrozen/isPaused when absent', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xnormal',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Normal',
    tokenSymbol: 'NRM',
    tokenAddress: '0xnormal',
  };

  const api = serializeReserveForApi(reserve);

  assert.equal('isFrozen' in api, false);
  assert.equal('isPaused' in api, false);
});

test('isFrozen/isPaused is independent of supplyDisabled', () => {
  // A reserve can be frozen but not supply-disabled (supplyCap != 1)
  const frozenNotDisabled: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xfnd',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'FrozenNotDisabled',
    tokenSymbol: 'FND',
    tokenAddress: '0xfnd',
    isFrozen: true,
    supplyApy: 0.03,
  };

  const api1 = serializeReserveForApi(frozenNotDisabled);
  assert.equal(api1.isFrozen, true);
  assert.equal('supplyDisabled' in api1, false);
  assert.equal(api1.supplyApy, 3);

  // A reserve can be supply-disabled (supplyCap=1) but not frozen/paused
  const disabledNotFrozen: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xdnf',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'DisabledNotFrozen',
    tokenSymbol: 'DNF',
    tokenAddress: '0xdnf',
    supplyDisabled: true,
  };

  const api2 = serializeReserveForApi(disabledNotFrozen);
  assert.equal('isFrozen' in api2, false);
  assert.equal('isPaused' in api2, false);
  assert.equal(api2.supplyDisabled, true);
});

test('serializeReserveForApi outputs isActive:false for inactive V4 reserve', () => {
  const reserve: RuntimeReserveData = {
    reserveId: '1:0x1111111111111111111111111111111111111111:0xinactive0000000000000000000000000000000000:0x06002e9c4412cb7814a791ea3666d905871e536a',
    marketName: 'AaveV4Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Inactive',
    tokenSymbol: 'INA',
    tokenAddress: '0xinactive0000000000000000000000000000000000',
    isActive: false,
  };

  const api = serializeReserveForApi(reserve);
  assert.equal(api.isActive, false);
  assert.equal('isFrozen' in api, false);
  assert.equal('isPaused' in api, false);
});

test('serializeReserveForApi does NOT output isActive when true or absent', () => {
  const reserve: RuntimeReserveData = {
    reserveId: '1:0x2222222222222222222222222222222222222222:0xactive000000000000000000000000000000000000:0xcca852bc40e560adc3b1cc58ca5b55638ce826c9',
    marketName: 'AaveV4Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Active',
    tokenSymbol: 'ACT',
    tokenAddress: '0xactive000000000000000000000000000000000000',
  };

  const api = serializeReserveForApi(reserve);
  assert.equal('isActive' in api, false);
});

test('serializeReserveForApi never outputs isActive for V3 reserve', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xv3',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'V3Token',
    tokenSymbol: 'V3T',
    tokenAddress: '0xv3',
    supplyApy: 0.03,
  };

  const api = serializeReserveForApi(reserve);
  assert.equal('isActive' in api, false);
});

test('serializeReserveForApi omits decimals when 18', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xdec18',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Dec18',
    tokenSymbol: 'D18',
    tokenAddress: '0xdec18',
    decimals: 18,
  };

  const api = serializeReserveForApi(reserve);
  assert.equal('decimals' in api, false);
});

test('roundTo6 truncates to 6 decimal places', () => {
  assert.equal(roundTo6(2.073456789012345), 2.073457);
  assert.equal(roundTo6(0.123456789), 0.123457);
});

test('roundTo6 preserves exact 6-decimal values', () => {
  assert.equal(roundTo6(2.073456), 2.073456);
});

test('roundTo6 handles zero', () => {
  assert.equal(roundTo6(0), 0);
});

test('roundTo6 handles negative values', () => {
  assert.equal(roundTo6(-0.123456789), -0.123457);
});

test('roundTo6 eliminates floating point artifacts', () => {
  assert.equal(roundTo6(5.200000000000001), 5.2);
});

test('serializeReserveForApi supplyApy is rounded to 6 decimal places', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xprec',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Precision',
    tokenSymbol: 'PREC',
    tokenAddress: '0xprec',
    supplyApy: 0.02073456789012345,
  };

  const api = serializeReserveForApi(reserve);
  assert.equal(api.supplyApy, 2.073457);
});

test('serializeReserveForApi protocolFee zero is omitted', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xzeroFee',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'ZeroFee',
    tokenSymbol: 'ZFEE',
    tokenAddress: '0xzeroFee',
    protocolFee: 0,
  };

  const api = serializeReserveForApi(reserve);
  assert.equal('protocolFee' in api, false);
});

test('serializeReserveForApi protocolFee non-zero is preserved', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xposFee',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'PosFee',
    tokenSymbol: 'PFEE',
    tokenAddress: '0xposFee',
    protocolFee: 10,
  };

  const api = serializeReserveForApi(reserve);
  assert.equal(api.protocolFee, 10);
});

test('serializeReserveForApi preserves decimals when not 18', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xdec6',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Dec6',
    tokenSymbol: 'D6',
    tokenAddress: '0xdec6',
    decimals: 6,
  };

  const api = serializeReserveForApi(reserve);
  assert.equal(api.decimals, 6);
});

test('serializeReserveForApi omits decimals when absent', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xnodec',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'NoDec',
    tokenSymbol: 'ND',
    tokenAddress: '0xnodec',
  };

  const api = serializeReserveForApi(reserve);
  assert.equal('decimals' in api, false);
});

function makeFullReserve(): RuntimeReserveData {
  return {
    reserveId: 'test-coverage',
    marketName: 'AaveV4Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Test Token',
    tokenSymbol: 'TST',
    tokenAddress: '0x0000000000000000000000000000000000000001',
    tokenPrice: 1.5,
    utilizationPct: 75,
    aTokenAddress: '0x0000000000000000000000000000000000000002',
    vTokenAddress: '0x0000000000000000000000000000000000000003',
    supplyApy: 0.05,
    supplyDisabled: true,
    isFrozen: true,
    isPaused: true,
    isActive: false,
    borrowApy: 0.04,
    borrowDisabled: true,
    decimals: 6,
    supplyCap: '1000000',
    borrowCap: '800000',
    deficit: '0',
    supplied: '500000',
    borrowed: '300000',
    liquidity: '200000',
    protocolFee: 10,
    slopeBelowOptimal: 4,
    slopeAboveOptimal: 80,
    optimalUtilization: 80,
    baseBorrowRate: 0.5,
    aaveProReserveId: '12345',
    meritSupplys: [{ link: 'https://test', breakdowns: [{ campaignApr: 0.01, campaignId: 'test-base', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31', campaignType: 'DUTCH_AUCTION' }] }],
    meritBorrows: [{ link: 'https://test', breakdowns: [{ campaignApr: 0.02, campaignId: 'test-base', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31', campaignType: 'DUTCH_AUCTION' }] }],
    merklSupplys: [{ link: 'https://test', breakdowns: [{ campaignApr: 0.03, campaignId: 'cmp-1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }],
    merklBorrows: [{ link: 'https://test', breakdowns: [{ campaignApr: 0.04, campaignId: 'cmp-2', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }],
    merklHolds: [{ link: 'https://test', breakdowns: [{ campaignApr: 0.05, campaignId: 'cmp-3', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }],
    brevisSupplys: [{ link: 'https://test', breakdowns: [{ campaignApr: 0.06, campaignId: 'cmp-4', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }],
    brevisBorrows: [{ link: 'https://test', breakdowns: [{ campaignApr: 0.07, campaignId: 'cmp-5', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }],
    hubId: '1',
    hubName: 'Core',
    hubAddress: '0x0000000000000000000000000000000000000004',
    spokeId: '1',
    spokeName: 'Main',
    spokeAddress: '0x0000000000000000000000000000000000000005',
    collateralRisk: 5,
  };
}

test('serializeReserveForApi output covers all EXPECTED_RUNTIME_FIELDS', () => {
  const reserve = makeFullReserve();
  const api = serializeReserveForApi(reserve);
  const outputKeys = Object.keys(api);

  const SERIALIZED_EXCLUDE = new Set(['hubAddress', 'spokeAddress']);

  const missing: string[] = [];
  for (const field of EXPECTED_RUNTIME_FIELDS) {
    if (SERIALIZED_EXCLUDE.has(field)) continue;
    if (!outputKeys.includes(field)) {
      missing.push(field);
    }
  }

  assert.equal(missing.length, 0, `serializeReserveForApi is missing fields: ${missing.join(', ')}`);
});

test('serializeReserveForApi outputs collateralRisk with roundTo6 for V4 reserve', () => {
  const reserve = makeFullReserve();
  reserve.collateralRisk = 5.1234567;
  const api = serializeReserveForApi(reserve);
  assert.equal(api.collateralRisk, 5.123457);
});

test('serializeReserveForApi omits collateralRisk for V3 reserve (undefined)', () => {
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
  assert.equal('collateralRisk' in api, false);
});

test('V3 reserve does not set collateralRisk (undefined by default)', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'AaveV3Ethereum:1:0xv3',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'V3Token',
    tokenSymbol: 'V3',
    tokenAddress: '0xv3',
  };

  assert.equal(reserve.collateralRisk, undefined);
  const api = serializeReserveForApi(reserve);
  assert.equal('collateralRisk' in api, false);
});

test('serializeReserveForApi computes incentive APR for TARGET_TOTAL_APR supply breakdown', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'tta-supply',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    supplyApy: 0.035,
    merklSupplys: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.077,
            campaignType: 'TARGET_TOTAL_APR',
            aprCap: 0.077,
            totalBudget: 1000,
            latestTvl: 5000,
            plannedDaily: 100,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'tta-supply-id',
            budgetBoundMode: 'MAX_APR',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignType, 'TARGET_TOTAL_APR');
  assert.ok(breakdown!.campaignApr < 7.7, `campaignApr (${breakdown!.campaignApr}) should be less than targetAPR (7.7)`);
  assert.ok(breakdown!.campaignApr > 0, `campaignApr (${breakdown!.campaignApr}) should be positive`);
  assert.equal(breakdown?.aprCap, 7.7, 'aprCap should remain as targetAPR');
});

test('serializeReserveForApi computes incentive APR for TARGET_TOTAL_APR borrow breakdown', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'tta-borrow',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    borrowApy: 0.05,
    merklBorrows: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.02,
            campaignType: 'TARGET_TOTAL_APR',
            aprCap: 0.02,
            totalBudget: 1000,
            latestTvl: 5000,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'tta-borrow-id',
            budgetBoundMode: 'MAX_APR',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklBorrows?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignType, 'TARGET_TOTAL_APR');
  assert.ok(breakdown!.campaignApr > 0, 'Borrow incentive APR should be positive when targetAPR < nativeBorrowAPY');
  assert.equal(breakdown?.aprCap, 2.0, 'aprCap should remain as targetAPR');
});

test('serializeReserveForApi returns 0 incentive APR for TARGET_TOTAL_APR when nativeAPY already exceeds target', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'tta-noop',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    supplyApy: 0.10,
    merklSupplys: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.047,
            campaignType: 'TARGET_TOTAL_APR',
            aprCap: 0.047,
            totalBudget: 1000,
            latestTvl: 5000,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'tta-noop-id',
            budgetBoundMode: 'MAX_APR',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignApr, 0, 'Incentive APR should be 0 when native exceeds target');
});

test('serializeReserveForApi preserves raw campaignApr for non-TARGET_TOTAL_APR breakdowns', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'max-type',
    marketName: 'm',
    chainName: 'c',
    chainId: 1,
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenAddress: '0x0',
    supplyApy: 0.035,
    merklSupplys: [
      {
        link: 'l',
        breakdowns: [
          {
            campaignApr: 0.05,
            campaignType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
            aprCap: 0.05,
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

  assert.equal(breakdown?.campaignApr, 5, 'Non-TARGET_TOTAL_APR should use raw campaignApr × 100');
});

test('serializeReserveForApi falls back to raw campaignApr for TARGET_TOTAL_APR when supplyApy is undefined', () => {
  const reserve: RuntimeReserveData = {
    reserveId: 'tta-no-apy',
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
            campaignApr: 0.047,
            campaignType: 'TARGET_TOTAL_APR',
            aprCap: 0.047,
            campaignStartedAt: '2025-01-01T00:00:00.000Z',
            campaignEndedAt: '2025-12-31T00:00:00.000Z',
            campaignId: 'tta-fallback-id',
            budgetBoundMode: 'MAX_APR',
          },
        ],
      },
    ],
  };

  const api = serializeReserveForApi(reserve);
  const breakdown = api.merklSupplys?.[0]?.breakdowns?.[0];

  assert.equal(breakdown?.campaignApr, 4.7, 'Without supplyApy, TARGET_TOTAL_APR should fall back to raw campaignApr × 100');
});
