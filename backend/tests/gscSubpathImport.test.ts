import { test } from 'node:test';
import assert from 'node:assert/strict';

test('googleapis sub-path import: webmasters_v3 is available without full googleapis', async () => {
  const mod = await import('googleapis/build/src/apis/webmasters/v3.js');
  assert.ok(mod.webmasters_v3, 'webmasters_v3 should be exported from sub-path');
  assert.equal(typeof mod.webmasters_v3.Webmasters, 'function', 'Webmasters class should be a function');
});

test('googleapis sub-path import: JWT from google-auth-library is available', async () => {
  const { JWT } = await import('google-auth-library/build/src/auth/jwtclient.js');
  assert.equal(typeof JWT, 'function', 'JWT should be a function');
});

test('googleapis sub-path import: webmasters client has searchanalytics.query method', async () => {
  const mod = await import('googleapis/build/src/apis/webmasters/v3.js');
  const { JWT } = await import('google-auth-library/build/src/auth/jwtclient.js');
  const auth = new JWT({
    email: 'test@example.com',
    key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const client = new mod.webmasters_v3.Webmasters({ auth });
  assert.ok(client.searchanalytics, 'client should have searchanalytics property');
  assert.equal(typeof client.searchanalytics.query, 'function', 'searchanalytics.query should be a function');
});

test('gscService: getGscClient creates webmasters client with JWT auth', async () => {
  process.env.GSC_SA_EMAIL = 'test@example.com';
  process.env.GSC_SA_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\\ntest\\n-----END RSA PRIVATE KEY-----';

  const mod = await import('../src/services/gscService.js');
  mod.setGscClientForTest(null as any);
  const client = mod.getGscClient();

  assert.ok(client, 'getGscClient should return a client');
  assert.ok(client.searchanalytics, 'client should have searchanalytics');
  assert.equal(typeof client.searchanalytics.query, 'function', 'searchanalytics.query should be callable');

  delete process.env.GSC_SA_EMAIL;
  delete process.env.GSC_SA_PRIVATE_KEY;
  mod.setGscClientForTest(null as any);
});
