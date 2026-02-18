import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchMerklOpportunities } from '../src/services/merklOpportunityClient.js';
import { __resetMerklOpportunitiesSnapshotCacheForTests } from '@internal/merkl-shared';

test.afterEach(() => {
  __resetMerklOpportunitiesSnapshotCacheForTests();
});

test('fetchMerklOpportunities paginates by short-page termination and merges pages', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes('/opportunities?') && url.includes('page=0')) {
      return new Response(JSON.stringify([{ id: 'a' }, { id: 'b' }]), { status: 200 });
    }

    if (url.includes('/opportunities?') && url.includes('page=1')) {
      return new Response(JSON.stringify([{ id: 'c' }]), { status: 200 });
    }

    return new Response('[]', { status: 200 });
  }) as typeof fetch;

  try {
    const result = await fetchMerklOpportunities({
      mainProtocolId: 'aave,tydro',
      status: 'LIVE',
      itemsPerPage: 2,
    });

    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((item: any) => item.id),
      ['a', 'b', 'c']
    );
    assert.equal(calls.some((url) => url.includes('/opportunities/count?')), false);
    assert.equal(calls.some((url) => url.includes('page=0')), true);
    assert.equal(calls.some((url) => url.includes('page=1')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchMerklOpportunities keeps paging until page is short', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes('page=0')) {
      return new Response(JSON.stringify([{ id: 'a' }, { id: 'b' }]), { status: 200 });
    }

    if (url.includes('page=1')) {
      return new Response(JSON.stringify([{ id: 'c' }]), { status: 200 });
    }

    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await fetchMerklOpportunities({
      mainProtocolId: 'aave,tydro',
      status: 'LIVE',
      itemsPerPage: 2,
    });

    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((item: any) => item.id),
      ['a', 'b', 'c']
    );
    assert.equal(calls.some((url) => url.includes('page=1')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
