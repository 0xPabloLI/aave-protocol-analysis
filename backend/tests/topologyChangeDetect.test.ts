import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initAddressBookRegistry,
  topologySignature,
  getCurrentTopologySignature,
  DEFAULT_TOPOLOGY,
  V3_ENTRIES,
  V4_SPOKE_ENTRIES,
} from '../src/services/addressBookRegistry.js';
import type { SpokeHubTopology } from '@internal/aave-shared-contracts';

test('topologySignature returns deterministic JSON string', () => {
  const topo: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0xaaa', hubAddress: '0xbbb' },
  ];
  const sig1 = topologySignature(topo);
  const sig2 = topologySignature(topo);
  assert.strictEqual(sig1, sig2);
});

test('topologySignature differs for different topologies', () => {
  const topo1: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0xaaa', hubAddress: '0xbbb' },
  ];
  const topo2: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0xaaa', hubAddress: '0xbbb' },
    { chainId: 1, spokeAddress: '0xccc', hubAddress: '0xddd' },
  ];
  assert.notStrictEqual(topologySignature(topo1), topologySignature(topo2));
});

test('initAddressBookRegistry updates currentTopologySignature', () => {
  const topo: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0x94e7a5dcbe816e498b89ab752661904e2f56c485', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  ];
  initAddressBookRegistry(topo);
  assert.strictEqual(getCurrentTopologySignature(), topologySignature(topo));
});

test('topology change triggers rebuild: V4_SPOKE_ENTRIES changes with different topology', () => {
  initAddressBookRegistry(DEFAULT_TOPOLOGY);
  const entryCountDefault = V4_SPOKE_ENTRIES.length;

  const singleEntry: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0x94e7a5dcbe816e498b89ab752661904e2f56c485', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  ];
  initAddressBookRegistry(singleEntry);
  const entryCountSingle = V4_SPOKE_ENTRIES.length;

  assert.ok(entryCountDefault > entryCountSingle, `DEFAULT_TOPOLOGY (${entryCountDefault}) should produce more entries than single-entry topology (${entryCountSingle})`);
});

test('topology no change skips rebuild: same signature', () => {
  initAddressBookRegistry(DEFAULT_TOPOLOGY);
  const sig1 = getCurrentTopologySignature();

  initAddressBookRegistry(DEFAULT_TOPOLOGY);
  const sig2 = getCurrentTopologySignature();

  assert.strictEqual(sig1, sig2);
});

test('module load initializes with DEFAULT_TOPOLOGY signature', () => {
  initAddressBookRegistry(DEFAULT_TOPOLOGY);
  const sig = getCurrentTopologySignature();
  assert.ok(sig !== null, 'signature should not be null after DEFAULT_TOPOLOGY init');
  assert.strictEqual(sig, topologySignature(DEFAULT_TOPOLOGY));
});

test('DEFAULT_TOPOLOGY is non-empty', () => {
  assert.ok(DEFAULT_TOPOLOGY.length > 0);
});

test('V3 entries are stable across topology changes', () => {
  initAddressBookRegistry(DEFAULT_TOPOLOGY);
  const v3CountDefault = V3_ENTRIES.length;

  const singleEntry: SpokeHubTopology = [
    { chainId: 1, spokeAddress: '0x94e7a5dcbe816e498b89ab752661904e2f56c485', hubAddress: '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9' },
  ];
  initAddressBookRegistry(singleEntry);
  const v3CountSingle = V3_ENTRIES.length;

  assert.strictEqual(v3CountDefault, v3CountSingle, 'V3 entries should not change with topology');

  initAddressBookRegistry(DEFAULT_TOPOLOGY);
});
