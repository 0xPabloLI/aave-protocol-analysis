/**
 * Prettier quality gate (AAV-1347) — `scripts/check-prettier-format.mjs`.
 *
 * The gate exists to stop format drift from re-accumulating after `dc77f32`
 * normalised 227 tracked files in one go. Three families of failure are pinned
 * here because each of them would make the gate lie:
 *
 *   - the naive command dies on tracked symlinks (`.agents/skills`,
 *     `aaveapy-doc`) and would be red forever;
 *   - an empty file list would report success while checking nothing (the
 *     AAV-1294/1330/1349/1352 false-green family);
 *   - wiring that never reaches CI (`check:prettier` defined but not invoked)
 *     is the "added but not connected" shape this repo keeps shipping.
 *
 * Behaviour cases run the real entry point as a subprocess against throwaway
 * git repositories with the real prettier binary, so they exercise the same
 * paths CI does without mocking either tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  chunkFiles,
  formatEmptyListReport,
  formatFailureReport,
  formatSuccessLine,
  formatToolingErrorReport,
  selectFormattableFiles,
} from "../scripts/lib/prettier-gate.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const gateScript = path.join(repoRoot, "scripts", "check-prettier-format.mjs");
const prettierBin = path.join(
  repoRoot,
  "node_modules",
  "prettier",
  "bin",
  "prettier.cjs"
);

const CLEAN_TS = 'const answer = { value: 42, label: "x" };\n';
const BAD_TS = "const answer = {value:42,label:'x'}\n";

type Repo = { dir: string; git: (...args: string[]) => void };

/** Throwaway git repo; `files` are written and `git add`ed, nothing is committed. */
function makeRepo(files: Record<string, string> = {}): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), "prettier-gate-"));
  const git = (...args: string[]) => {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
  };
  git("init", "-q");
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git("add", "-A");
  return { dir, git };
}

function runGate(
  cwd: string,
  env: Record<string, string> = {}
): { status: number | null; output: string } {
  const res = spawnSync(process.execPath, [gateScript], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PRETTIER_BIN: prettierBin, ...env },
  });
  return { status: res.status, output: `${res.stdout}\n${res.stderr}` };
}

// ── pure functions ──────────────────────────────────────────────────────────

test("selectFormattableFiles: drops tracked symlinks and missing paths", () => {
  const picked = selectFormattableFiles([
    { path: "src/index.ts", exists: true, isSymlink: false },
    { path: ".agents/skills", exists: true, isSymlink: true },
    { path: "docs/gone.md", exists: false, isSymlink: false },
  ]);
  assert.deepEqual(picked.checkable, ["src/index.ts"]);
  assert.equal(picked.skippedSymlinks, 1);
  assert.equal(picked.skippedMissing, 1);
});

test("selectFormattableFiles: keeps every ordinary file in order", () => {
  const entries = ["b.ts", "a.md", "z.json"].map((p) => ({
    path: p,
    exists: true,
    isSymlink: false,
  }));
  const picked = selectFormattableFiles(entries);
  assert.deepEqual(picked.checkable, ["b.ts", "a.md", "z.json"]);
  assert.equal(picked.skippedSymlinks, 0);
  assert.equal(picked.skippedMissing, 0);
});

test("chunkFiles: splits without losing or duplicating entries", () => {
  assert.deepEqual(chunkFiles(["a", "b", "c", "d", "e"], 2), [
    ["a", "b"],
    ["c", "d"],
    ["e"],
  ]);
  assert.deepEqual(chunkFiles([], 2), []);
  assert.deepEqual(chunkFiles(["a"], 2), [["a"]]);
});

test("chunkFiles: a non-positive size still yields a usable batch size", () => {
  assert.deepEqual(chunkFiles(["a", "b"], 0), [["a", "b"]]);
});

test("formatFailureReport: count, files and a runnable fix command", () => {
  const report = formatFailureReport(["src/a.ts", "docs/b.md"]);
  assert.match(report, /2 file\(s\)/);
  assert.match(report, /- src\/a\.ts/);
  assert.match(report, /- docs\/b\.md/);
  assert.match(report, /prettier --write/);
  assert.match(report, /check:prettier/);
});

test("formatEmptyListReport: an empty check is a failure, not a pass", () => {
  const report = formatEmptyListReport();
  assert.match(report, /no tracked files/i);
  assert.match(report, /check:prettier/);
});

test("formatToolingErrorReport: names the reason and the gate", () => {
  const report = formatToolingErrorReport("prettier is not installed");
  assert.match(report, /prettier is not installed/);
  assert.match(report, /check:prettier/);
});

test("formatSuccessLine: reports what was checked and what was skipped", () => {
  const line = formatSuccessLine({
    checked: 459,
    skippedSymlinks: 2,
    skippedMissing: 0,
  });
  assert.match(line, /459 tracked file/);
  assert.match(line, /2 symlink/);
  assert.match(line, /0 missing/);
});

// ── entry point behaviour (real git + real prettier) ────────────────────────

test("passes when every tracked file is formatted", () => {
  const { dir } = makeRepo({ "a.ts": CLEAN_TS, "b.md": "# Title\n" });
  const { status, output } = runGate(dir);
  assert.equal(status, 0, output);
  assert.match(output, /formatted/i);
  rmSync(dir, { recursive: true, force: true });
});

test("fails and names the offending file", () => {
  const { dir } = makeRepo({ "a.ts": CLEAN_TS, "bad.ts": BAD_TS });
  const { status, output } = runGate(dir);
  assert.equal(status, 1, output);
  assert.match(output, /bad\.ts/);
  assert.doesNotMatch(output, /- a\.ts/);
  rmSync(dir, { recursive: true, force: true });
});

