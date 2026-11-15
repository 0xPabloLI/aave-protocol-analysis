import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
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
  /** `- name:` value, or "" for a step written as `- uses:` / `- run:`. */
  name: string;
  /** 1-based line of the `- ` header. */
  line: number;
  /** 1-based line of the last line belonging to this step. */
  endLine: number;
  body: string[];
}

/**
 * Split a job into steps at every 6-space `- ` header.
 *
 * Matching only `- name:` would merge an unnamed step (`- run: npm run build`)
 * into the previous one, which is exactly the shape a bad edit can take — the
 * build would then run inside the suites step and still look ordered.
 */
export function parseSteps(text: string): Step[] {
  const lines = text.split("\n");
  const steps: Step[] = [];

  const starts: { index: number; name: string }[] = [];
  lines.forEach((line, index) => {
    const header = /^ {6}- (?:(name):\s*(.+?)\s*|(\S.*))$/.exec(line);
    if (header) {
      starts.push({ index, name: header[2] ?? "" });
    }
  });

  starts.forEach((start, position) => {
    const end =
      position + 1 < starts.length
        ? starts[position + 1].index - 1
        : lines.length - 1;
    steps.push({
      name: start.name,
      line: start.index + 1,
      endLine: end + 1,
      body: lines.slice(start.index + 1, end + 1),
    });
  });

  return steps;
}

/**
 * The command a line runs, with the YAML wrapper and leading `VAR=value`
 * assignments removed. Anchoring on this keeps prose such as
 * `echo "npm run build"` — or a `# npm run build` comment — from satisfying
 * the ordering rule without anything being built.
 */
export function commandOf(line: string): string {
  let text = line
    .trim()
    .replace(/^-\s*/, "")
    .replace(/^run:\s*/, "");
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(text)) {
    text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  return text;
}

const RUNS_BUILD = /^npm run build(\s|$)/;
const SUITE_CALL = /run_suite\s+"([^"]+)"/;

interface BuildCall {
  line: number;
  step: Step | undefined;
}

interface SuiteCall {
  line: number;
  suite: string;
}

function scan(
  text: string,
  steps: Step[]
): { build?: BuildCall; suites: SuiteCall[] } {
  const lines = text.split("\n");
  let build: BuildCall | undefined;
  const suites: SuiteCall[] = [];

  lines.forEach((line, index) => {
    if (/^\s*#/.test(line)) return;

    if (!build && RUNS_BUILD.test(commandOf(line))) {
      build = {
        line: index + 1,
        step: steps.find((s) => index + 1 >= s.line && index + 1 <= s.endLine),
      };
    }

    const suite = SUITE_CALL.exec(line);
    if (suite) suites.push({ line: index + 1, suite: suite[1] });
  });

  return { build, suites };
}

/**
 * Ordering problems in a canary definition.
 *
 * The rule this encodes: every suite resolves `@internal/*` through the
 * package `exports` field, i.e. to `dist/`, so a checkout without a prior build
 * cannot run any of them. Run 43694747017 proved it by dying on
 * `ERR_MODULE_NOT_FOUND` before `Build (timed)` had ever executed.
 *
 * Ordering is compared by line, not by step index: a split or merged step
 * changes the indexes but not which command actually runs first.
 */
export function findOrderProblems(text: string): string[] {
  const steps = parseSteps(text);
  const problems: string[] = [];

  if (steps.length === 0) {
    return [
      "no steps parsed — the workflow shape changed and this guard is blind",
    ];
  }

  const { build, suites } = scan(text, steps);

  if (!build) {
    problems.push(
      "no step runs `npm run build` — the suites consume dist through `@internal/*` exports and cannot run without it"
    );
  }
  if (suites.length === 0) {
    problems.push(
      "no step runs `run_suite` — nothing would execute the suites"
    );
  }

  if (build) {
    for (const call of suites) {
      if (call.line < build.line) {
        problems.push(
          `suite "${call.suite}" runs at line ${call.line}, before the build at line ${build.line} — it would see no dist`
        );
      }
    }

    // `Build duration trend` samples by step name (TREND_STEP), and a name
    // mismatch just drops the sample silently — no red, no issue, no series.
    const trendStep = /^\s*TREND_STEP:\s*(.+?)\s*$/m.exec(text);
    if (!trendStep) {
      problems.push(
        "no TREND_STEP in the workflow — the build trend reads it to find the sample"
      );
    } else if (build.step && build.step.name !== trendStep[1]) {
      problems.push(
        `the step that builds is named "${build.step.name}" but TREND_STEP is "${trendStep[1]}" — the trend would silently sample nothing`
      );
    }

    if (
      build.step &&
      !/^\s*id:\s*build\s*$/m.test(build.step.body.join("\n"))
    ) {
      problems.push(
        `the build step (line ${build.line}) does not declare \`id: build\` — \`Build duration trend\` reads steps.build.outputs.seconds`
      );
    }
  }

  const invoked = new Set(suites.map((call) => call.suite));
  for (const suite of EXPECTED_SUITES) {
    if (!invoked.has(suite)) {
      problems.push(`suite "${suite}" is no longer executed by the canary`);
    }
  }

  return problems;
}

/** Minimal workflow fixture: one job, the given steps, 6-space headers. */
function workflowOf(
  steps: { name: string; run: string; id?: string }[],
  trendStep = "Build (timed)"
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
    "      - name: Build duration trend",
    "        env:",
    `          TREND_STEP: ${trendStep}`,
    "",
  ].join("\n");
}

