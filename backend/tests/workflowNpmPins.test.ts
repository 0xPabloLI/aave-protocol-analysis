import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const WORKFLOWS = resolve(ROOT, ".github", "workflows");
const DOCKERFILE = resolve(ROOT, "Dockerfile");

const NPM_PIN = /npm install -g npm@(\d+\.\d+\.\d+)/;
const NPM_INSTALL = /^(?:sfw\s+)?npm (?:ci|run ci)\b/;

interface Scope {
  label: string;
  name: string;
  start: number;
  end: number;
}

export interface NpmPinScan {
  jobs: number;
  ciSteps: number;
  problems: string[];
}

/**
 * The command a YAML/Dockerfile line runs, stripped of the wrapper syntax that
 * is not part of the command. Anchoring on this is what keeps prose such as
 * `echo '... npm ci ...'` or `- name: npm install -g npm@...` from satisfying
 * (or violating) the rule without running anything.
 */
function commandOf(line: string): string {
  let text = line.trim().replace(/^-\s*/, "");
  text = text.replace(/^run:\s*/, "").replace(/^RUN\s+/, "");
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(text)) {
    text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  return text;
}

function scanScope(scope: Scope, lines: string[]): NpmPinScan {
  let ciSteps = 0;
  let pinnedEarlier = false;
  const problems: string[] = [];

  for (let i = scope.start; i < scope.end; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;

    const command = commandOf(line);
    if (!command) continue;

    // Check the install before recording a pin on the same line: a pin that
    // appears after `npm ci` in the same command is not an earlier pin.
    if (NPM_INSTALL.test(command)) {
      ciSteps += 1;
      if (!pinnedEarlier) {
        problems.push(
          `${scope.label}:${i + 1}  npm ci in ${scope.name} has no earlier npm version pin`
        );
      }
    }
    if (NPM_PIN.test(command)) pinnedEarlier = true;
  }

  return { jobs: 1, ciSteps, problems };
}

