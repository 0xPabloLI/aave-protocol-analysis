/**
 * AGENTS.md drift check (scripts/check-agents-drift.mjs) — AAV-1290.
 *
 * The first version of this script reported 31 stale references against a clean
 * AGENTS.md, and every one was a false positive: bare filenames were resolved
 * against the repo root (`analytics.ts` does not exist at the root, but
 * `backend/src/analytics.ts` does) and `-w @internal/aave-fetcher` was resolved
 * as a literal directory instead of through npm's workspace map. Both rules are
 * pinned here, so the script cannot silently regress into noise — and cannot
 * silently stop catching the three real findings it made on day one either
 * (see the `checkDrift on the real AGENTS.md` case at the bottom).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBasenameIndex,
  buildWorkspaceIndex,
  checkDrift,
  extractPathRefs,
  extractScriptRefs,
  extractWorkflowRefs,
} from "../scripts/check-agents-drift.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── extraction ───────────────────────────────────────────────────────────────

test("extractPathRefs: repo-root paths and bare filenames, but not prose", () => {
  const refs = extractPathRefs(
    [
      "`docs/agents/harness.md`",
      "`backend/src/logger.ts`",
      "`requestId.ts`",
      "`src/cli.ts`",
      // Not paths:
      "`RuntimeReserveData`",
      "`npm run build`",
      "`https://example.com/x.ts`",
      "`docs/runbooks/`",
      "`logs/`",
      "`backend/logs/combined.log`",
      "`tests/*.test.ts`",
      "`some/dir`",
    ].join(" ")
  );

  assert.deepEqual(refs.sort(), [
    "backend/src/logger.ts",
    "docs/agents/harness.md",
    "requestId.ts",
    "src/cli.ts",
  ]);
});

test("extractPathRefs: workflow files belong to the workflow rule", () => {
  assert.deepEqual(extractPathRefs("`uptime-alert.yml`"), ["uptime-alert.yml"]);
  assert.deepEqual(
    extractPathRefs("`.github/workflows/uptime-alert.yml`"),
    [],
    "the workflow rule owns this ref and gives a more actionable message"
  );
});

test("extractScriptRefs: script name plus workspace selector", () => {
  assert.deepEqual(
    extractScriptRefs("`npm run test -w @internal/aave-fetcher`"),
    [
      {
        name: "test",
        workspace: "@internal/aave-fetcher",
        span: "npm run test -w @internal/aave-fetcher",
      },
    ]
  );

  assert.deepEqual(
    extractScriptRefs("`npm run profile:cpu -w aave-dashboard-backend`"),
    [
      {
        name: "profile:cpu",
        workspace: "aave-dashboard-backend",
        span: "npm run profile:cpu -w aave-dashboard-backend",
      },
    ]
  );

  assert.deepEqual(extractScriptRefs("`npm test --prefix workers`"), [
    { name: "test", workspace: "workers", span: "npm test --prefix workers" },
  ]);

  assert.deepEqual(extractScriptRefs("`npm run ci`"), [
    { name: "ci", workspace: undefined, span: "npm run ci" },
  ]);
});

test("extractScriptRefs: ignores prose that merely mentions npm", () => {
  // Real lines from AGENTS.md that must not be read as script invocations.
  assert.deepEqual(
    extractScriptRefs("`npm workspaces hoist all deps to root`"),
    []
  );
  assert.deepEqual(extractScriptRefs("`npm audit fix --omit=dev`"), []);
});

test("extractWorkflowRefs: finds the file whether or not it is backticked", () => {
  assert.deepEqual(
    extractWorkflowRefs(
      "see `.github/workflows/test-canary.yml` and .github/workflows/release.yml"
    ).sort(),
    ["release.yml", "test-canary.yml"]
  );
});

// ── workspace index (npm's own resolution) ───────────────────────────────────

test("buildWorkspaceIndex: package names and directory paths both resolve", () => {
  const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const index = buildWorkspaceIndex(REPO_ROOT, readJson) as Map<string, string>;

  // The exact mapping that was missing and produced false positives.
  assert.equal(index.get("@internal/aave-fetcher"), "packages/aave-fetcher");
  assert.equal(index.get("aave-dashboard-backend"), "backend");
  assert.equal(
    index.get("@internal/aave-shared-contracts"),
    "packages/aave-shared-contracts"
  );
  // Directory form is equally valid to npm.
  assert.equal(index.get("backend"), "backend");
});

test("buildBasenameIndex: skips generated trees so dist/ cannot fake existence", () => {
  const names = buildBasenameIndex(REPO_ROOT) as Set<string>;
  assert.ok(names.has("logger.ts"));
  assert.ok(names.has("AGENTS.md"));
  // backend/dist/ contains this file, but it was deleted from source — the whole
  // point of skipping dist/ is that a stale build must not look like a live file.
  assert.ok(!names.has("oracle-pool-configs.ts"));
});

// ── checkDrift ───────────────────────────────────────────────────────────────

const PKG = {
  ".": { scripts: { build: "tsc", "check:quality": "eslint ." } },
  backend: { scripts: { dev: "tsx watch src/server.ts" } },
  "packages/aave-fetcher": { scripts: { test: "tsx --test tests/*.test.ts" } },
};

function deps(text: string, overrides: Record<string, unknown> = {}) {
  return {
    text,
    rootDir: "/repo",
    // Mirrors the real tree: a workspace dir exists, and so does its package.json.
    exists: (path: string) => {
      const rel = path.replace(/^\/repo\/?/, "");
      if (rel === "") return true;
      const dir = rel.endsWith("/package.json")
        ? rel.slice(0, -"/package.json".length)
        : rel;
      return dir in PKG || rel in PKG;
    },
    readJson: (path: string) => {
      const rel = path.replace(/^\/repo\//, "").replace(/\/package\.json$/, "");
      return PKG[rel as keyof typeof PKG] ?? {};
    },
    basenames: new Set(["logger.ts", "requestId.ts"]),
    workspaceDirs: new Map([
      ["@internal/aave-fetcher", "packages/aave-fetcher"],
      ["aave-dashboard-backend", "backend"],
    ]),
    ...overrides,
  };
}

test("checkDrift: a bare filename is resolved by basename, not against the root", () => {
  const { findings } = checkDrift(deps("`requestId.ts`") as never);
  assert.deepEqual(
    findings,
    [],
    "requestId.ts exists under backend/src/middleware/"
  );
});

test("checkDrift: a bare filename missing everywhere is real drift", () => {
  const { findings } = checkDrift(deps("`ghost.ts`") as never);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ref, "ghost.ts");
  assert.match(findings[0].detail, /no file with this name exists anywhere/);
});

test("checkDrift: a path with a slash is resolved against the repo root", () => {
  const present = checkDrift(deps("`backend/package.json`") as never);
  assert.deepEqual(present.findings, []);

  const missing = checkDrift(deps("`tests/units.test.ts`") as never);
  assert.equal(missing.findings.length, 1);
  assert.equal(missing.findings[0].detail, "referenced path does not exist");
});

test("checkDrift: workspace scripts resolve through the workspace map", () => {
  const { findings } = checkDrift(
    deps("`npm run test -w @internal/aave-fetcher`") as never
  );
  assert.deepEqual(
    findings,
    [],
    "-w @internal/aave-fetcher → packages/aave-fetcher"
  );
});

test("checkDrift: an unknown workspace is drift, not a silent pass", () => {
  const { findings } = checkDrift(
    deps("`npm run test -w @internal/gone`") as never
  );
  assert.equal(findings.length, 1);
  assert.match(
    findings[0].detail,
    /is not a workspace in the root package\.json/
  );
});

test("checkDrift: a script missing from the resolved package.json is drift", () => {
  const { findings } = checkDrift(
    deps("`npm run deploy -w aave-dashboard-backend`") as never
  );
  assert.equal(findings.length, 1);
  assert.match(
    findings[0].detail,
    /script "deploy" is not defined in aave-dashboard-backend/
  );
});

test("checkDrift: exemptions are reported, never silent", () => {
  const { findings, exemptions } = checkDrift(
    deps("`npm run dev:staging`") as never
  );
  assert.deepEqual(findings, []);
  assert.equal(exemptions.length, 1);
  assert.match(exemptions[0].reason, /frontend repo/);

  // The exemption is scoped: `-w` pins it to this repo, so it must not apply.
  const scoped = checkDrift(
    deps("`npm run dev:staging -w aave-dashboard-backend`") as never
  );
  assert.equal(scoped.exemptions.length, 0);
  assert.equal(scoped.findings.length, 1);
});

test("checkDrift: missing workflow files are reported as workflow drift", () => {
  const { findings } = checkDrift(
    deps("`.github/workflows/ghost.yml`") as never
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "workflow");
});

test("checkDrift: placeholders and generated trees are not findings", () => {
  const { findings } = checkDrift(
    deps(
      "`TODO(AAV-123)` `tests/*.test.ts` `backend/logs/combined.log` `dist/x.js`"
    ) as never
  );
  assert.deepEqual(findings, []);
});

// ── the real thing ───────────────────────────────────────────────────────────

test("checkDrift on the real AGENTS.md: no stale references", () => {
  const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const { findings } = checkDrift({
    text: readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8"),
    rootDir: REPO_ROOT,
    exists: existsSync,
    readJson,
    basenames: buildBasenameIndex(REPO_ROOT),
    workspaceDirs: buildWorkspaceIndex(REPO_ROOT, readJson),
  } as never);

  assert.deepEqual(
    findings,
    [],
    `AGENTS.md references files/scripts that do not exist: ${JSON.stringify(findings, null, 2)}`
  );
});
