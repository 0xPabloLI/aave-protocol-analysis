import test from 'node:test';
import assert from 'node:assert/strict';

import { EthProviderService } from '../src/services/ethProviderService.js';

test('suppresses unhealthy RPC endpoints and prefers healthy candidates', () => {
  const service = new EthProviderService({
    failureThreshold: 2,
    suppressionMs: 60_000,
    now: () => 1_000,
  });

  const chainId = 1;
  const urls = ['https://rpc-a.example', 'https://rpc-b.example'];

  service.reportProviderFailure(chainId, urls[0], 'timeout');
  let candidates = service.getProvidersForChain(chainId, urls).map((item) => item.rpcUrl);
  assert.deepEqual(candidates, urls);

  service.reportProviderFailure(chainId, urls[0], 'timeout');
  candidates = service.getProvidersForChain(chainId, urls).map((item) => item.rpcUrl);
  assert.deepEqual(candidates, [urls[1], urls[0]]);
});

test('restores endpoint priority after success', () => {
  const service = new EthProviderService({
    failureThreshold: 1,
    suppressionMs: 60_000,
    now: () => 1_000,
  });

  const chainId = 1;
  const urls = ['https://rpc-a.example', 'https://rpc-b.example'];

  service.reportProviderFailure(chainId, urls[0], 'timeout');
  let candidates = service.getProvidersForChain(chainId, urls).map((item) => item.rpcUrl);
  assert.deepEqual(candidates, [urls[1], urls[0]]);

  service.reportProviderSuccess(chainId, urls[0]);
  candidates = service.getProvidersForChain(chainId, urls).map((item) => item.rpcUrl);
  assert.deepEqual(candidates, urls);
});

test('surfaces unhealthy endpoint diagnostics', () => {
  const now = 10_000;
  const service = new EthProviderService({
    failureThreshold: 1,
    suppressionMs: 120_000,
    now: () => now,
  });

  service.reportProviderFailure(137, 'https://polygon-rpc.example', 'rpc method is not whitelisted');
  const unhealthy = service.getUnhealthyEndpoints();
  assert.equal(unhealthy.length, 1);
  assert.equal(unhealthy[0].chainId, 137);
  assert.equal(unhealthy[0].rpcUrl, 'https://polygon-rpc.example');
  assert.match(unhealthy[0].lastError, /whitelisted/i);
  assert.equal(unhealthy[0].suppressedUntil, new Date(now + 120_000).toISOString());
});
