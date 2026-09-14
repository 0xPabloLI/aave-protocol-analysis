#!/usr/bin/env node
/**
 * Tech-debt marker gate: TODO/FIXME comments must reference an issue key.
 *
 * Accepted format: TODO(AB-123) / FIXME(AB-123), where the issue key matches
 * [A-Z][A-Z0-9]+-\d+ (e.g. AAV-1234). Unlinked markers are tracked debt that
 * silently rot; linked markers stay actionable.
 *
 * Scans git-tracked source files only (respecting .gitignore), so generated
 * artifacts and untracked scratch files are excluded automatically.
 */
import { execFileSync } from "node:child_process";
import { exit } from "node:process";

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
// TODO/FIXME optionally followed by whitespace/`(`/`:` then an issue key.
// `TODO(AAV-123): text` and `FIXME(AAV-123) text` pass; `TODO: fix this` fails.
const UNLINKED_MARKER =
  /\b(?:TODO|FIXME)\b[\s(:]*?(?![\s:(]*\b[A-Z][A-Z0-9]+-\d+\b)/;

let files;
try {
  files = execFileSync("git", ["ls-files"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .filter((f) => SOURCE_EXT.test(f))
    // Exclude this scanner itself: its source intentionally contains literal
    // TODO/FIXME tokens (docs, regex, output strings) and would self-flag.
    .filter((f) => f !== "scripts/check-todo-format.mjs");
} catch (err) {
  console.error("check:todos: failed to list git-tracked files:", err.message);
  exit(1);
}

const violations = [];
for (const file of files) {
  let content;
  try {
    content = execFileSync("git", ["show", `HEAD:${file}`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    continue; // file staged for deletion or unreadable — skip
  }
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (UNLINKED_MARKER.test(line)) {
      violations.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    `✗ check:todos — ${violations.length} TODO/FIXME marker(s) without an issue key:\n`
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nFormat: TODO(AB-123) or FIXME(AB-123) — link the marker to its tracking issue."
  );
  exit(1);
}

console.log(
  `✓ check:todos — all TODO/FIXME markers reference an issue key (${files.length} files scanned)`
);
