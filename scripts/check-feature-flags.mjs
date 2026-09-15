#!/usr/bin/env node
/**
 * Dead feature-flag detection (works with the flag registry in
 * backend/src/flags.ts).
 *
 * Every flag exported by the registry must be referenced by at least one
 * consumer outside the registry itself (or by its own check/docs). A flag
 * that is defined but never consumed anywhere is dead and must be removed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const REGISTRY = join(ROOT, "backend/src/flags.ts");

const registrySrc = readFileSync(REGISTRY, "utf8");
const flagNames = [...registrySrc.matchAll(/get (\w+)\(/g)].map((m) => m[1]);

if (flagNames.length === 0) {
  console.error(
    "❌ No flags found in backend/src/flags.ts (unexpected file shape)"
  );
  process.exit(1);
}

const sources = [];
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        [
          "node_modules",
          "dist",
          ".git",
          ".wrangler",
          "logs",
          "coverage",
        ].includes(entry.name)
      )
        continue;
      walk(full);
    } else if (
      /\.(ts|mts|mjs|js)$/.test(entry.name) &&
      !full.endsWith("flags.ts")
    ) {
      sources.push(full);
    }
  }
}
walk(join(ROOT, "backend/src"));

const dead = [];
for (const flag of flagNames) {
  const used = sources.some((file) => {
    try {
      return readFileSync(file, "utf8").includes(`flags.${flag}`);
    } catch {
      return false;
    }
  });
  if (!used) dead.push(flag);
}

if (dead.length > 0) {
  console.error(
    `❌ Dead feature flags (defined in flags.ts, never consumed): ${dead.join(", ")}`
  );
  process.exit(1);
}

console.log(`✓ feature flags OK — ${flagNames.length} flags, all consumed`);
