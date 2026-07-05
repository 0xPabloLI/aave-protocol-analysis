import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasHookType14,
  hasBorrowExclusionHook,
  extractBorrowHookProtocols,
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
          hooks: [{ hookType: 17, healthFactorThreshold: 2.0 }],
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

// ── hasHookType14 (deprecated alias) ──

test('hasHookType14 delegates to hasBorrowExclusionHook', () => {
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

// ── extractBorrowHookProtocols ──

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
    { hookType: 17, healthFactorThreshold: 2.0 },
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

// ── hasBlacklistWithBorrowHook (now delegates to hasBorrowExclusionHook) ──

test('hasBlacklistWithBorrowHook returns true when hookType=14 exists (no params.blacklist required)', () => {
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
          hooks: [{ hookType: 17, healthFactorThreshold: 2.0 }],
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
