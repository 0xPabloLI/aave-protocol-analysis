/**
 * Pure helpers for the Prettier format gate (AAV-1347).
 *
 * Kept separate from the entry point so the tests can exercise the decisions
 * without spawning a process, and so importing them never scans the repo.
 *
 * The gate's contract:
 *   - inputs come from `git ls-files` only, never from a directory walk;
 *   - tracked symlinks are skipped (prettier refuses them and would be red
 *     forever on `.agents/skills` / `aaveapy-doc`);
 *   - an empty check is a failure, not a pass.
 */

/** Exit codes, so CI logs can tell a format violation from a broken tool. */
export const EXIT = Object.freeze({
  ok: 0,
  formatting: 1,
  tooling: 2,
});

/**
 * @typedef {object} FileEntry
 * @property {string} path repo-relative path
 * @property {boolean} exists whether the working-tree file is present
 * @property {boolean} isSymlink whether lstat says it is a symbolic link
 *
 * @typedef {object} FormattableSelection
 * @property {string[]} checkable
 * @property {number} skippedSymlinks
 * @property {number} skippedMissing
 */

/**
 * Decide which tracked paths can be handed to prettier.
 *
 * `isSymlink` is recorded from `lstat`, because `git ls-files` happily lists a
 * tracked symlink and prettier then exits 1 with "Explicitly specified pattern
 * ... is a symbolic link". `exists: false` covers a staged deletion: git still
 * lists the path, prettier cannot open it.
 *
 * @param {FileEntry[]} entries
 * @returns {FormattableSelection}
 */
export function selectFormattableFiles(entries) {
  /** @type {string[]} */
  const checkable = [];
  let skippedSymlinks = 0;
  let skippedMissing = 0;
  for (const entry of entries) {
    if (entry.isSymlink) {
      skippedSymlinks += 1;
    } else if (!entry.exists) {
      skippedMissing += 1;
    } else {
      checkable.push(entry.path);
    }
  }
  return { checkable, skippedSymlinks, skippedMissing };
}

/**
 * Split a file list into batches so a pathological tree cannot overflow the
 * argument vector. A non-positive size falls back to the default, so callers
 * cannot accidentally disable batching.
 *
 * @template T
 * @param {T[]} files
 * @param {number} [size]
 * @returns {T[][]}
 */
export function chunkFiles(files, size = 200) {
  const batchSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : 200;
  /** @type {T[][]} */
  const batches = [];
  for (let start = 0; start < files.length; start += batchSize) {
    batches.push(files.slice(start, start + batchSize));
  }
  return batches;
}

/**
 * @param {string[]} files
 * @returns {string}
 */
export function formatFailureReport(files) {
  const listed = files.map((file) => `  - ${file}`).join("\n");
  return [
    `✗ check:prettier — ${files.length} file(s) are not Prettier-formatted:`,
    listed,
    "",
    "Fix: npx prettier --write <files> (or `npx prettier --write .` for the whole tree)",
    "pre-commit's lint-staged only formats files you staged; untouched files keep their old formatting until this gate catches them.",
  ].join("\n");
}

/**
 * @param {{ checked: number, skippedSymlinks: number, skippedMissing: number }} counts
 * @returns {string}
 */
export function formatSuccessLine(counts) {
  return (
    `✓ check:prettier — ${counts.checked} tracked file(s) formatted` +
    ` (${counts.skippedSymlinks} symlink(s) skipped,` +
    ` ${counts.skippedMissing} missing skipped)`
  );
}

/**
 * @returns {string}
 */
export function formatEmptyListReport() {
  return [
    "✗ check:prettier — `git ls-files` returned no tracked files; refusing to report success on an empty check.",
    "This is an environment problem (wrong directory, broken checkout), not a formatting pass.",
  ].join("\n");
}

/**
 * @param {string} reason
 * @returns {string}
 */
export function formatToolingErrorReport(reason) {
  return [
    `✗ check:prettier — environment error: ${reason}`,
    "This is a tooling failure, not a formatting violation (exit 2).",
  ].join("\n");
}
