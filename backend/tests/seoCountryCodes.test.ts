import { test } from 'node:test';
import assert from 'node:assert/strict';

test('GSC_TO_SEMRUSH maps 6 countries correctly', async () => {
  const { GSC_TO_SEMRUSH } = await import('../src/utils/seoCountryCodes.js');
  assert.equal(GSC_TO_SEMRUSH.bra, 'br');
  assert.equal(GSC_TO_SEMRUSH.fra, 'fr');
  assert.equal(GSC_TO_SEMRUSH.tur, 'tr');
  assert.equal(GSC_TO_SEMRUSH.usa, 'us');
  assert.equal(GSC_TO_SEMRUSH.deu, 'de');
  assert.equal(GSC_TO_SEMRUSH.ind, 'in');
  assert.equal(Object.keys(GSC_TO_SEMRUSH).length, 6);
});

test('SEMRUSH_TO_GSC reverses GSC_TO_SEMRUSH', async () => {
  const { SEMRUSH_TO_GSC } = await import('../src/utils/seoCountryCodes.js');
  assert.equal(SEMRUSH_TO_GSC.br, 'bra');
  assert.equal(SEMRUSH_TO_GSC.fr, 'fra');
  assert.equal(SEMRUSH_TO_GSC.tr, 'tur');
  assert.equal(SEMRUSH_TO_GSC.us, 'usa');
  assert.equal(SEMRUSH_TO_GSC.de, 'deu');
  assert.equal(SEMRUSH_TO_GSC.in, 'ind');
  assert.equal(Object.keys(SEMRUSH_TO_GSC).length, 6);
});

test('unknown key returns undefined', async () => {
  const { GSC_TO_SEMRUSH, SEMRUSH_TO_GSC } = await import('../src/utils/seoCountryCodes.js');
  assert.equal(GSC_TO_SEMRUSH.xyz, undefined);
  assert.equal(SEMRUSH_TO_GSC.xyz, undefined);
});
