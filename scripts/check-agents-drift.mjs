#!/usr/bin/env node
/**
 * AGENTS.md drift check (AAV-1290).
 *
 * AGENTS.md is the entry point every agent reads first, so a stale line there is
 * worse than a stale line anywhere else: it makes agents hunt for files that do
 * not exist and trust commands that are not wired. Until now the only guard was
 * someone noticing — this repo already shipped a real example (the
 * address-book refactor removed `oracle-pool-configs.ts` and listed
 * "update AGENTS.md" as a task, and the line was still there months later). That
 * exact line is what this script now catches.
 *
 * ## Source of truth: git-tracked files
 *
 * A reference is satisfied only by a file that a **fresh clone** would have.
 * This is not a detail — the first version resolved against the local
 * filesystem, passed on the author's machine, and failed in CI on the same
 * commit, because `.cursor/skills/web-access/SKILL.md` exists here (it is a
 * symlink into `~/.agents/skills`) but is gitignored, so CI never sees it. Any
 * check whose answer depends on untracked or ignored files is not transferable
 * from a laptop to CI, and a gate that disagrees with CI is worse than no gate.
 *
 * So:
 *   - tracked file            → reference resolves
 *   - gitignored path         → skipped as *environment-provided* (local tools,
 *                               build output). Listed by `--verbose` so the
 *                               exemption is visible rather than silent
 *   - untracked, not ignored  → drift: a fresh clone will not have it
 *
 * When git is unavailable the script degrades to the filesystem.
 *
 * ## What it checks — deliberately narrow, so it stays high-signal
 *
 * 1. `.github/workflows/<file>.yml` references point at a real file
 * 2. Backticked repo paths point at something that exists. A token with a `/`
 *    is resolved relative to the repo root; a **bare filename** (`analytics.ts`)
 *    is resolved against an index of every basename in the tracked tree, because
 *    prose legitimately says "middleware `requestId.ts`" without spelling out the
 *    full path. The claim being checked is "a file with this name exists".
 * 3. `npm run <script>` / `npm <shorthand>` references resolve to a real script
 *    in the right package.json. The package is the one named by `-w <workspace>`
 *    / `--prefix <dir>`, otherwise the root. Workspace names are resolved
 *    through the root `workspaces` globs, so `-w @internal/aave-fetcher` finds
 *    `packages/aave-fetcher/package.json` — npm's own resolution, not a guess.
 *
 * `dist/` is never walked: a stale build tree can hold a copy of a file that was
 * deleted from source, which is exactly the false "still exists" signal worth
 * avoiding (it was live here — `dist/merit-api.js` outlived `src/merit-api.ts`).
 *
 * What it deliberately does NOT check: whether a referenced workflow actually
 * runs. A scheduled workflow can exist on disk and still never fire if it is not
 * on the default branch — see the verified note in AGENTS.md. File existence is
 * not run history, and this check must not imply otherwise.
 *
 * Exemptions for cross-repo references are explicit and carry a reason
 * (EXEMPT_SCRIPTS below). Run with `--verbose` to see them listed, so a
 * deliberate exemption can never be mistaken for a silent pass.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "AGENTS.md";

/** Paths that are runtime/generated rather than part of the documented tree. */
const IGNORED_PREFIXES = [
  "backend/logs/",
  "logs/",
  "data/",
  "dist/",
  "node_modules/",
  ".workbuddy/",
];

/** Files whose absence is normal in a working tree. */
const IGNORED_SUFFIXES = [".log", ".heapsnapshot", ".tsbuildinfo"];

/** Tokens that are placeholders rather than literal references. */
const PLACEHOLDER = /[<>{}$*]|\.\.\.|\bN\b/;

/** Repo-root directories a backticked token may start with and still be a path. */
const PATH_PREFIXES = [
  "docs",
  "packages",
  "backend",
  "scripts",
  "src",
  "tests",
  "aaveapy-doc",
  ".github",
  ".cursor",
];

/** Directories never walked when building the basename index (fs fallback). */
const WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "repro-dist",
  "logs",
  "data",
  ".workbuddy",
  ".codeartsdoer",
  ".opencode",
  "coverage",
]);

/**
 * Scripts that intentionally run in a *different* repo. Keep this list tiny and
 * always give a reason — an unexplained miss is a finding, not an exemption.
 */
const EXEMPT_SCRIPTS = new Map([
  [
    "dev:staging",
    "frontend dev server — runs in the aaveapy frontend repo, not this workspace",
  ],
]);

