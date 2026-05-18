import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

describe('type de-duplication: MerklCampaignBreakdown single source of truth', () => {
  it('merkl-api.d.ts should re-export types from @internal/aave-shared-contracts', () => {
    const dtsPath = join(__dirname, '..', 'dist', 'merkl-api.d.ts');
    const dts = readFileSync(dtsPath, 'utf8');
    assert.ok(
      dts.includes("from '@internal/aave-shared-contracts'"),
      'merkl-api.d.ts should import/re-export from @internal/aave-shared-contracts'
    );
    assert.ok(
      !dts.includes('interface MerklCampaignBreakdown extends BaseCampaignBreakdown'),
      'merkl-api.d.ts should NOT contain local MerklCampaignBreakdown definition'
    );
  });

  it('index.d.ts should re-export MerklCampaignBreakdown from @internal/aave-shared-contracts', () => {
    const dtsPath = join(__dirname, '..', 'dist', 'index.d.ts');
    const dts = readFileSync(dtsPath, 'utf8');
    assert.ok(
      dts.includes("MerklCampaignBreakdown") && dts.includes("@internal/aave-shared-contracts"),
      'index.d.ts should re-export MerklCampaignBreakdown from shared-contracts'
    );
  });
});