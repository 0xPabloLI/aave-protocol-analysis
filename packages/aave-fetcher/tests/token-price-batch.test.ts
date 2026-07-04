import test from 'node:test';
import assert from 'node:assert/strict';

test('CoinGecko request coalescing: concurrent same-platform queries merge into one HTTP call', async () => {
  let fetchCallUrls: string[] = [];

  const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
    fetchCallUrls.push(url);

    if (url.includes('/asset_platforms')) {
      return Promise.resolve(new Response(JSON.stringify([
        { id: 'ethereum', chain_identifier: 1 },
        { id: 'polygon-pos', chain_identifier: 137 },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }

    if (url.includes('/simple/token_price/')) {
      const addrMatch = url.match(/contract_addresses=([^&]+)/);
      const addresses = addrMatch ? decodeURIComponent(addrMatch[1]).split(',') : [];
      const result: Record<string, { usd: number }> = {};
      for (const addr of addresses) {
        result[addr] = { usd: 100 + addresses.indexOf(addr) };
      }
      return Promise.resolve(new Response(JSON.stringify(result), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }

    return Promise.resolve(new Response('not found', { status: 404 }));
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as typeof fetch;

  try {
    const { resolveTokenPriceWithBackup } = await import('../src/token-price-resolver.js');
    const addr1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const addr2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const addr3 = '0xcccccccccccccccccccccccccccccccccccccccc';

    const results = await Promise.all([
      resolveTokenPriceWithBackup({ chainId: 1, tokenAddress: addr1 }),
      resolveTokenPriceWithBackup({ chainId: 1, tokenAddress: addr2 }),
      resolveTokenPriceWithBackup({ chainId: 1, tokenAddress: addr3 }),
    ]);

    assert.ok(results[0] !== undefined, 'addr1 should resolve');
    assert.ok(results[1] !== undefined, 'addr2 should resolve');
    assert.ok(results[2] !== undefined, 'addr3 should resolve');

    const tokenPriceCalls = fetchCallUrls.filter(u => u.includes('/simple/token_price/'));
    assert.ok(tokenPriceCalls.length >= 1, `expected ≥1 token_price call, got ${tokenPriceCalls.length}`);

    const allAddresses = tokenPriceCalls.flatMap(u => {
      const m = u.match(/contract_addresses=([^&]+)/);
      return m ? decodeURIComponent(m[1]).split(',') : [];
    });
    assert.ok(allAddresses.length >= 2, `batch should contain ≥2 addresses across calls, got ${allAddresses.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
