#!/usr/bin/env node
/**
 * Test naming convention check.
 *
 * Convention: every test file lives in a `tests/` directory and is named `*.test.ts`.
 * Rejects: `.spec.ts` files, `test-*.ts` / `test_*.ts` prefixes, `__tests__/` dirs,
 * and test files placed outside a `tests/` directory (e.g. next to sources), and
 * any test file whose extension the runner globs would not pick up.
 *
 * Aligned with the repo rule "no double-star-slash glob in test scripts" — runners use
 * `tsx --test tests/*.test.ts`, so files outside `tests/` would silently
 * never run.
 *
 * Every extension a test file could carry is collected, not just `.ts`: a
 * `.test.mjs` under `.github/scripts/` used to be invisible to this check and
 * passed for months while covering nothing (AAV-1294).
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".wrangler",
  ".codeartsdoer",
  ".playwright-cli",
  "coverage",
  "repro-dist",
  "repro-src",
  "reports",
]);

// Anything that looks like a test file, whatever its extension. Only `.test.ts`
// is ever run, so every other match below is a violation rather than a pass.
const TEST_FILE_RE = /\.(test|spec)\.(ts|mts|cts|tsx|mjs|cjs|js|jsx)$/;

const violations = [];
const seen = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      if (TEST_FILE_RE.test(entry.name)) {
        seen.push(join(dir, entry.name));
      }
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    walk(join(dir, entry.name));
  }
}

walk(ROOT);

const TEST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.test\.ts$/;

for (const file of seen) {
  const rel = relative(ROOT, file);
  const base = file.split(sep).pop();
  const inTestsDir = rel.split(sep).includes("tests");

  if (!inTestsDir) {
    violations.push(
      `${rel} — test file outside a tests/ directory (runner glob tests/*.test.ts will never pick it up)`
    );
    continue;
  }
  if (base.endsWith(".spec.ts")) {
    violations.push(`${rel} — use *.test.ts, not *.spec.ts`);
    continue;
  }
  if (/^test[-_]/.test(base)) {
    violations.push(
      `${rel} — use suffix naming (foo.test.ts), not prefix (test-foo.ts)`
    );
    continue;
  }
  if (!TEST_NAME_RE.test(base)) {
    violations.push(
      `${rel} — does not match tests/*.test.ts naming convention`
    );
  }
}

if (violations.length > 0) {
  console.error(`❌ test naming violations (${violations.length}):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(
  `✓ test naming OK — ${seen.length} test files, all match tests/*.test.ts`
);
