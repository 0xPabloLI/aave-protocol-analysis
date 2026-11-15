import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const CANARY = resolve(ROOT, ".github", "workflows", "test-canary.yml");
const SHARED_CONTRACTS_TESTS = resolve(
  ROOT,
  "packages",
  "aave-shared-contracts",
  "tests"
);

/**
 * Suites the canary must actually execute. Listed explicitly so that deleting a
 * `run_suite` line is a failure here instead of a silently shorter canary.
 */
export const EXPECTED_SUITES = [
  "shared-contracts",
  "root",
  "rpc-infra",
  "fetcher",
  "backend",
] as const;

interface Step {
  name: string;
  /** 1-based line of the `- name:` header, used in failure messages. */
  line: number;
  body: string[];
}

/**
 * Split a workflow's job into steps by their 6-space `- name:` header.
 *
 * Steps are the only thing at that indent inside a job, so this is enough and
 * avoids pulling a YAML parser into a guard whose whole point is to be boring.
 */
export function parseSteps(text: string): Step[] {
  const steps: Step[] = [];
  let current: Step | null = null;

  text.split("\n").forEach((line, index) => {
    const header = /^ {6}- name:\s*(.+?)\s*$/.exec(line);
    if (header) {
      if (current) steps.push(current);
      current = { name: header[1], line: index + 1, body: [] };
      return;
    }
    if (current) current.body.push(line);
  });

  if (current) steps.push(current);
  return steps;
}

