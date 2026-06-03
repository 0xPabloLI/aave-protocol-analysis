import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getV4SpokeEntries, getDefaultV4SpokeEntries, type V4SpokeEntry } from '../src/index.js';
import type { SpokeHubTopology } from '@internal/aave-shared-contracts';

test('getV4SpokeEntries returns empty array for empty topology', () => {
  const result = getV4SpokeEntries([]);
  assert.deepEqual(result, []);
});

test('getV4SpokeEntries returns entry for matching spoke-hub pair', () => {
  const topology: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0x94e7A5dCbE816e498b89aB752661904E2F56c485', hubAddress: '0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9' },
  ];
  const result = getV4SpokeEntries(topology);
  assert.ok(result.length >= 1, 'should have at least 1 entry for MAIN_SPOKE→CORE_HUB');
  const mainEntry = result.find(e => e.spokeName === 'MAIN_SPOKE' && e.hubName === 'CORE_HUB');
  assert.ok(mainEntry, 'should have MAIN_SPOKE→CORE_HUB entry');
  assert.equal(mainEntry!.chainId, 1);
  assert.equal(mainEntry!.spokeAddress, '0x94e7a5dcbe816e498b89ab752661904e2f56c485');
  assert.equal(mainEntry!.hubAddress, '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9');
});

test('getV4SpokeEntries skips spoke not found in address-book', () => {
  const topology: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0x000000000000000000000000000000000000dEaD', hubAddress: '0x000000000000000000000000000000000000bEeF' },
  ];
  const result = getV4SpokeEntries(topology);
  assert.equal(result.length, 0, 'should skip spoke not found in address-book');
});

test('getV4SpokeEntries produces multiple entries for spoke connected to multiple hubs', () => {
  const topology: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0x973a023A77420ba610f06b3858aD991Df6d85A08', hubAddress: '0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9' },
    { chainId: 1, spokeAddress: '0x973a023A77420ba610f06b3858aD991Df6d85A08', hubAddress: '0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931' },
  ];
  const result = getV4SpokeEntries(topology);
  const bluechipEntries = result.filter(e => e.spokeName === 'BLUECHIP_SPOKE');
  assert.ok(bluechipEntries.length >= 2, 'should produce multiple entries for spoke with multiple hubs');
  const hubNames = bluechipEntries.map(e => e.hubName);
  assert.ok(hubNames.includes('CORE_HUB'), 'should include CORE_HUB');
  assert.ok(hubNames.includes('PRIME_HUB'), 'should include PRIME_HUB');
});

test('getDefaultV4SpokeEntries returns same result as getV4SpokeEntries with DEFAULT_SPOKE_HUB_TOPOLOGY', () => {
  const defaultResult = getDefaultV4SpokeEntries();
  assert.ok(Array.isArray(defaultResult), 'should return an array');
  assert.ok(defaultResult.length > 0, 'should have entries from default topology');
  for (const entry of defaultResult) {
    assert.ok(entry.spokeName, 'entry should have spokeName');
    assert.ok(entry.hubName, 'entry should have hubName');
    assert.ok(typeof entry.chainId === 'number', 'entry should have chainId');
    assert.ok(entry.spokeAddress, 'entry should have spokeAddress');
    assert.ok(entry.hubAddress, 'entry should have hubAddress');
  }
});
