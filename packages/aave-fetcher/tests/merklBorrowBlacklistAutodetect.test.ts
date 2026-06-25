import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasHookType14,
  extractBorrowHookProtocols,
  hasBlacklistWithBorrowHook,
} from '../src/merkl-api.js';

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

test('hasHookType14 returns false when no hookType=14', () => {
  const opp = {
    campaigns: [
      {
        params: {
          hooks: [{ hookType: 1, protocol: 0 }],
        },
      },
    ],
  } as any;
  assert.equal(hasHookType14(opp), false);
});

test('hasHookType14 returns false when no campaigns', () => {
  assert.equal(hasHookType14({ campaigns: [] } as any), false);
  assert.equal(hasHookType14({} as any), false);
});

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

test('extractBorrowHookProtocols returns empty for non-array input', () => {
  assert.deepEqual(extractBorrowHookProtocols(null), []);
  assert.deepEqual(extractBorrowHookProtocols(undefined), []);
  assert.deepEqual(extractBorrowHookProtocols('not-array'), []);
});

test('hasBlacklistWithBorrowHook returns true when blacklist + hookType=14 coexist', () => {
  const opp = {
    campaigns: [
      {
        params: {
          blacklist: ['0x123', '0x456'],
          hooks: [{ hookType: 14, protocol: 2, borrowBytesLike: ['0xaaa'] }],
        },
      },
    ],
  } as any;
  assert.equal(hasBlacklistWithBorrowHook(opp), true);
});

test('hasBlacklistWithBorrowHook returns false when blacklist but no hookType=14', () => {
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

test('hasBlacklistWithBorrowHook returns false when hookType=14 but no blacklist', () => {
  const opp = {
    campaigns: [
      {
        params: {
          blacklist: [],
          hooks: [{ hookType: 14, protocol: 2, borrowBytesLike: ['0xaaa'] }],
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

test('hasBlacklistWithBorrowHook checks across multiple campaigns', () => {
  const opp = {
    campaigns: [
      {
        params: {
          blacklist: ['0x123'],
          hooks: [],
        },
      },
      {
        params: {
          blacklist: [],
          hooks: [{ hookType: 14, protocol: 1, borrowBytesLike: ['0xaaa'] }],
        },
      },
    ],
  } as any;
  assert.equal(hasBlacklistWithBorrowHook(opp), false);
});

test('hasBlacklistWithBorrowHook: blacklist in one campaign + hookType14 in same campaign = true', () => {
  const opp = {
    campaigns: [
      {
        params: {
          blacklist: ['0x123'],
          hooks: [{ hookType: 14, protocol: 2, borrowBytesLike: ['0xaaa'] }],
        },
      },
    ],
  } as any;
  assert.equal(hasBlacklistWithBorrowHook(opp), true);
});
