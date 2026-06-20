import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isV4HubOpportunity } from '../src/merkl-api.js';

describe('isV4HubOpportunity', () => {
  it('returns true for AAVE_V4_HUB_SUPPLY', () => {
    assert.equal(isV4HubOpportunity('AAVE_V4_HUB_SUPPLY'), true);
  });

  it('returns true for AAVE_V4_HUB_BORROW', () => {
    assert.equal(isV4HubOpportunity('AAVE_V4_HUB_BORROW'), true);
  });

  it('returns true for any AAVE_V4_HUB_ prefix', () => {
    assert.equal(isV4HubOpportunity('AAVE_V4_HUB_SOMETHING_ELSE'), true);
  });

  it('returns false for AAVE_V4_SPOKE_SUPPLY', () => {
    assert.equal(isV4HubOpportunity('AAVE_V4_SPOKE_SUPPLY'), false);
  });

  it('returns false for AAVE_V4_SPOKE_BORROW', () => {
    assert.equal(isV4HubOpportunity('AAVE_V4_SPOKE_BORROW'), false);
  });

  it('returns false for V3 opportunity types', () => {
    assert.equal(isV4HubOpportunity('AAVE_NET_LENDING'), false);
    assert.equal(isV4HubOpportunity('AAVE_SUPPLY'), false);
    assert.equal(isV4HubOpportunity('ERC20_MAPPING'), false);
  });

  it('returns false for undefined type', () => {
    assert.equal(isV4HubOpportunity(undefined), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isV4HubOpportunity(''), false);
  });

  it('is case-sensitive — lowercase does not match', () => {
    assert.equal(isV4HubOpportunity('aave_v4_hub_supply'), false);
  });

  it('returns false for partial match without trailing underscore', () => {
    assert.equal(isV4HubOpportunity('AAVE_V4_HUB'), false);
    assert.equal(isV4HubOpportunity('AAVE_V4_HUBB'), false);
  });
});
