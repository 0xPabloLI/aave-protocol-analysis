import test from 'node:test';
import assert from 'node:assert/strict';

import { isCampaignWhitelistOnly } from '../src/merkl-api.js';

test('isCampaignWhitelistOnly returns false when whitelist is empty', () => {
  assert.equal(
    isCampaignWhitelistOnly({
      params: { whitelist: [] },
    }),
    false
  );
});

test('isCampaignWhitelistOnly returns true when top-level whitelist has entries', () => {
  assert.equal(
    isCampaignWhitelistOnly({
      params: { whitelist: ['0x123'] },
    }),
    true
  );
});

test('isCampaignWhitelistOnly returns true when composed campaign whitelist has entries', () => {
  assert.equal(
    isCampaignWhitelistOnly({
      params: {
        whitelist: [],
        composedCampaigns: [
          {
            campaignParameters: {
              whitelist: ['0xabc'],
            },
          },
        ],
      },
    }),
    true
  );
});
