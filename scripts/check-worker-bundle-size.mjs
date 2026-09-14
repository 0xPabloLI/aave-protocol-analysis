#!/usr/bin/env node
/**
 * Heavy-dependency guard for the Cloudflare Worker (workers/).
 *
 * Runs `wrangler deploy --dry-run` (builds the worker bundle locally, no
 * upload/auth needed) and fails if the gzipped bundle size exceeds the
 * budget. Keeps accidental heavy dependencies out of the deploy artifact.
 *
 * Workers hard limit is 10 MiB gzipped (paid plan); the budget below is the
 * agreed guardrail — raise it deliberately, never by accident.
 */
import { spawnSync } from "node:child_process";
import { exit } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BUDGET_KB = 3 * 1024; // 3 MiB gzipped
const workersDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "workers"
);

const result = spawnSync(
  "npx",
  [
    "--no-install",
    "wrangler",
    "deploy",
    "--dry-run",
    "--outdir",
    ".wrangler/bundle-check",
  ],
  { cwd: workersDir, encoding: "utf8", shell: process.platform === "win32" }
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

if (result.status !== 0) {
  console.error("✗ check:worker-bundle — wrangler dry-run build failed:\n");
  console.error(output.slice(-4000));
  exit(1);
}

const gzipMatch = output.match(/gzip:\s*([\d.]+)\s*(KiB|MiB)/i);
if (!gzipMatch) {
  console.error(
    "✗ check:worker-bundle — could not parse bundle size from wrangler output:\n"
  );
  console.error(output.slice(-4000));
  exit(1);
}

const value = Number.parseFloat(gzipMatch[1]);
const gzipKb = gzipMatch[2].toLowerCase() === "mib" ? value * 1024 : value;

console.log(
  `Worker bundle: ${value} ${gzipMatch[2]} gzipped (budget ${BUDGET_KB / 1024} MiB)`
);
if (gzipKb > BUDGET_KB) {
  console.error(
    `✗ check:worker-bundle — bundle ${gzipMatch[1]} ${gzipMatch[2]} gzipped exceeds the ${BUDGET_KB / 1024} MiB budget. ` +
      "Audit new dependencies (knip/depcheck) before raising the budget."
  );
  exit(1);
}

console.log("✓ check:worker-bundle — within budget");
