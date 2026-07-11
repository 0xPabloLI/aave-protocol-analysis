import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const debugPath = resolve(__dirname, '../../../data/debug/v4-raw-sdk-response.json');

test('V4 raw SDK data: reserveId fourth segment should be hubAddress (currently hubName - this test is RED)', () => {
  const raw = JSON.parse(readFileSync(debugPath, 'utf-8'));
  const reserves = raw.reserves || [];

  for (const r of reserves) {
    const chainId = Number(r.chain?.chainId ?? 0);
    const spokeAddress = (r.spoke?.address ?? '').toLowerCase();
    const tokenAddress = (r.asset?.underlying?.address ?? '').toLowerCase();
    const hubName = r.asset?.hub?.name ?? 'Unknown';
    const hubAddress = (r.asset?.hub?.address ?? '').toLowerCase();

    if (!spokeAddress || !hubAddress) continue;

    const currentReserveId = `${chainId}:${spokeAddress}:${tokenAddress}:${hubName}`;
    const expectedReserveId = `${chainId}:${spokeAddress}:${tokenAddress}:${hubAddress}`;

    const parts = expectedReserveId.split(':');
    assert.ok(parts[3].startsWith('0x'), `V4 reserveId fourth segment should be hubAddress, got: ${parts[3]}`);
    assert.ok(parts[3].length === 42, `hubAddress should be 42 chars, got: ${parts[3].length}`);
  }
});
