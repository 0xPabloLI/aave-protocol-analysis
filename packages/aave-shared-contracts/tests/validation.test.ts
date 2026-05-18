import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXPECTED_RUNTIME_FIELDS, validateRuntimeReserveShape } from '../dist/index.js';

describe('EXPECTED_RUNTIME_FIELDS', () => {
  it('should contain all required fields', () => {
    const requiredFields = [
      'reserveId', 'marketName', 'chainName', 'chainId',
      'tokenName', 'tokenSymbol', 'tokenAddress',
    ];
    for (const field of requiredFields) {
      assert.ok(
        EXPECTED_RUNTIME_FIELDS.includes(field),
        `EXPECTED_RUNTIME_FIELDS must include ${field}`
      );
    }
  });

  it('should be a readonly array', () => {
    assert.ok(Array.isArray(EXPECTED_RUNTIME_FIELDS));
    assert.ok(EXPECTED_RUNTIME_FIELDS.length > 40, `Expected >40 fields, got ${EXPECTED_RUNTIME_FIELDS.length}`);
  });
});

describe('validateRuntimeReserveShape', () => {
  it('should return empty array for a complete mock reserve', () => {
    const mock = Object.fromEntries(
      EXPECTED_RUNTIME_FIELDS.map(f => [f, f === 'reserveId' ? 'test-id' : f === 'chainId' ? 1 : f === 'marketName' ? 'main' : null])
    );
    const missing = validateRuntimeReserveShape(mock);
    assert.deepStrictEqual(missing, []);
  });

  it('should report missing fields for an empty object', () => {
    const missing = validateRuntimeReserveShape({});
    assert.ok(missing.length > 0, 'Expected missing fields for empty object');
    assert.ok(missing.includes('reserveId'));
    assert.ok(missing.includes('chainId'));
  });

  it('should report specific missing fields', () => {
    const partial = { reserveId: 'x', chainId: 1 };
    const missing = validateRuntimeReserveShape(partial);
    assert.ok(!missing.includes('reserveId'), 'reserveId should not be missing');
    assert.ok(!missing.includes('chainId'), 'chainId should not be missing');
    assert.ok(missing.includes('marketName'), 'marketName should be missing');
  });
});