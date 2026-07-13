import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSpokeHubTopology } from '../src/v4-topology.js';

interface MockSdkReserve {
  spoke: {
    address: string;
    chain: { id: number };
    connectedHubs: {
      hub: { address: string };
    }[];
  };
}

test('extractSpokeHubTopology returns topology matching connectedHubs after dedup', () => {
  const reserves: MockSdkReserve[] = [
    {
      spoke: {
        address: '0xSpokeA',
        chain: { id: 1 },
        connectedHubs: [
          { hub: { address: '0xHubCore' } },
        ],
      },
    },
    {
      spoke: {
        address: '0xSpokeB',
        chain: { id: 137 },
        connectedHubs: [
          { hub: { address: '0xHubPrime' } },
        ],
      },
    },
  ];

  const result = extractSpokeHubTopology(reserves);

  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(result[0], { chainId: 1, spokeAddress: '0xspokea', hubAddress: '0xhubcore' });
  assert.deepStrictEqual(result[1], { chainId: 137, spokeAddress: '0xspokeb', hubAddress: '0xhubprime' });
});

test('extractSpokeHubTopology returns empty for empty reserves', () => {
  const result = extractSpokeHubTopology([]);
  assert.deepStrictEqual(result, []);
});

test('extractSpokeHubTopology deduplicates reserves with same spoke address', () => {
  const reserves: MockSdkReserve[] = [
    {
      spoke: {
        address: '0xSpokeA',
        chain: { id: 1 },
        connectedHubs: [
          { hub: { address: '0xHubCore' } },
        ],
      },
    },
    {
      spoke: {
        address: '0xSpokeA',
        chain: { id: 1 },
        connectedHubs: [
          { hub: { address: '0xHubCore' } },
        ],
      },
    },
  ];

  const result = extractSpokeHubTopology(reserves);

  assert.strictEqual(result.length, 1);
  assert.deepStrictEqual(result[0], { chainId: 1, spokeAddress: '0xspokea', hubAddress: '0xhubcore' });
});

test('extractSpokeHubTopology produces multiple entries for one spoke connected to multiple hubs', () => {
  const reserves: MockSdkReserve[] = [
    {
      spoke: {
        address: '0xBluechip',
        chain: { id: 1 },
        connectedHubs: [
          { hub: { address: '0xHubCore' } },
          { hub: { address: '0xHubPrime' } },
        ],
      },
    },
  ];

  const result = extractSpokeHubTopology(reserves);

  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(result[0], { chainId: 1, spokeAddress: '0xbluechip', hubAddress: '0xhubcore' });
  assert.deepStrictEqual(result[1], { chainId: 1, spokeAddress: '0xbluechip', hubAddress: '0xhubprime' });
});

test('extractSpokeHubTopology does not conflict for same spoke name on different chainIds', () => {
  const reserves: MockSdkReserve[] = [
    {
      spoke: {
        address: '0xSpokeA',
        chain: { id: 1 },
        connectedHubs: [
          { hub: { address: '0xHubCore' } },
        ],
      },
    },
    {
      spoke: {
        address: '0xSpokeA',
        chain: { id: 42161 },
        connectedHubs: [
          { hub: { address: '0xHubCore' } },
        ],
      },
    },
  ];

  const result = extractSpokeHubTopology(reserves);

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].chainId, 1);
  assert.strictEqual(result[1].chainId, 42161);
  assert.strictEqual(result[0].spokeAddress, '0xspokea');
  assert.strictEqual(result[1].spokeAddress, '0xspokea');
});

test('extractSpokeHubTopology deduplicates same spoke+hub pair across multiple reserves', () => {
  const reserves: MockSdkReserve[] = [
    {
      spoke: {
        address: '0xSpokeA',
        chain: { id: 1 },
        connectedHubs: [
          { hub: { address: '0xHubCore' } },
          { hub: { address: '0xHubPrime' } },
        ],
      },
    },
    {
      spoke: {
        address: '0xSpokeA',
        chain: { id: 1 },
        connectedHubs: [
          { hub: { address: '0xHubCore' } },
        ],
      },
    },
  ];

  const result = extractSpokeHubTopology(reserves);

  assert.strictEqual(result.length, 2);
  const coreEntries = result.filter(e => e.hubAddress === '0xhubcore');
  const primeEntries = result.filter(e => e.hubAddress === '0xhubprime');
  assert.strictEqual(coreEntries.length, 1);
  assert.strictEqual(primeEntries.length, 1);
});

test('extractSpokeHubTopology normalizes addresses to lowercase', () => {
  const reserves: MockSdkReserve[] = [
    {
      spoke: {
        address: '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaAAA',
        chain: { id: 1 },
        connectedHubs: [
          { hub: { address: '0xBBbBbBbbBbBbBbbBbBBBBBBBBbbbBbBbBbbBbBBB' } },
        ],
      },
    },
  ];

  const result = extractSpokeHubTopology(reserves);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].spokeAddress, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.strictEqual(result[0].hubAddress, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});
