import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const WORKFLOWS = resolve(ROOT, ".github", "workflows");
const DOCKERFILE = resolve(ROOT, "Dockerfile");

const NPM_PIN = /npm\s+install\s+-g\s+npm@(\d+\.\d+\.\d+)/;
const NPM_CI = /\bnpm\s+ci\b/;

interface Job {
  name: string;
  start: number;
  end: number;
}

export interface NpmPinScan {
  ciSteps: number;
  problems: string[];
}

/** Split `jobs:` into 2-space-indented job blocks, with 0-based line bounds. */
function jobsIn(yaml: string): Job[] {
  const lines = yaml.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return [];

  const jobs: Job[] = [];
  let current: Omit<Job, "end"> | null = null;

  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // A new top-level key ends the jobs mapping.
    if (/^\S/.test(line)) break;

    const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (!job) continue;

    if (current) jobs.push({ ...current, end: i });
    current = { name: job[1], start: i };
  }

  if (current) jobs.push({ ...current, end: lines.length });
  return jobs;
}

/**
 * Every `npm ci` must be preceded by an npm pin **in the same job**. A pin in a
 * sibling job proves nothing: that job may install its own dependencies, and a
 * job only inherits the runner image (whatever npm ships with the pinned Node).
 */
export function scanWorkflowNpmPins(label: string, yaml: string): NpmPinScan {
  const lines = yaml.split("\n");
  const problems: string[] = [];
  let ciSteps = 0;

  for (const job of jobsIn(yaml)) {
    let pinned = false;
    for (let i = job.start; i < job.end; i += 1) {
      const line = lines[i];
      if (/^\s*#/.test(line)) continue;
      if (NPM_PIN.test(line)) pinned = true;
      if (!NPM_CI.test(line)) continue;

      ciSteps += 1;
      if (!pinned) {
        problems.push(
          `${label}:${i + 1}  npm ci in job "${job.name}" has no earlier npm version pin`
        );
      }
    }
  }

  return { ciSteps, problems };
}

/** All npm pins in the given sources, or one problem per pin when they disagree. */
export function npmVersionDrift(
  sources: { label: string; text: string }[]
): string[] {
  const found: { label: string; line: number; version: string }[] = [];

  for (const source of sources) {
    source.text.split("\n").forEach((line, index) => {
      const pin = line.match(NPM_PIN);
      if (pin)
        found.push({ label: source.label, line: index + 1, version: pin[1] });
    });
  }

  if (found.length === 0)
    return ["no npm version pin found in workflows or Dockerfile"];
  if (new Set(found.map((entry) => entry.version)).size === 1) return [];

  return found.map(
    (entry) => `${entry.label}:${entry.line}  npm@${entry.version}`
  );
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
}

function readWorkflow(file: string): string {
  return readFileSync(resolve(WORKFLOWS, file), "utf8");
}

test("every npm ci in .github/workflows is preceded by an npm pin in the same job", () => {
  const problems: string[] = [];
  let ciSteps = 0;

  for (const file of workflowFiles()) {
    const scan = scanWorkflowNpmPins(file, readWorkflow(file));
    ciSteps += scan.ciSteps;
    problems.push(...scan.problems);
  }

  // Guard the guard: an empty scan would make the assertion below vacuously true.
  assert.ok(ciSteps >= 4, `expected at least 4 npm ci steps, found ${ciSteps}`);
  assert.deepEqual(
    problems,
    [],
    `npm ci steps without a pin in the same job:\n${problems.join("\n")}`
  );
});

test("all npm pins agree with the Dockerfile", () => {
  const sources = [
    ...workflowFiles().map((file) => ({
      label: file,
      text: readWorkflow(file),
    })),
    { label: "Dockerfile", text: readFileSync(DOCKERFILE, "utf8") },
  ];
  const drift = npmVersionDrift(sources);
  assert.deepEqual(
    drift,
    [],
    `npm version pins that disagree:\n${drift.join("\n")}`
  );
});

test("pin scan is job-scoped and ignores prose", () => {
  const cases: {
    name: string;
    yaml: string;
    ciSteps: number;
    problems: number;
  }[] = [
    {
      name: "pin before npm ci",
      yaml: "jobs:\n  canary:\n    steps:\n      - run: npm install -g npm@11.6.2\n      - run: npm ci\n",
      ciSteps: 1,
      problems: 0,
    },
    {
      name: "pin after npm ci",
      yaml: "jobs:\n  canary:\n    steps:\n      - run: npm ci\n      - run: npm install -g npm@11.6.2\n",
      ciSteps: 1,
      problems: 1,
    },
    {
      name: "pin only in a sibling job",
      yaml: "jobs:\n  a:\n    steps:\n      - run: npm install -g npm@11.6.2\n  b:\n    steps:\n      - run: npm ci\n",
      ciSteps: 1,
      problems: 1,
    },
    {
      name: "sfw npm ci",
      yaml: "jobs:\n  socket:\n    steps:\n      - run: sfw npm ci\n",
      ciSteps: 1,
      problems: 1,
    },
    {
      name: "npm ci --prefix backend",
      yaml: "jobs:\n  canary:\n    steps:\n      - run: npm ci --prefix backend\n",
      ciSteps: 1,
      problems: 1,
    },
    {
      name: "comment mentioning npm ci",
      yaml: "jobs:\n  canary:\n    steps:\n      # npm ci used to run here\n      - run: echo ok\n",
      ciSteps: 0,
      problems: 0,
    },
    {
      name: "two installs after one pin",
      yaml: "jobs:\n  canary:\n    steps:\n      - run: npm install -g npm@11.6.2\n      - run: npm ci\n      - run: npm ci --prefix backend\n",
      ciSteps: 2,
      problems: 0,
    },
    {
      name: "pin inside a multiline run block",
      yaml: "jobs:\n  canary:\n    steps:\n      - run: |\n          npm install -g npm@11.6.2\n          npm ci\n",
      ciSteps: 1,
      problems: 0,
    },
  ];

  for (const fixture of cases) {
    const scan = scanWorkflowNpmPins(fixture.name, fixture.yaml);
    assert.equal(
      scan.ciSteps,
      fixture.ciSteps,
      `${fixture.name}: ci step count`
    );
    assert.equal(
      scan.problems.length,
      fixture.problems,
      `${fixture.name}: problem count`
    );
  }
});

test("version drift is reported with every source", () => {
  const drift = npmVersionDrift([
    { label: "ci.yml", text: "run: npm install -g npm@11.6.2" },
    { label: "Dockerfile", text: "RUN npm install -g npm@11.7.0" },
  ]);
  assert.equal(drift.length, 2);
  assert.ok(drift[0].includes("11.6.2"));
  assert.ok(drift[1].includes("11.7.0"));

  assert.deepEqual(npmVersionDrift([]), [
    "no npm version pin found in workflows or Dockerfile",
  ]);
});