const SUITES_RUN = EXPECTED_SUITES.map(
  (suite) => `run_suite "${suite}" true`
).join("\n");

const BUILD_STEP = { name: "Build (timed)", run: "npm run build", id: "build" };
const SUITES_STEP = { name: "Run full suites", run: SUITES_RUN };

test("the canary builds before it runs any suite", () => {
  assert.deepEqual(findOrderProblems(readFileSync(CANARY, "utf8")), []);
});

test("the guard is not vacuous: it sees one build and five suites in the real file", () => {
  const text = readFileSync(CANARY, "utf8");
  const steps = parseSteps(text);
  const { build, suites } = scan(text, steps);

  assert.ok(build, "no build call found in the real workflow");
  assert.equal(build.step?.name, "Build (timed)");
  assert.deepEqual(
    suites.map((call) => call.suite),
    [...EXPECTED_SUITES]
  );

  // Anti-vacuity: every 6-space `- ` line must have become a step, so a new
  // unnamed step cannot slip past the order check.
  const headers = readFileSync(CANARY, "utf8")
    .split("\n")
    .filter((line) => /^ {6}- /.test(line)).length;
  assert.equal(steps.length, headers);
  assert.ok(headers >= 8, `expected the canary's steps, found ${headers}`);
});

test("build moved back after the suites is reported with both line numbers", () => {
  const problems = findOrderProblems(workflowOf([SUITES_STEP, BUILD_STEP]));

  const ordered = problems.filter((problem) =>
    problem.includes("before the build")
  );
  assert.equal(ordered.length, EXPECTED_SUITES.length, problems.join("; "));

  for (const [index, suite] of EXPECTED_SUITES.entries()) {
    const match = /runs at line (\d+), before the build at line (\d+)/.exec(
      ordered[index]
    );
    assert.ok(match, ordered[index]);
    assert.ok(ordered[index].includes(`suite "${suite}"`));
    assert.ok(Number(match[1]) < Number(match[2]));
  }
});

test("a build command inside the suites step, after a run_suite call, is reported", () => {
  const problems = findOrderProblems(
    workflowOf([
      {
        name: "Run full suites",
        run: `run_suite "shared-contracts" true\nnpm run build\n${EXPECTED_SUITES.slice(
          1
        )
          .map((suite) => `run_suite "${suite}" true`)
          .join("\n")}`,
      },
      { ...BUILD_STEP, run: "echo done" },
    ])
  );

  assert.ok(
    problems.some((problem) =>
      /^suite "shared-contracts" runs at line \d+, before the build at line \d+/.test(
        problem
      )
    ),
    problems.join("; ")
  );
});

test("a missing build step is reported", () => {
  const problems = findOrderProblems(workflowOf([SUITES_STEP]));

  assert.deepEqual(problems, [
    "no step runs `npm run build` — the suites consume dist through `@internal/*` exports and cannot run without it",
  ]);
});

test("a dropped suite is reported by name", () => {
  const problems = findOrderProblems(
    workflowOf([
      BUILD_STEP,
      {
        name: "Run full suites",
        run: EXPECTED_SUITES.filter((suite) => suite !== "backend")
          .map((suite) => `run_suite "${suite}" true`)
          .join("\n"),
      },
    ])
  );

  assert.deepEqual(problems, [
    'suite "backend" is no longer executed by the canary',
  ]);
});

test("renaming the build step is reported: the trend samples by name", () => {
  const problems = findOrderProblems(
    workflowOf([{ ...BUILD_STEP, name: "Compile (timed)" }, SUITES_STEP])
  );

  assert.deepEqual(problems, [
    'the step that builds is named "Compile (timed)" but TREND_STEP is "Build (timed)" — the trend would silently sample nothing',
  ]);
});

test("build without an id on that step is reported", () => {
  const problems = findOrderProblems(
    workflowOf([
      { name: "Build (timed)", run: "npm run build" },
      { name: "Run full suites", run: SUITES_RUN, id: "build" },
    ])
  );

  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(
    problems[0],
    /the build step \(line 7\) does not declare `id: build`/
  );
});

test("comments and prose cannot satisfy the build rule", () => {
  const problems = findOrderProblems(
    workflowOf([
      {
        name: "Build (timed)",
        run: '# npm run build\necho "npm run build is required"\necho npm run build',
        id: "build",
      },
      SUITES_STEP,
    ])
  );

  assert.deepEqual(problems, [
    "no step runs `npm run build` — the suites consume dist through `@internal/*` exports and cannot run without it",
  ]);
});

test("shared-contracts runs its own tests from src, not from its build output", () => {
  const offenders: string[] = [];
  let seen = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".test.ts")) continue;
      seen += 1;
      if (
        /(?:from|import\()\s*["']\.\.\/dist\//.test(readFileSync(path, "utf8"))
      ) {
        offenders.push(path);
      }
    }
  };
  walk(SHARED_CONTRACTS_TESTS);

  assert.ok(seen >= 8, `expected the package's test files, found ${seen}`);
  assert.deepEqual(offenders, []);
});