test("skips tracked symlinks instead of erroring on them", () => {
  const { dir, git } = makeRepo({ "real.ts": CLEAN_TS });
  symlinkSync(path.join(dir, "real.ts"), path.join(dir, "linked.ts"));
  git("add", "linked.ts");
  const { status, output } = runGate(dir);
  assert.equal(status, 0, output);
  assert.match(output, /1 symlink/);
  rmSync(dir, { recursive: true, force: true });
});

test("ignores untracked files entirely (clean-checkout parity)", () => {
  const { dir } = makeRepo({ "a.ts": CLEAN_TS });
  writeFileSync(path.join(dir, "untracked.ts"), BAD_TS);
  const { status } = runGate(dir);
  assert.equal(status, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("honours .prettierignore for generated files", () => {
  const { dir } = makeRepo({
    ".prettierignore": "generated.json\n",
    "generated.json": '{"a":1}\n',
    "a.ts": CLEAN_TS,
  });
  const { status, output } = runGate(dir);
  assert.equal(status, 0, output);
  rmSync(dir, { recursive: true, force: true });
});

test("ignores files without a prettier parser", () => {
  const { dir } = makeRepo({ "deploy.sh": "if [ 1 ];then   echo hi;fi\n" });
  const { status, output } = runGate(dir);
  assert.equal(status, 0, output);
  rmSync(dir, { recursive: true, force: true });
});

test("skips index entries whose working-tree file is gone", () => {
  const { dir } = makeRepo({ "a.ts": CLEAN_TS, "deleted.ts": BAD_TS });
  rmSync(path.join(dir, "deleted.ts"));
  const { status, output } = runGate(dir);
  assert.equal(status, 0, output);
  assert.match(output, /1 missing/);
  rmSync(dir, { recursive: true, force: true });
});

test("fails loudly when there is nothing to check", () => {
  const { dir } = makeRepo();
  const { status, output } = runGate(dir);
  assert.equal(status, 2, output);
  assert.match(output, /no tracked files/i);
  rmSync(dir, { recursive: true, force: true });
});

test("fails loudly outside a git repository", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prettier-gate-nogit-"));
  const { status, output } = runGate(dir);
  assert.equal(status, 2, output);
  assert.match(output, /git/i);
  rmSync(dir, { recursive: true, force: true });
});

test("fails loudly when prettier itself is unavailable", () => {
  const { dir } = makeRepo({ "a.ts": CLEAN_TS });
  const { status, output } = runGate(dir, {
    PRETTIER_BIN: path.join(dir, "no-such-prettier.cjs"),
  });
  assert.equal(status, 2, output);
  assert.match(output, /prettier/i);
  rmSync(dir, { recursive: true, force: true });
});

test("handles paths with spaces and non-ASCII characters", () => {
  const { dir } = makeRepo({ "中文 文件.ts": BAD_TS });
  const { status, output } = runGate(dir);
  assert.equal(status, 1, output);
  assert.match(output, /中文 文件\.ts/);
  rmSync(dir, { recursive: true, force: true });
});

test("checks every batch and reports only the bad files", () => {
  const { dir } = makeRepo({
    "a.ts": CLEAN_TS,
    "b.ts": CLEAN_TS,
    "c.ts": BAD_TS,
    "d.md": "# ok\n",
  });
  const { status, output } = runGate(dir, { PRETTIER_CHUNK_SIZE: "1" });
  assert.equal(status, 1, output);
  assert.match(output, /- c\.ts/);
  assert.doesNotMatch(output, /- a\.ts/);
  assert.doesNotMatch(output, /- b\.ts/);
  rmSync(dir, { recursive: true, force: true });
});

// ── wiring guards ───────────────────────────────────────────────────────────

test("check:quality runs check:prettier, and check:prettier runs the real script", () => {
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8")
  ) as { scripts: Record<string, string> };
  assert.equal(
    pkg.scripts["check:prettier"],
    "node scripts/check-prettier-format.mjs"
  );
  assert.match(pkg.scripts["check:quality"], /npm run check:prettier/);
  assert.ok(existsSync(gateScript));
  assert.ok(
    existsSync(path.join(repoRoot, "scripts", "lib", "prettier-gate.mjs"))
  );
});

test("the CI quality-gates job actually invokes check:prettier", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8"
  );
  const qualityGates = workflow.slice(workflow.indexOf("  quality-gates:"));
  const job = qualityGates.slice(
    0,
    qualityGates.indexOf("  auto-revert-on-failure:")
  );
  assert.match(job, /npm run check:prettier/);
});

test("AGENTS.md documents the new gate", () => {
  const agents = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /npm run check:prettier/);
  assert.match(agents, /scripts\/check-prettier-format\.mjs/);
});

test("the gate scripts are git-tracked, so a fresh clone can run them", () => {
  // `scripts/*` is gitignored with an explicit whitelist. A script that only
  // exists on the author's machine passes every local run and dies in CI — the
  // exact failure mode `check-agents-drift` was built for (AAV-1290).
  const res = spawnSync(
    "git",
    [
      "ls-files",
      "scripts/check-prettier-format.mjs",
      "scripts/lib/prettier-gate.mjs",
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
  const tracked = res.stdout.trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(tracked, [
    "scripts/check-prettier-format.mjs",
    "scripts/lib/prettier-gate.mjs",
  ]);
});

test("the gate stays read-only: pre-commit does not invoke it", () => {
  const hook = readFileSync(
    path.join(repoRoot, ".husky", "pre-commit"),
    "utf8"
  );
  assert.doesNotMatch(hook, /check:prettier/);
  const lintStaged = readFileSync(path.join(repoRoot, ".lintstagedrc"), "utf8");
  assert.doesNotMatch(lintStaged, /check-prettier-format/);
});
