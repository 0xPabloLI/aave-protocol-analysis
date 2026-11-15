/**
 * `.husky/pre-commit` must not report success when one of its gates failed.
 *
 * husky runs the hook as `sh -e .husky/pre-commit` (see `.husky/_/h`), so errexit is
 * on. That is *not* enough on its own: a failing command inside an `&&`/`||` list
 * stays silent unless it is the command after the final operator, and the last line
 * of the hook decides the exit code. The sibling repo shipped exactly that bug in
 * pre-push (AAV-1330) and had to debug it from the outside, so this repo pins the
 * behaviour instead of trusting the shape:
 *
 *   - statically: every `npm run` line must carry an explicit `|| { ...; exit 1; }`
 *   - behaviourally: the *real hook file* runs under `sh -e` against stubbed
 *     `npm`/`npx`/`bash`, so a failing build or a failing `lint-staged` has to
 *     produce a non-zero status even though later phases pass.
 *
 * `npm`/`npx`/`bash` are the only commands stubbed; `git`, `wc`, `grep` and friends
 * still resolve to the real binaries, so the large-file guard runs as written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const hookPath = path.join(repoRoot, ".husky", "pre-commit");
const hookSource = readFileSync(hookPath, "utf8");

type Plan = {
  /** exit code for `npm run <script>`; unknown scripts exit 0 */
  npm?: Record<string, number>;
  /** exit code for `npx <bin>` */
  npx?: number;
};

/**
 * Run the real hook under `sh -e` inside a throwaway git repo with stubs on PATH.
 * Returns the hook's exit status plus what the stubs were asked to do.
 */
function runHook(plan: Plan): { status: number | null; calls: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "hookgate-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const calls: string[] = [];

  const npmArms = Object.entries(plan.npm ?? {})
    .map(([script, code]) => `  ${JSON.stringify(script)}) exit ${code} ;;`)
    .join("\n");
  const npmStub = `#!/bin/sh
echo "npm $*" >> "$CALL_LOG"
if [ "$1" = "run" ]; then
  case "$2" in
${npmArms}
  esac
fi
exit 0
`;
  const npxStub = `#!/bin/sh
echo "npx $*" >> "$CALL_LOG"
exit ${plan.npx ?? 0}
`;
  // `bash scripts/hook-autofix.sh` must not touch the real working tree here.
  const bashStub = `#!/bin/sh
echo "bash $*" >> "$CALL_LOG"
exit 0
`;

  for (const [name, body] of [
    ["npm", npmStub],
    ["npx", npxStub],
    ["bash", bashStub],
  ] as const) {
    const p = path.join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }

  const log = path.join(dir, "calls.log");
  writeFileSync(log, "");
  spawnSync("git", ["init", "-q"], { cwd: dir });

  const res = spawnSync("sh", ["-e", hookPath], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: log,
    },
  });
  calls.push(...readFileSync(log, "utf8").split("\n").filter(Boolean));
  rmSync(dir, { recursive: true, force: true });
  return { status: res.status, calls };
}

test("harness is not vacuous: a failing build fails the hook", () => {
  const { status, calls } = runHook({ npm: { build: 1 } });
  assert.notEqual(
    status,
    0,
    "the stubbed build never failed, so every assertion below would pass for the wrong reason"
  );
  assert.match(calls.join("\n"), /npm run build/);
});

test("a failing build stops the hook before the later phases run", () => {
  const { calls } = runHook({ npm: { build: 1 } });
  assert.ok(
    !calls.some((c) => c.startsWith("bash ")) &&
      !calls.some((c) => c.startsWith("npx ")),
    "a later phase ran despite the build failure — its exit code would have masked the failure"
  );
});

test("a failing test:typecheck fails the hook and no later phase runs", () => {
  const { status, calls } = runHook({ npm: { build: 0, "test:typecheck": 1 } });
  assert.notEqual(
    status,
    0,
    "`&&` short-circuit swallowed the typecheck failure"
  );
  assert.ok(
    !calls.some((c) => c.startsWith("npx ")),
    "the hook reached lint-staged after a red typecheck — the last phase decided the exit code"
  );
});

test("a failing lint-staged fails the hook even though it is the last command", () => {
  const { status } = runHook({ npx: 1 });
  assert.notEqual(
    status,
    0,
    "the hook returned success with a red lint-staged"
  );
});

test("an all-green run still returns success", () => {
  const { status, calls } = runHook({});
  assert.equal(
    status,
    0,
    "the hook is failing on its own harness rather than on a gate"
  );
  assert.deepEqual(
    calls.map((c) => c.split(" ").slice(0, 2).join(" ")),
    [
      "npm run",
      "npm run",
      "npm run",
      "bash scripts/hook-autofix.sh",
      "npx lint-staged",
    ],
    "the phases changed order or a phase disappeared"
  );
});

test("every `npm run` line in the hook carries an explicit exit", () => {
  const offenders = hookSource
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !line.startsWith("#") && line.includes("npm run "))
    .filter(({ line }) => !/\|\|\s*\{[^}]*exit\s+1/.test(line));
  assert.deepEqual(
    offenders.map(({ n, line }) => `${n}: ${line}`),
    [],
    "an unguarded `npm run` line lets a red gate leave the hook green under `sh -e`"
  );
});
