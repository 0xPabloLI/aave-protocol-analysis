import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = resolve(__dirname, '..', 'src', 'services');

function listServiceFiles(): string[] {
  return readdirSync(SERVICES_DIR).filter((f) => f.endsWith('.ts'));
}

function readService(fileName: string): string {
  return readFileSync(resolve(SERVICES_DIR, fileName), 'utf-8');
}

test('no service file contains inline ABI literal (type: "function" in array)', () => {
  for (const file of listServiceFiles()) {
    const src = readService(file);
    const hasInline = src.includes("type: 'function'") || src.includes('type: "function"');
    assert.ok(!hasInline, `${file} contains inline ABI literal — import from abis/ or upstream instead`);
  }
});

test('no service file imports ABI from address-book root barrel (must use /abis/* deep path)', () => {
  const ROOT_IMPORT_RE = /from\s+['"]@aave-dao\/aave-address-book['"]/;
  for (const file of listServiceFiles()) {
    if (file === 'addressBookRegistry.ts') continue;
    const src = readService(file);
    assert.ok(!ROOT_IMPORT_RE.test(src), `${file} imports from address-book root — use /abis/* deep path for ABIs`);
  }
});
