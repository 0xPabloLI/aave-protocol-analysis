import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isV4SpokeOpportunity } from '../src/merkl-api.js';

describe('isV4SpokeOpportunity', () => {
  it('returns true for AAVE_V4_SPOKE_SUPPLY', () => {
    assert.equal(isV4SpokeOpportunity('AAVE_V4_SPOKE_SUPPLY'), true);
  });

  it('returns true for AAVE_V4_SPOKE_BORROW', () => {
    assert.equal(isV4SpokeOpportunity('AAVE_V4_SPOKE_BORROW'), true);
  });

  it('returns true for any AAVE_V4_SPOKE_ prefix', () => {
    assert.equal(isV4SpokeOpportunity('AAVE_V4_SPOKE_SOMETHING_ELSE'), true);
  });

  it('returns false for AAVE_V4_HUB_SUPPLY', () => {
    assert.equal(isV4SpokeOpportunity('AAVE_V4_HUB_SUPPLY'), false);
  });

  it('returns false for AAVE_V4_HUB_BORROW', () => {
    assert.equal(isV4SpokeOpportunity('AAVE_V4_HUB_BORROW'), false);
  });

  it('returns false for V3 opportunity types', () => {
    assert.equal(isV4SpokeOpportunity('AAVE_NET_LENDING'), false);
    assert.equal(isV4SpokeOpportunity('AAVE_SUPPLY'), false);
    assert.equal(isV4SpokeOpportunity('ERC20_MAPPING'), false);
  });

  it('returns false for undefined type', () => {
    assert.equal(isV4SpokeOpportunity(undefined), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isV4SpokeOpportunity(''), false);
  });

  it('is case-sensitive — lowercase does not match', () => {
    assert.equal(isV4SpokeOpportunity('aave_v4_spoke_supply'), false);
  });

  it('returns false for partial match without trailing underscore', () => {
    assert.equal(isV4SpokeOpportunity('AAVE_V4_SPOKE'), false);
    assert.equal(isV4SpokeOpportunity('AAVE_V4_SPOKEE'), false);
  });
});
