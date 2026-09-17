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
 * What it checks — deliberately narrow, so it stays high-signal:
 *
 * 1. `.github/workflows/<file>.yml` references point at a real file
 * 2. Backticked repo paths point at something that exists. A token with a `/`
 *    is resolved relative to the repo root; a **bare filename** (`analytics.ts`)
 *    is resolved against an index of every basename in the repo, because prose
 *    legitimately says "middleware `requestId.ts`" without spelling out the
 *    full path. The claim being checked is "a file with this name exists".
 * 3. `npm run <script>` / `npm <shorthand>` references resolve to a real script
 *    in the right package.json. The package is the one named by `-w <workspace>`
 *    / `--prefix <dir>`, otherwise the root. Workspace names are resolved
 *    through the root `workspaces` globs, so `-w @internal/aave-fetcher` finds
 *    `packages/aave-fetcher/package.json` — npm's own resolution, not a guess.
 *
 * What it deliberately does NOT check: whether a referenced workflow actually
 * runs. A scheduled workflow can exist on disk and still never fire if it is not
 * on the default branch — see the verified note in AGENTS.md. File existence is
 * not run history, and this check must not imply otherwise.
 *
 * Exemptions for cross-repo references are explicit and carry a reason
 * (EXEMPT_SCRIPTS below). Run with `--verbose` to see them listed, so a
 * deliberate exemption can never be mistaken for a silent pass.
 *
 * Runtime/generated paths (`logs/`, `data/`, `dist/`, `node_modules/` and the
 * agent scratch dirs) are skipped: they are gitignored artifacts, not part of
 * the documented surface, and `dist/` in particular can hold a stale copy of a
 * file that was deleted from source — exactly the false "still exists" signal
 * worth avoiding.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** Directories never walked when building the basename index. */
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

function isIgnoredPath(relative) {
  if (IGNORED_PREFIXES.some((prefix) => relative.startsWith(prefix)))
    return true;
  return IGNORED_SUFFIXES.some((suffix) => relative.endsWith(suffix));
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

/** Every basename in the repo, so a bare filename in prose can be resolved. */
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
 * Map every workspace name to its directory, using npm's own `workspaces` globs
 * from the root package.json (so `@internal/aave-fetcher` → `packages/aave-fetcher`).
 * Directory paths are mapped too, since `-w backend` is equally valid to npm.
 */
export function buildWorkspaceIndex(rootDir, readJson) {
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
    if (!existsSync(pkgPath)) continue;
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
 *             exemptions: Array<{ref: string, reason: string}> }}
 */
export function checkDrift({
  text,
  rootDir,
  exists,
  readJson,
  basenames,
  workspaceDirs,
}) {
  const findings = [];
  const exemptions = [];

  for (const file of extractWorkflowRefs(text)) {
    if (!exists(join(rootDir, ".github/workflows", file))) {
      findings.push({
        kind: "workflow",
        ref: `.github/workflows/${file}`,
        detail: "referenced workflow file does not exist",
      });
    }
  }

  for (const ref of extractPathRefs(text)) {
    if (PLACEHOLDER.test(ref)) continue;
    const resolved = ref.includes("/")
      ? exists(join(rootDir, ref))
      : basenames.has(ref);
    if (!resolved) {
      findings.push({
        kind: "path",
        ref,
        detail: ref.includes("/")
          ? "referenced path does not exist"
          : "no file with this name exists anywhere in the repo",
      });
    }
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

  return { findings, exemptions };
}

function main() {
  const verbose = process.argv.includes("--verbose");
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const text = readFileSync(join(ROOT, TARGET), "utf8");

  const { findings, exemptions } = checkDrift({
    text,
    rootDir: ROOT,
    exists: existsSync,
    readJson,
    basenames: buildBasenameIndex(ROOT),
    workspaceDirs: buildWorkspaceIndex(ROOT, readJson),
  });

  if (verbose && exemptions.length > 0) {
    console.log(`   ${exemptions.length} deliberate exemption(s):`);
    for (const exemption of exemptions) {
      console.log(`   [exempt] ${exemption.ref} — ${exemption.reason}`);
    }
  }

  if (findings.length > 0) {
    console.error(
      `❌ ${TARGET} drift — ${findings.length} stale reference(s):`
    );
    for (const finding of findings) {
      console.error(`   [${finding.kind}] ${finding.ref} — ${finding.detail}`);
    }
    process.exit(1);
  }

  console.log(
    `✓ ${TARGET} drift OK — all referenced files, workflows and scripts exist`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
