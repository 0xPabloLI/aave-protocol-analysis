#!/usr/bin/env node
/**
 * Prettier format gate (AAV-1347) — `npm run check:prettier`.
 *
 * Formats are only fixed when a file is touched, because `lint-staged` can only
 * format what is staged. A 227-file drift accumulated that way before
 * `dc77f32` normalised it; this gate stops the same drift from rebuilding.
 *
 * Design notes that the guard tests pin:
 *
 *   - The file list is `git ls-files -z`, never a directory walk. Untracked
 *   build output, `data/` and local scratch are invisible here exactly as they
 *   are in CI, so "green locally / red in CI" cannot come from the file list.
 *   This is the same source-of-truth rule `check-agents-drift` adopted after it
 *   passed on a laptop and failed on the same commit in CI.
 *   - Tracked symlinks (`.agents/skills`, `aaveapy-doc`) are skipped: prettier
 *   refuses explicit symlink arguments and exits 1, which would make the gate
 *   permanently red for a reason unrelated to formatting.
 *   - `--ignore-unknown` keeps `.sh`, `.sql`, `LICENSE` and friends from failing
 *   with "No parser could be inferred".
 *   - `.prettierignore` stays the single source for generated files
 *   (`backend/static/openapi.json`, `schema-fingerprint.ts`). Prettier applies
 *   it to explicitly listed files too.
 *   - `--list-different` prints only the offending paths; the report wraps them
 *   with an actionable fix command.
 *   - Exit codes are layered: 0 clean, 1 formatting violation, 2 tooling error.
 *     An empty file list exits 2 rather than reporting a pass — a gate that
 *     checks nothing must never look green.
 *
 * `PRETTIER_BIN` lets the guard tests and the clean-checkout verification reuse
 * this repo's pinned prettier instead of installing dependencies in a throwaway
 * clone. `PRETTIER_CHUNK_SIZE` exists for the batching test only.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { exit } from "node:process";

import {
  chunkFiles,
  EXIT,
  formatEmptyListReport,
  formatFailureReport,
  formatSuccessLine,
  formatToolingErrorReport,
  selectFormattableFiles,
} from "./lib/prettier-gate.mjs";

const DEFAULT_CHUNK_SIZE = 200;

/**
 * @param {string} reason
 * @returns {never}
 */
function failTooling(reason) {
  console.error(formatToolingErrorReport(reason));
  exit(EXIT.tooling);
}

/** @returns {string} */
function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    return failTooling(`not inside a git work tree (${error.message})`);
  }
}

/** @param {string} root @returns {string} */
function trackedPaths(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    return failTooling(`git ls-files failed (${error.message})`);
  }
}

/** @returns {number} */
function chunkSize() {
  const raw = Number.parseInt(process.env.PRETTIER_CHUNK_SIZE ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHUNK_SIZE;
}

const root = repoRoot();
const paths = trackedPaths(root)
  .split("\0")
  .filter((item) => item.length > 0);

const entries = paths.map((item) => {
  try {
    const stats = lstatSync(path.join(root, item));
    return { path: item, exists: true, isSymlink: stats.isSymbolicLink() };
  } catch {
    return { path: item, exists: false, isSymlink: false };
  }
});

const selection = selectFormattableFiles(entries);

if (selection.checkable.length === 0) {
  console.error(formatEmptyListReport());
  exit(EXIT.tooling);
}

const bin = path.resolve(
  root,
  process.env.PRETTIER_BIN ??
    path.join("node_modules", "prettier", "bin", "prettier.cjs")
);
if (!existsSync(bin)) {
  failTooling(`prettier binary not found at ${bin} (run \`npm ci\`)`);
}

/** @type {string[]} */
const failures = [];
for (const batch of chunkFiles(selection.checkable, chunkSize())) {
  const result = spawnSync(
    process.execPath,
    [bin, "--list-different", "--ignore-unknown", ...batch],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );

  if (result.error) {
    failTooling(`failed to run prettier (${result.error.message})`);
  }
  if (result.status === 0) continue;
  if (result.status === 1) {
    const listed = (result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    failures.push(...(listed.length > 0 ? listed : batch));
    continue;
  }
  failTooling(
    `prettier exited ${result.status}: ${(result.stderr || result.stdout || "").trim().slice(0, 500)}`
  );
}

if (failures.length > 0) {
  console.error(formatFailureReport([...new Set(failures)]));
  exit(EXIT.formatting);
}

console.log(
  formatSuccessLine({
    checked: selection.checkable.length,
    skippedSymlinks: selection.skippedSymlinks,
    skippedMissing: selection.skippedMissing,
  })
);
