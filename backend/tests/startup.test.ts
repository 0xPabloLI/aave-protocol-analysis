import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { explainServerListenError } from '../src/startup.js';

test('explainServerListenError formats EADDRINUSE with actionable guidance', () => {
  const error = Object.assign(new Error('listen EADDRINUSE: address already in use :::3001'), {
    code: 'EADDRINUSE',
    port: 3001,
  });

  const message = explainServerListenError(error, 3001);

  assert.equal(
    message,
    '❌ Port 3001 is already in use. Another backend instance is probably still running. Stop the existing process or start this instance with a different PORT.'
  );
});

test('explainServerListenError returns null for unrelated server errors', () => {
  const error = Object.assign(new Error('boom'), { code: 'ECONNRESET' });

  assert.equal(explainServerListenError(error, 3001), null);
});

test('backend package exposes dev cleanup scripts', () => {
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

  assert.match(packageJson, /"dev:clean":\s*"bash scripts\/dev-clean\.sh"/);
  assert.match(packageJson, /"dev":\s*"bash scripts\/dev-entry\.sh"/);
  assert.match(packageJson, /"dev:watch":\s*"bash scripts\/dev-entry\.sh --watch"/);
  assert.match(packageJson, /"dev:reset":\s*"npm run dev"/);
  assert.match(packageJson, /"dev:watch:reset":\s*"npm run dev:watch"/);
});

test('dev entry script cleans residual backend processes before launching tsx', () => {
  const script = readFileSync(new URL('../scripts/dev-entry.sh', import.meta.url), 'utf8');

  assert.match(script, /bash scripts\/dev-clean\.sh/);
  assert.match(script, /tsx src\/server\.ts/);
  assert.match(script, /--watch\)/);
});

test('dev entry script has self-repair preflight for missing deps', () => {
  const script = readFileSync(new URL('../scripts/dev-entry.sh', import.meta.url), 'utf8');

  assert.match(script, /package\.json.*dependencies/, 'should read deps dynamically from package.json');
  assert.match(script, /require\.resolve/, 'should test deps via require.resolve');
  assert.match(script, /_needs_install/, 'should use install flag to gate npm install');
  assert.match(script, /_missing/, 'should report which deps are missing');
  assert.match(script, /npm install/, 'should run npm install when deps missing');
});

test('dev entry script has runtime self-repair loop on MODULE_NOT_FOUND', () => {
  const script = readFileSync(new URL('../scripts/dev-entry.sh', import.meta.url), 'utf8');

  assert.match(script, /_max_repair/, 'should define max repair attempts');
  assert.match(script, /_attempt/, 'should track attempt counter');
  assert.match(script, /_exit=\$\?/, 'should capture process exit code');
  assert.match(script, /runtime dep missing/, 'should log runtime dep missing');
  assert.match(script, /npm install.*attempt/, 'should reinstall on runtime failure');
});

test('dev clean script also terminates tsx watch parents for this backend', () => {
  const script = readFileSync(new URL('../scripts/dev-clean.sh', import.meta.url), 'utf8');

  assert.match(script, /tsx\.\*src\/server\\\.ts/);
});
