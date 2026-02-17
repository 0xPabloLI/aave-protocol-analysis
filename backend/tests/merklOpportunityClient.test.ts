import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchMerklOpportunities } from '../src/services/merklOpportunityClient.js';

test('fetchMerklOpportunities paginates by count endpoint and merges pages', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes('/opportunities/count?')) {
      return new Response('3', { status: 200 });
    }

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
    assert.equal(calls.some((url) => url.includes('/opportunities/count?')), true);
    assert.equal(calls.some((url) => url.includes('page=0')), true);
    assert.equal(calls.some((url) => url.includes('page=1')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchMerklOpportunities falls back to first page when count endpoint fails', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/opportunities/count?')) {
      return new Response('error', { status: 500 });
    }

    return new Response(JSON.stringify([{ id: 'only' }]), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await fetchMerklOpportunities({
      mainProtocolId: 'aave,tydro',
      status: 'LIVE',
      itemsPerPage: 100,
    });

    assert.equal(result.length, 1);
    assert.equal((result[0] as any).id, 'only');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
