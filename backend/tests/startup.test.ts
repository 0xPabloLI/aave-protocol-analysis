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
  assert.match(packageJson, /"dev:reset":\s*"npm run dev:clean && npm run dev"/);
  assert.match(packageJson, /"dev:watch:reset":\s*"npm run dev:clean && npm run dev:watch"/);
});

test('dev entry script cleans residual backend processes before launching tsx', () => {
  const script = readFileSync(new URL('../scripts/dev-entry.sh', import.meta.url), 'utf8');

  assert.match(script, /bash scripts\/dev-clean\.sh/);
  assert.match(script, /exec .*tsx src\/server\.ts/);
  assert.match(script, /--watch\)/);
});

test('dev clean script also terminates tsx watch parents for this backend', () => {
  const script = readFileSync(new URL('../scripts/dev-clean.sh', import.meta.url), 'utf8');

  assert.match(script, /tsx\.\*src\/server\\\.ts/);
});
