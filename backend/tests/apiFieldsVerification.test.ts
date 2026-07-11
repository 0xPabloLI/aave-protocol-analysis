import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const OLD_FIELD_NAMES = [
  'reserveSize', 'totalVariableDebt', 'availableLiquidity',
  'reserveFactor', 'variableRateSlope1', 'variableRateSlope2',
  'optimalUsageRate', 'baseVariableBorrowRate',
] as const;

const NEW_FIELD_NAMES = [
  'supplied', 'borrowed', 'liquidity',
  'protocolFee', 'slopeBelowOptimal', 'slopeAboveOptimal',
  'optimalUtilization', 'baseBorrowRate',
] as const;

interface MarketsResponse {
  snapshot: { version: string };
  reserves: Array<Record<string, unknown>>;
}

const API_URL = process.env.API_FIELDS_TEST_URL
  ?? 'https://staging-api.aaveapy.com/api/markets';

function fetchMarkets(): MarketsResponse | null {
  try {
    const raw = execSync(`curl -sf --max-time 30 "${API_URL}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(raw) as MarketsResponse;
  } catch (err) {
    console.error(`Failed to fetch ${API_URL}:`, String(err));
    return null;
  }
}

test('API fields v3 — snapshot version is markets-v3', { skip: !process.env.RUN_API_FIELDS_TESTS }, () => {
  const data = fetchMarkets();
  if (!data) {
    assert.fail(`Could not fetch API at ${API_URL}`);
  }
  assert.equal(
    data.snapshot.version,
    'markets-v3',
    `Expected version 'markets-v3' but got '${data.snapshot.version}'`,
  );
});

test('API fields v3 — no old field names leaked in any reserve', { skip: !process.env.RUN_API_FIELDS_TESTS }, () => {
  const data = fetchMarkets();
  if (!data) {
    assert.fail(`Could not fetch API at ${API_URL}`);
  }

  const leakedFields = new Set<string>();
  for (const reserve of data.reserves) {
    for (const field of OLD_FIELD_NAMES) {
      if (field in reserve) {
        leakedFields.add(field);
        if (leakedFields.size <= 5) {
          console.warn(`  OLD field '${field}' found in reserve ${reserve.reserveId}`);
        }
      }
    }
  }
  assert.deepStrictEqual(
    [...leakedFields],
    [],
    `Old field names still present in API response: [${[...leakedFields].join(', ')}]`,
  );
});

test('API fields v3 — new field names present in at least 90% of reserves', { skip: !process.env.RUN_API_FIELDS_TESTS }, () => {
  const data = fetchMarkets();
  if (!data) {
    assert.fail(`Could not fetch API at ${API_URL}`);
  }

  const total = data.reserves.length;
  assert.ok(total > 0, 'No reserves in response');

  const fieldCoverage: Record<string, number> = {};
  for (const field of NEW_FIELD_NAMES) {
    fieldCoverage[field] = 0;
  }
  for (const reserve of data.reserves) {
    for (const field of NEW_FIELD_NAMES) {
      if (field in reserve) fieldCoverage[field]++;
    }
  }

  for (const field of NEW_FIELD_NAMES) {
    const pct = Math.round((fieldCoverage[field] / total) * 100);
    assert.ok(
      pct >= 90,
      `Field '${field}' only present in ${pct}% of reserves (${fieldCoverage[field]}/${total}). Expected >= 90%`,
    );
  }
});