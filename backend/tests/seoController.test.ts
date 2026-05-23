import { test } from 'node:test';
import assert from 'node:assert/strict';

test('buildGscQuery: empty groups returns detail query', async () => {
  const { buildGscQuery } = await import('../src/controllers/seoController.js');
  const result = buildGscQuery([]);
  assert.equal(result.hasGroupBy, false);
  assert.ok(result.sql.includes('date, country, page, query, clicks, impressions, ctr, position'));
});

test('buildGscQuery: single group returns aggregate', async () => {
  const { buildGscQuery } = await import('../src/controllers/seoController.js');
  const result = buildGscQuery(['country']);
  assert.equal(result.hasGroupBy, true);
  assert.ok(result.sql.includes('country'));
  assert.ok(result.sql.includes('SUM(clicks)'));
});

test('buildGscQuery: multiple groups', async () => {
  const { buildGscQuery } = await import('../src/controllers/seoController.js');
  const result = buildGscQuery(['date', 'country']);
  assert.equal(result.hasGroupBy, true);
  assert.ok(result.sql.includes('date, country'));
  assert.ok(result.sql.includes('SUM(clicks)'));
});

test('VALID_GROUP_BY contains expected values', async () => {
  const { VALID_GROUP_BY } = await import('../src/controllers/seoController.js');
  assert.deepEqual([...VALID_GROUP_BY], ['date', 'country', 'page', 'query']);
});

test('parseCountryList: single country', async () => {
  const { parseCountryList } = await import('../src/controllers/seoController.js');
  assert.deepEqual(parseCountryList('us'), ['us']);
});

test('parseCountryList: comma-separated countries', async () => {
  const { parseCountryList } = await import('../src/controllers/seoController.js');
  assert.deepEqual(parseCountryList('br,fr,tr,us,de,in'), ['br', 'fr', 'tr', 'us', 'de', 'in']);
});

test('parseCountryList: trims whitespace', async () => {
  const { parseCountryList } = await import('../src/controllers/seoController.js');
  assert.deepEqual(parseCountryList(' br , fr , us '), ['br', 'fr', 'us']);
});

test('parseCountryList: filters empty segments', async () => {
  const { parseCountryList } = await import('../src/controllers/seoController.js');
  assert.deepEqual(parseCountryList('us,,br,'), ['us', 'br']);
});

test('parseCountryList: caps at 20 entries', async () => {
  const { parseCountryList } = await import('../src/controllers/seoController.js');
  const input = Array.from({ length: 30 }, (_, i) => `c${i}`).join(',');
  const result = parseCountryList(input);
  assert.equal(result.length, 20);
  assert.equal(result[0], 'c0');
  assert.equal(result[19], 'c19');
});

test('escapeIlike: escapes % and _', async () => {
  const { escapeIlike } = await import('../src/utils/escapeIlike.js');
  assert.equal(escapeIlike('100%_free'), '100\\%\\_free');
});

test('escapeIlike: escapes backslash', async () => {
  const { escapeIlike } = await import('../src/utils/escapeIlike.js');
  assert.equal(escapeIlike('a\\b'), 'a\\\\b');
});

test('escapeIlike: no special chars', async () => {
  const { escapeIlike } = await import('../src/utils/escapeIlike.js');
  assert.equal(escapeIlike('aave'), 'aave');
});
