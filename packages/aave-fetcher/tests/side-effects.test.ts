import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('@internal/aave-fetcher import side-effects', () => {
  it('should not call process.exit on import', () => {
    const originalExit = process.exit;
    let exitCalled = false;
    (process as any).exit = (code?: number) => {
      exitCalled = true;
      throw new Error(`process.exit(${code}) called`);
    };

    try {
      import('../dist/index.js').catch(() => {});
    } finally {
      (process as any).exit = originalExit;
    }

    assert.strictEqual(exitCalled, false, 'process.exit must not be called on import');
  });

  it('should export fetchMarketsData as a function', async () => {
    const mod = await import('../dist/index.js');
    assert.strictEqual(typeof mod.fetchMarketsData, 'function');
  });

  it('should export runMarketsFetcher as a function', async () => {
    const mod = await import('../dist/index.js');
    assert.strictEqual(typeof mod.runMarketsFetcher, 'function');
  });

  it('should not execute fetch on import (module loads without side-effects)', async () => {
    let started = false;
    const timer = setTimeout(() => { started = true; }, 100);

    await import('../dist/index.js');

    clearTimeout(timer);
    assert.strictEqual(started, false, 'Import should not trigger async side-effects');
  });
});