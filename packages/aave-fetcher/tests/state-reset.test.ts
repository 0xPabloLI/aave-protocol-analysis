import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resetMeritState } from '../src/merit-api.js';
import { resetMerklState } from '../src/merkl-api.js';

describe('merit-api state encapsulation', () => {
  it('exports resetMeritState as a function', () => {
    assert.equal(typeof resetMeritState, 'function');
  });

  it('resetMeritState does not throw', () => {
    assert.doesNotThrow(() => resetMeritState());
  });

  it('resetMeritState is idempotent', () => {
    resetMeritState();
    assert.doesNotThrow(() => resetMeritState());
  });
});

describe('merkl-api state encapsulation', () => {
  it('exports resetMerklState as a function', () => {
    assert.equal(typeof resetMerklState, 'function');
  });

  it('resetMerklState does not throw', () => {
    assert.doesNotThrow(() => resetMerklState());
  });

  it('resetMerklState is idempotent', () => {
    resetMerklState();
    assert.doesNotThrow(() => resetMerklState());
  });
});