/** Step body without comment lines — a comment must never satisfy a rule. */
function runText(step: Step): string {
  return step.body.filter((line) => !/^\s*#/.test(line)).join("\n");
}

const RUNS_BUILD = /(^|\s)npm run build(\s|$)/m;
const RUNS_SUITE = /run_suite "/;

/**
 * Ordering problems in a canary definition.
 *
 * The rule this encodes: every suite resolves `@internal/*` through the
 * package `exports` field, i.e. to `dist/`, so a checkout without a prior build
 * cannot run any of them. That is not a preference — run 43694747017 proved it
 * by dying on `ERR_MODULE_NOT_FOUND` before `Build (timed)` had ever executed.
 */
export function findOrderProblems(steps: Step[]): string[] {
  const problems: string[] = [];

  if (steps.length === 0) {
    return [
      "no steps parsed — the workflow shape changed and this guard is blind",
    ];
  }

  const buildIndex = steps.findIndex((step) => RUNS_BUILD.test(runText(step)));
  const suitesIndex = steps.findIndex((step) => RUNS_SUITE.test(runText(step)));

  if (buildIndex === -1) {
    problems.push(
      "no step runs `npm run build` — the suites consume dist through `@internal/*` exports and cannot run without it"
    );
  }
  if (suitesIndex === -1) {
    problems.push(
      "no step runs `run_suite` — nothing would execute the suites"
    );
  }
  if (buildIndex !== -1 && suitesIndex !== -1 && buildIndex > suitesIndex) {
    problems.push(
      `build step (line ${steps[buildIndex].line}) runs after the suites step (line ${steps[suitesIndex].line}) — suites would see no dist`
    );
  }

  if (suitesIndex !== -1) {
    const suitesText = runText(steps[suitesIndex]);
    for (const suite of EXPECTED_SUITES) {
      if (!new RegExp(`run_suite "${suite}"`).test(suitesText)) {
        problems.push(`suite "${suite}" is no longer executed by the canary`);
      }
    }
  }

  if (
    !steps.some((step) => /^\s+id:\s*build\s*$/m.test(step.body.join("\n")))
  ) {
    problems.push(
      "no step declares `id: build` — `Build duration trend` reads steps.build.outputs.seconds"
    );
  }

  return problems;
}

/** Minimal workflow fixture: one job, the given steps, 6-space headers. */
function workflowOf(
  steps: { name: string; run: string; id?: string }[]
): string {
  const body = steps
    .map(({ name, run, id }) => {
      const idLine = id ? `        id: ${id}\n` : "";
      const commands = run
        .split("\n")
        .map((line) => `          ${line}`)
        .join("\n");
      return `      - name: ${name}\n${idLine}        run: |\n${commands}`;
    })
    .join("\n");

  return [
    "jobs:",
    "  canary:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    body,
    "",
  ].join("\n");
}

const SUITES_RUN = EXPECTED_SUITES.map(
  (suite) => `run_suite "${suite}" true`
).join("\n");

test("the canary builds before it runs any suite", () => {
  const steps = parseSteps(readFileSync(CANARY, "utf8"));
  assert.deepEqual(findOrderProblems(steps), []);
});

test("the guard is not vacuous: it sees one build and five suites in the real file", () => {
  const steps = parseSteps(readFileSync(CANARY, "utf8"));
  const buildSteps = steps.filter((step) => RUNS_BUILD.test(runText(step)));
  const suiteSteps = steps.filter((step) => RUNS_SUITE.test(runText(step)));

  assert.equal(buildSteps.length, 1, "expected exactly one build step");
  assert.equal(suiteSteps.length, 1, "expected exactly one suites step");
  for (const suite of EXPECTED_SUITES) {
    assert.match(
      runText(suiteSteps[0]),
      new RegExp(`run_suite "${suite}"`),
      `suite "${suite}" missing from the canary`
    );
  }
});

test("build moved back after the suites is reported", () => {
  const steps = parseSteps(
    workflowOf([
      { name: "Run full suites", run: SUITES_RUN },
      { name: "Build (timed)", run: "npm run build\necho done", id: "build" },
    ])
  );

  const problems = findOrderProblems(steps);
  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(problems[0], /build step .* runs after the suites step/);
});

test("a missing build step is reported", () => {
  const steps = parseSteps(
    workflowOf([{ name: "Run full suites", run: SUITES_RUN }])
  );

  const problems = findOrderProblems(steps);
  assert.ok(
    problems.some((problem) =>
      problem.includes("no step runs `npm run build`")
    ),
    problems.join("; ")
  );
});

test("a dropped suite is reported by name", () => {
  const steps = parseSteps(
    workflowOf([
      { name: "Build (timed)", run: "npm run build", id: "build" },
      {
        name: "Run full suites",
        run: EXPECTED_SUITES.filter((suite) => suite !== "backend")
          .map((suite) => `run_suite "${suite}" true`)
          .join("\n"),
      },
    ])
  );

  assert.deepEqual(findOrderProblems(steps), [
    'suite "backend" is no longer executed by the canary',
  ]);
});

test("build without an id is reported: the trend step would silently skip", () => {
  const steps = parseSteps(
    workflowOf([
      { name: "Build (timed)", run: "npm run build" },
      { name: "Run full suites", run: SUITES_RUN },
    ])
  );

  assert.deepEqual(findOrderProblems(steps), [
    "no step declares `id: build` — `Build duration trend` reads steps.build.outputs.seconds",
  ]);
});

test("comments cannot satisfy the ordering rule", () => {
  const steps = parseSteps(
    [
      "jobs:",
      "  canary:",
      "    steps:",
      "      - name: Run full suites",
      "        run: |",
      "          # npm run build",
      `          ${SUITES_RUN.split("\n").join("\n          ")}`,
      "",
    ].join("\n")
  );

  const problems = findOrderProblems(steps);
  assert.ok(
    problems.some((problem) =>
      problem.includes("no step runs `npm run build`")
    ),
    problems.join("; ")
  );
});

test("shared-contracts runs its own tests from src, not from its build output", () => {
  const offenders = readdirSync(SHARED_CONTRACTS_TESTS)
    .filter((file) => file.endsWith(".test.ts"))
    .filter((file) =>
      /from "\.\.\/dist\//.test(
        readFileSync(resolve(SHARED_CONTRACTS_TESTS, file), "utf8")
      )
    );

  assert.deepEqual(offenders, [], `tests must import ../src/*: ${offenders}`);
});
