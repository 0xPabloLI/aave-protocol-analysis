import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('withTimeout uses AbortController to abort fetch on timeout (prevents socket leak)', () => {
  const src = readFileSync(
    new URL('../../packages/aave-fetcher/src/cloudflare-browser.ts', import.meta.url),
    'utf8'
  );
  assert.ok(
    src.includes('AbortController') || src.includes('AbortSignal'),
    'withTimeout should use AbortController/AbortSignal for request abortion'
  );
});

test('all CLOUDFLARE_WORKER_URL fetch calls include signal option', () => {
  const src = readFileSync(
    new URL('../../packages/aave-fetcher/src/cloudflare-browser.ts', import.meta.url),
    'utf8'
  );
  const lines = src.split('\n');
  const fetchStartLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('fetch(CLOUDFLARE_WORKER_URL')) {
      fetchStartLines.push(i);
    }
  }
  assert.ok(fetchStartLines.length > 0, 'Should find at least one CLOUDFLARE_WORKER_URL fetch call');

  for (const startLine of fetchStartLines) {
    const block = lines.slice(startLine, startLine + 15).join('\n');
    assert.ok(
      block.includes('signal'),
      `fetch call at line ${startLine + 1} should include signal option within next 15 lines`
    );
  }
});