function isIgnoredPath(relativePath) {
  if (IGNORED_PREFIXES.some((prefix) => relativePath.startsWith(prefix)))
    return true;
  return IGNORED_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

function isWorkflowFile(token) {
  return /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(token);
}

/**
 * Backticked tokens that are unambiguously repo paths: a known repo-root prefix,
 * a `.github/workflows/*.yml` file, or a bare filename with a known extension.
 * A bare `foo/bar` could be anything, so it is not matched.
 */
export function extractPathRefs(text) {
  const refs = new Set();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim();
    if (!token || PLACEHOLDER.test(token) || token.includes(" ")) continue;
    if (token.startsWith("http") || token.startsWith("#")) continue;
    if (token.endsWith("/") || token.endsWith("/**")) continue;
    // Workflow files get their own rule with a more actionable message.
    if (isWorkflowFile(token)) continue;

    const looksLikePath =
      PATH_PREFIXES.some((prefix) => token.startsWith(`${prefix}/`)) ||
      /^[\w.-]+\.(md|ts|mts|mjs|js|json|sh|yml|yaml|cjs)$/.test(token);
    if (!looksLikePath) continue;
    if (isIgnoredPath(token)) continue;
    refs.add(token);
  }
  return [...refs];
}

/**
 * `npm run <script>` and the built-in shorthands, together with the workspace
 * selector that appears in the same code span (`` `npm run x -w y` ``).
 */
export function extractScriptRefs(text) {
  const refs = [];
  for (const match of text.matchAll(/`([^`\n]*npm [^`\n]+)`/g)) {
    const span = match[1];
    const script = /\bnpm run ([\w:.-]+)/.exec(span);
    const shorthand = /\bnpm (test|build|ci|dev|start)\b/.exec(span);
    const name = script?.[1] ?? shorthand?.[1];
    if (!name) continue;

    const workspace =
      /\s-w\s+([\w@/.-]+)/.exec(span)?.[1] ??
      /\s--prefix\s+([\w@/.-]+)/.exec(span)?.[1];
    refs.push({ name, workspace, span: span.trim() });
  }
  return refs;
}

/** `.github/workflows/<file>.yml` mentioned anywhere (backticked or not). */
export function extractWorkflowRefs(text) {
  const refs = new Set();
  for (const match of text.matchAll(/\.github\/workflows\/([\w.-]+\.ya?ml)/g)) {
    refs.add(match[1]);
  }
  return [...refs];
}

/**
 * Every git-tracked path in the repo. `null` when git cannot answer (not a
 * repo, no git binary), which makes every caller fall back to the filesystem.
 */
export function gitTrackedPaths(rootDir) {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: rootDir,
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.toString("utf8").split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

/** Basename index derived from a tracked-path set (see buildBasenameIndex). */
export function basenamesFromPaths(paths) {
  return new Set(
    [...paths].map((path) => path.slice(path.lastIndexOf("/") + 1))
  );
}

/**
 * Directory paths implied by the tracked files. Git stores files only, so
 * "does `packages/aave-fetcher` exist?" has to be answered as "does the clone
 * contain anything under it?" — which is also the only answer that cannot
 * disagree between a laptop and CI.
 */
export function directoriesFromPaths(paths) {
  const dirs = new Set();
  for (const path of paths) {
    let index = path.lastIndexOf("/");
    while (index > 0) {
      dirs.add(path.slice(0, index));
      index = path.lastIndexOf("/", index - 1);
    }
  }
  return dirs;
}

/**
 * Existence predicate over the tracked set. Falls back to the filesystem only
 * when git could not answer at all.
 */
export function makeTrackedExists(rootDir, tracked) {
  if (!tracked) return existsSync;
  const dirs = directoriesFromPaths(tracked);
  return (path) => {
    const rel = relative(rootDir, path).split("\\").join("/");
    return rel === "" || tracked.has(rel) || dirs.has(rel);
  };
}

/** Every basename in the tree — filesystem fallback when git is unavailable. */
export function buildBasenameIndex(rootDir) {
  const basenames = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        basenames.add(entry.name);
      }
    }
  };
  walk(rootDir);
  return basenames;
}

/**
 * "This path is borrowed from the local environment, not from the repo."
 * Returns a reason, or null when the path is genuinely expected to be tracked.
 *
 * The symlink branch is real: `.cursor/skills` is a symlink into
 * `~/.agents/skills`, and `git check-ignore` refuses to classify anything past
 * it ("beyond a symbolic link"), so git's error *is* the answer — the path
 * leaves the working tree.
 */
export function makeClassifier(rootDir, tracked) {
  if (!tracked) return () => null;
  return (path) => {
    if (tracked.has(path)) return null;
    try {
      execFileSync("git", ["check-ignore", "-q", "--", path], {
        cwd: rootDir,
        stdio: "pipe",
      });
      return "gitignored in this repo";
    } catch (error) {
      // exit 1 = not ignored, so a missing path here is real drift.
      if (error?.status === 1) return null;
      if (/symbolic link|outside repository/i.test(String(error?.stderr))) {
        return "resolved through a symlink pointing outside the working tree";
      }
      return null;
    }
  };
}

/**
 * Map every workspace name to its directory, using npm's own `workspaces` globs
 * from the root package.json (so `@internal/aave-fetcher` → `packages/aave-fetcher`).
 * Directory paths are mapped too, since `-w backend` is equally valid to npm.
 */