/** Split the `jobs:` mapping into 2-space-indented job blocks. */
function jobsIn(yaml: string): Scope[] {
  const lines = yaml.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return [];

  const jobs: Scope[] = [];
  let current: { name: string; start: number } | null = null;

  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // A new top-level key ends the jobs mapping.
    if (/^\S/.test(line)) break;

    // Allow an inline comment: `canary: # weekly` is still a job header, and
    // dropping it would silently skip every install inside that job.
    const job = line.match(/^ {2}(["']?)([A-Za-z0-9_-]+)\1:\s*(?:#.*)?$/);
    if (!job) continue;

    if (current)
      jobs.push({
        label: "",
        name: current.name,
        start: current.start,
        end: i,
      });
    current = { name: job[2], start: i };
  }

  if (current) {
    jobs.push({
      label: "",
      name: current.name,
      start: current.start,
      end: lines.length,
    });
  }
  return jobs;
}

/**
 * Every `npm ci` must be preceded by an npm pin **in the same job**. A pin in a
 * sibling job proves nothing: that job may install its own dependencies, and a
 * job only inherits the runner image (whatever npm ships with the pinned Node).
 */
export function scanWorkflowNpmPins(label: string, yaml: string): NpmPinScan {
  const lines = yaml.split("\n");
  const scopes = jobsIn(yaml).map((scope) => ({ ...scope, label }));
  const scans = scopes.map((scope) => scanScope(scope, lines));

  return {
    jobs: scopes.length,
    ciSteps: scans.reduce((sum, scan) => sum + scan.ciSteps, 0),
    problems: scans.flatMap((scan) => scan.problems),
  };
}

/** Same rule for a single-scope file (the Dockerfile). */
export function scanDockerfileNpmPins(label: string, text: string): NpmPinScan {
  const lines = text.split("\n");
  return scanScope({ label, name: "file", start: 0, end: lines.length }, lines);
}

/** All npm pins in the given sources, or one problem per pin when they disagree. */
export function npmVersionDrift(
  sources: { label: string; text: string }[]
): string[] {
  const found: { label: string; line: number; version: string }[] = [];

  for (const source of sources) {
    source.text.split("\n").forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      const pin = commandOf(line).match(NPM_PIN);
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

/**
 * Independent count of job headers: every 2-space-indented, non-comment line
 * inside the `jobs:` block. Job properties live at 4 spaces, so anything at 2
 * is a job key. Used to prove the parser did not silently drop a job.
 */
function jobHeaderCount(yaml: string): number {
  const lines = yaml.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return 0;

  let count = 0;
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    if (/^ {2}[^\s#]/.test(line)) count += 1;
  }
  return count;
}

test("every npm ci in .github/workflows is preceded by an npm pin in the same job", () => {
  const problems: string[] = [];
  let ciSteps = 0;

  for (const file of workflowFiles()) {
    const yaml = readWorkflow(file);
    const scan = scanWorkflowNpmPins(file, yaml);
    ciSteps += scan.ciSteps;
    problems.push(...scan.problems);
    assert.equal(
      scan.jobs,
      jobHeaderCount(yaml),
      `${file}: parsed ${scan.jobs} jobs, but the file has ${jobHeaderCount(yaml)} job headers`
    );
  }

  // Guard the guard: an empty scan would make the assertion below vacuously true.
  assert.ok(ciSteps >= 4, `expected at least 4 npm ci steps, found ${ciSteps}`);
  assert.deepEqual(
    problems,
    [],
    `npm ci steps without a pin in the same job:\n${problems.join("\n")}`
  );
});

test("the Dockerfile pins npm before every install", () => {
  const scan = scanDockerfileNpmPins(
    "Dockerfile",
    readFileSync(DOCKERFILE, "utf8")
  );
  assert.ok(
    scan.ciSteps >= 2,
    `expected at least 2 Dockerfile installs, found ${scan.ciSteps}`
  );
  assert.deepEqual(
    scan.problems,
    [],
    `Dockerfile installs without a pin:\n${scan.problems.join("\n")}`
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
      name: "bare npm ci without a pin",
      yaml: "jobs:\n  canary:\n    steps:\n      - run: npm ci\n",
      ciSteps: 1,
      problems: 1,
    },
    {
      name: "pin after npm ci",
      yaml: "jobs:\n  canary:\n    steps:\n      - run: npm ci\n      - run: npm install -g npm@11.6.2\n",
      ciSteps: 1,
      problems: 1,
    },
    {
      name: "pin in another job",
      yaml: "jobs:\n  a:\n    steps:\n      - run: npm install -g npm@11.6.2\n  b:\n    steps:\n      - run: npm ci\n",
      ciSteps: 1,
      problems: 1,
    },
    {
      name: "job header with an inline comment",
      yaml: "jobs:\n  canary: # weekly\n    steps:\n      - run: npm ci\n",
      ciSteps: 1,
      problems: 1,
    },
    {
      name: "quoted job header",
      yaml: 'jobs:\n  "canary":\n    steps:\n      - run: npm ci\n',
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
      name: "npm run ci installs too",
      yaml: "jobs:\n  build:\n    steps:\n      - run: npm run ci\n",
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
      name: "echo containing npm ci",
      yaml: "jobs:\n  canary:\n    steps:\n      - run: echo 'npm ci failed'\n",
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

test("dockerfile scan requires a pin before every install", () => {
  const withPin = "RUN npm install -g npm@11.6.2\nRUN HUSKY=0 npm ci\n";
  assert.deepEqual(scanDockerfileNpmPins("Dockerfile", withPin).problems, []);

  const withoutPin = "RUN HUSKY=0 npm ci\n";
  const scan = scanDockerfileNpmPins("Dockerfile", withoutPin);
  assert.equal(scan.ciSteps, 1);
  assert.equal(scan.problems.length, 1);
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
