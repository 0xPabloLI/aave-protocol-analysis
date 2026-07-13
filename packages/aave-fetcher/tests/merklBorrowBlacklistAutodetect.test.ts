import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasHookType14,
  hasBorrowExclusionHook,
  extractBorrowHookProtocols,
  extractHealthFactorHooks,
  hasBlacklistWithBorrowHook,
} from '../src/merkl-api.js';

// ── hasBorrowExclusionHook ──

test('hasBorrowExclusionHook returns true when campaign has hookType=14 (BORROW_BL)', () => {
  const opp = {
    campaigns: [
      {
        params: {
          hooks: [{ hookType: 14, protocol: 2, borrowBytesLike: ['0xabc'] }],
        },
      },
    ],
  } as any;
  assert.equal(hasBorrowExclusionHook(opp), true);
});

test('hasBorrowExclusionHook returns true when campaign has hookType=17 (HEALTH_FACTOR)', () => {
  const opp = {
    campaigns: [
      {
        params: {
          hooks: [{ hookType: 17, protocol: 0, healthFactorThreshold: '0.9', targetBytesLike: '0xpool', chainId: 1 }],
        },
      },
    ],
  } as any;
  assert.equal(hasBorrowExclusionHook(opp), true);
});

test('hasBorrowExclusionHook returns true with hookType=14 even without params.blacklist', () => {
  const opp = {
    campaigns: [
      {
        params: {
          hooks: [{ hookType: 14, protocol: 2, borrowBytesLike: ['0xaaa'] }],
        },
      },
    ],
  } as any;
  assert.equal(hasBorrowExclusionHook(opp), true);
});

test('hasBorrowExclusionHook returns false when no borrow-exclusion hookType', () => {
  const opp = {
    campaigns: [
      {
        params: {
          hooks: [{ hookType: 1, protocol: 0 }],
        },
      },
    ],
  } as any;
  assert.equal(hasBorrowExclusionHook(opp), false);
});

test('hasBorrowExclusionHook returns false when no campaigns', () => {
  assert.equal(hasBorrowExclusionHook({ campaigns: [] } as any), false);
  assert.equal(hasBorrowExclusionHook({} as any), false);
});

// ── hasHookType14 (deprecated, only checks hookType=14) ──

test('hasHookType14 returns true when campaign has hookType=14', () => {
  const opp = {
    campaigns: [
      {
        params: {
          hooks: [{ hookType: 14, protocol: 2, borrowBytesLike: ['0xabc'] }],
        },
      },
    ],
  } as any;
  assert.equal(hasHookType14(opp), true);
});

test('hasHookType14 returns false when only hookType=17', () => {
  const opp = {
    campaigns: [
      {
        params: {
          hooks: [{ hookType: 17, protocol: 0, healthFactorThreshold: '0.9', targetBytesLike: '0xpool', chainId: 1 }],
        },
      },
    ],
  } as any;
  assert.equal(hasHookType14(opp), false);
});

// ── extractBorrowHookProtocols (hookType=14 only) ──

test('extractBorrowHookProtocols extracts protocols from hookType=14', () => {
  const hooks = [
    { hookType: 14, protocol: 2, borrowBytesLike: ['0xAAA'] },
    { hookType: 14, protocol: 1, borrowBytesLike: ['0xBBB', '0xCCC'] },
    { hookType: 1, protocol: 0, borrowBytesLike: ['0xDDD'] },
  ];
  const result = extractBorrowHookProtocols(hooks);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { protocol: 2, borrowBytesLike: ['0xAAA'] });
  assert.deepEqual(result[1], { protocol: 1, borrowBytesLike: ['0xBBB', '0xCCC'] });
});

test('extractBorrowHookProtocols filters out empty borrowBytesLike', () => {
  const hooks = [
    { hookType: 14, protocol: 0, borrowBytesLike: [] },
    { hookType: 14, protocol: 1, borrowBytesLike: ['0xAAA'] },
  ];
  const result = extractBorrowHookProtocols(hooks);
  assert.equal(result.length, 1);
  assert.equal(result[0].protocol, 1);
});