export function buildWorkspaceIndex(rootDir, readJson, exists = existsSync) {
  const index = new Map();
  const patterns = readJson(join(rootDir, "package.json"))?.workspaces ?? [];

  const dirs = [];
  for (const pattern of patterns) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      dirs.push(pattern);
      continue;
    }
    const base = pattern.slice(0, star).replace(/\/$/, "");
    let entries;
    try {
      entries = readdirSync(join(rootDir, base), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(base, entry.name));
    }
  }

  for (const dir of dirs) {
    const pkgPath = join(rootDir, dir, "package.json");
    if (!exists(pkgPath)) continue;
    const name = readJson(pkgPath)?.name;
    if (name) index.set(name, dir);
    index.set(dir, dir);
  }
  return index;
}

function resolveWorkspaceDir(workspace, rootDir, exists, workspaceDirs) {
  const fromIndex = workspaceDirs.get(workspace);
  if (fromIndex) return fromIndex;
  // `-w packages/foo` / `-w backend` spelled as a path rather than a name.
  if (exists(join(rootDir, workspace, "package.json"))) return workspace;
  return null;
}

/**
 * Collect every drift finding. Pure apart from the injected readers, so the
 * rules can be tested without touching the real repo.
 *
 * @returns {{ findings: Array<{kind: string, ref: string, detail: string}>,
 *             exemptions: Array<{ref: string, reason: string}>,
 *             environmentProvided: Array<{ref: string, reason: string}> }}
 */
export function checkDrift({
  text,
  rootDir,
  exists,
  readJson,
  basenames,
  workspaceDirs,
  classify,
}) {
  const findings = [];
  const exemptions = [];
  const environmentProvided = [];
  const envReason = (path) => (classify ? classify(path) : null);

  for (const file of extractWorkflowRefs(text)) {
    const ref = `.github/workflows/${file}`;
    if (exists(join(rootDir, ref))) continue;
    const reason = envReason(ref);
    if (reason) {
      environmentProvided.push({ ref, reason });
      continue;
    }
    findings.push({
      kind: "workflow",
      ref,
      detail: "referenced workflow file does not exist",
    });
  }

  for (const ref of extractPathRefs(text)) {
    if (PLACEHOLDER.test(ref)) continue;
    if (ref.includes("/") ? exists(join(rootDir, ref)) : basenames.has(ref)) {
      continue;
    }

    if (!ref.includes("/")) {
      findings.push({
        kind: "path",
        ref,
        detail: "no file with this name exists anywhere in the tracked tree",
      });
      continue;
    }

    const reason = envReason(ref);
    if (reason) {
      environmentProvided.push({ ref, reason });
      continue;
    }
    findings.push({
      kind: "path",
      ref,
      detail: "referenced path does not exist",
    });
  }

  for (const ref of extractScriptRefs(text)) {
    const reason = EXEMPT_SCRIPTS.get(ref.name);
    if (reason && !ref.workspace) {
      exemptions.push({ ref: ref.span, reason });
      continue;
    }

    const dir = ref.workspace
      ? resolveWorkspaceDir(ref.workspace, rootDir, exists, workspaceDirs)
      : ".";
    if (dir === null) {
      findings.push({
        kind: "script",
        ref: ref.span,
        detail: `-w ${ref.workspace} is not a workspace in the root package.json`,
      });
      continue;
    }

    const pkgPath = join(rootDir, dir, "package.json");
    const scripts = readJson(pkgPath)?.scripts ?? {};
    if (!(ref.name in scripts)) {
      findings.push({
        kind: "script",
        ref: ref.span,
        detail: `script "${ref.name}" is not defined in ${
          ref.workspace ?? "the root"
        } package.json`,
      });
    }
  }

  return { findings, exemptions, environmentProvided };
}

function main() {
  const verbose = process.argv.includes("--verbose");
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const text = readFileSync(join(ROOT, TARGET), "utf8");

  // Git-tracked truth when available — the same input CI has. Falling back to
  // the filesystem would let a gitignored local file satisfy a reference.
  const tracked = gitTrackedPaths(ROOT);
  const exists = makeTrackedExists(ROOT, tracked);

  const { findings, exemptions, environmentProvided } = checkDrift({
    text,
    rootDir: ROOT,
    exists,
    readJson,
    basenames: tracked ? basenamesFromPaths(tracked) : buildBasenameIndex(ROOT),
    workspaceDirs: buildWorkspaceIndex(ROOT, readJson, exists),
    classify: makeClassifier(ROOT, tracked),
  });

  const source = tracked
    ? `git-tracked files (${tracked.size})`
    : "the local filesystem (git unavailable)";

  if (verbose) {
    for (const item of environmentProvided) {
      console.log(
        `   [local-only] ${item.ref} — ${item.reason}; not required of a fresh clone`
      );
    }
    for (const exemption of exemptions) {
      console.log(`   [exempt] ${exemption.ref} — ${exemption.reason}`);
    }
  }

  if (findings.length > 0) {
    console.error(
      `❌ ${TARGET} drift — ${findings.length} stale reference(s) (checked against ${source}):`
    );
    for (const finding of findings) {
      console.error(`   [${finding.kind}] ${finding.ref} — ${finding.detail}`);
    }
    process.exit(1);
  }

  console.log(
    `✓ ${TARGET} drift OK — every referenced file, workflow and script exists (checked against ${source})`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
