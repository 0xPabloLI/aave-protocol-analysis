/**
 * Schema fingerprint snapshot test.
 *
 * When the API response shape changes (fields added/removed/renamed
 * in serializeReserveForApi), the fingerprint changes and this test
 * FAILS. This prevents merging schema changes without acknowledging
 * the need to bump CACHE_VERSION in the frontend.
 *
 * If this test fails and the change is intentional:
 *   1. Bump CACHE_VERSION in aaveapy/src/lib/cache.ts
 *   2. Update the expected fingerprint below
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchemaFingerprint } from '../src/services/marketsApiSerialize.js';

// ⚠️  UPDATE this value when you intentionally change the API response shape.
// Also run: npm run gen:schema-fp -w aave-dashboard-backend
// and sync the value to aaveapy/src/shared/schema-fingerprint.ts
const EXPECTED_FINGERPRINT = '2fde56319b7d';

test('API schema fingerprint matches expected value', () => {
  const current = computeSchemaFingerprint();
  assert.strictEqual(
    current,
    EXPECTED_FINGERPRINT,
    [
      '',
      '🚨 API response shape changed!',
      `   Expected fingerprint: ${EXPECTED_FINGERPRINT}`,
      `   Current fingerprint:  ${current}`,
      '',
      '   If this change is intentional:',
      '   1. Update EXPECTED_FINGERPRINT in this test (below)',
      '   2. Run: npm run gen:schema-fp -w aave-dashboard-backend',
      '      (this regenerates packages/aave-shared-config/schema-fingerprint.ts)',
      '   3. Sync to frontend: copy the value to',
      '      aaveapy/src/shared/schema-fingerprint.ts',
      '',
    ].join('\n'),
  );
});