test('extractBorrowHookProtocols does not extract from hookType=17', () => {
  const hooks = [
    { hookType: 17, protocol: 0, healthFactorThreshold: '0.9', targetBytesLike: '0xpool', chainId: 1 },
    { hookType: 14, protocol: 1, borrowBytesLike: ['0xAAA'] },
  ];
  const result = extractBorrowHookProtocols(hooks);
  assert.equal(result.length, 1);
  assert.equal(result[0].protocol, 1);
});

test('extractBorrowHookProtocols returns empty for non-array input', () => {
  assert.deepEqual(extractBorrowHookProtocols(null), []);
  assert.deepEqual(extractBorrowHookProtocols(undefined), []);
  assert.deepEqual(extractBorrowHookProtocols('not-array'), []);
});

// ── extractHealthFactorHooks (hookType=17) ──

test('extractHealthFactorHooks extracts from hookType=17', () => {
  const hooks = [
    { hookType: 17, protocol: 0, healthFactorThreshold: '0.9', targetBytesLike: '0xpool', chainId: 1 },
  ];
  const result = extractHealthFactorHooks(hooks);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { protocol: 0, healthFactorThreshold: '0.9', targetBytesLike: '0xpool', chainId: 1 });
});

test('extractHealthFactorHooks extracts multiple hookType=17 entries', () => {
  const hooks = [
    { hookType: 17, protocol: 0, healthFactorThreshold: '0.9', targetBytesLike: '0xpool1', chainId: 1 },
    { hookType: 17, protocol: 0, healthFactorThreshold: '1.5', targetBytesLike: '0xpool2', chainId: 42161 },
    { hookType: 14, protocol: 2, borrowBytesLike: ['0xAAA'] },
  ];
  const result = extractHealthFactorHooks(hooks);
  assert.equal(result.length, 2);
  assert.equal(result[0].healthFactorThreshold, '0.9');
  assert.equal(result[1].healthFactorThreshold, '1.5');
  assert.equal(result[1].chainId, 42161);
});

test('extractHealthFactorHooks skips entries with missing required fields', () => {
  const hooks = [
    { hookType: 17, protocol: 0, healthFactorThreshold: '0.9', targetBytesLike: '0xpool' },
    { hookType: 17, protocol: 0, healthFactorThreshold: '', targetBytesLike: '0xpool', chainId: 1 },
    { hookType: 17, protocol: 0, healthFactorThreshold: '0.9', targetBytesLike: '', chainId: 1 },
  ];
  const result = extractHealthFactorHooks(hooks);
  assert.equal(result.length, 0);
});

test('extractHealthFactorHooks returns empty for non-array input', () => {
  assert.deepEqual(extractHealthFactorHooks(null), []);
  assert.deepEqual(extractHealthFactorHooks(undefined), []);
  assert.deepEqual(extractHealthFactorHooks('not-array'), []);
});

// ── hasBlacklistWithBorrowHook (now delegates to hasBorrowExclusionHook) ──

test('hasBlacklistWithBorrowHook returns true when hookType=14 exists', () => {
  const opp = {
    campaigns: [
      {
        params: {
          hooks: [{ hookType: 14, protocol: 2, borrowBytesLike: ['0xaaa'] }],
        },
      },
    ],
  } as any;
  assert.equal(hasBlacklistWithBorrowHook(opp), true);
});

test('hasBlacklistWithBorrowHook returns true when hookType=17 exists', () => {
  const opp = {
    campaigns: [
      {
        params: {
          hooks: [{ hookType: 17, protocol: 0, healthFactorThreshold: '0.9', targetBytesLike: '0xpool', chainId: 1 }],
        },
      },
    ],
  } as any;
  assert.equal(hasBlacklistWithBorrowHook(opp), true);
});

test('hasBlacklistWithBorrowHook returns false when no borrow-exclusion hookType', () => {
  const opp = {
    campaigns: [
      {
        params: {
          blacklist: ['0x123'],
          hooks: [{ hookType: 1, protocol: 0 }],
        },
      },
    ],
  } as any;
  assert.equal(hasBlacklistWithBorrowHook(opp), false);
});

test('hasBlacklistWithBorrowHook returns false when no campaigns', () => {
  assert.equal(hasBlacklistWithBorrowHook({ campaigns: [] } as any), false);
  assert.equal(hasBlacklistWithBorrowHook({} as any), false);
});
