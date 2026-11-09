import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const REMEDIATION_WORKFLOW = ".github/workflows/ci-auto-remediation.yml";
const CI_WORKFLOW = ".github/workflows/ci.yml";

function readConfig(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

/** Split the `steps:` section into one string per step block (6-space `- `). */
function stepBlocks(yaml: string): string[] {
  const start = yaml.indexOf("    steps:");
  const body = start === -1 ? yaml : yaml.slice(start);
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split("\n")) {
    if (/^ {6}- /.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * A line that actually invokes npm, as opposed to prose that mentions a command.
 * Prose lines start with `echo`/`#` and therefore never match.
 *
 * `install -g npm@` is included deliberately: the pin step is the first npm
 * command in the job, so an unguarded failure there aborts everything after it.
 */
const NPM_COMMAND = /^\s*(?:run:\s*)?npm (?:ci|audit fix|install -g npm@)\b/;

test("remediation workflow pins npm to the same version as ci.yml", () => {
  const pin = /npm install -g npm@([\d.]+)/;
  const ci = readConfig(CI_WORKFLOW).match(pin);
  const remediation = readConfig(REMEDIATION_WORKFLOW).match(pin);
  assert.ok(ci, `${CI_WORKFLOW} must pin npm`);
  assert.ok(
    remediation,
    `${REMEDIATION_WORKFLOW} must pin npm — an unpinned npm rejects the ` +
      "@emnapi/* lockfile entries with EUSAGE (observed 2026-11-09)"
  );
  assert.equal(
    remediation![1],
    ci![1],
    "both workflows must pin the same npm version, or one validates the lockfile differently"
  );
});

test("remediation job cannot fail the workflow run", () => {
  const yaml = readConfig(REMEDIATION_WORKFLOW);
  const jobHeader = yaml.slice(0, yaml.indexOf("    steps:"));
  // Railway skips a deployment as soon as any run on the commit concludes in
  // `failure`, and a `workflow_run` run is attributed to the default branch's
  // HEAD regardless of which branch triggered it. Job-level continue-on-error
  // is what stops a best-effort remediation from blocking production.
  assert.match(
    jobHeader,
    /^ {4}continue-on-error: true$/m,
    "the remediate job needs job-level continue-on-error"
  );
});

test("workflow may write issues (escalation path)", () => {
  const yaml = readConfig(REMEDIATION_WORKFLOW);
  const permissions = yaml.slice(
    yaml.indexOf("permissions:"),
    yaml.indexOf("jobs:")
  );
  // Declaring `permissions:` sets every unlisted scope to none, so omitting
  // issues: write makes the escalation step fail with 403 — silently, because
  // that step tolerates failure.
  assert.match(
    permissions,
    /^ {2}issues: write$/m,
    "escalation opens an issue, so the workflow needs issues: write"
  );
});

test("every npm command in the remediation workflow tolerates failure", () => {
  const offenders = stepBlocks(readConfig(REMEDIATION_WORKFLOW))
    .filter((block) => block.split("\n").some((line) => NPM_COMMAND.test(line)))
    .filter((block) => !block.includes("continue-on-error: true"))
    .map((block) => block.split("\n")[0].trim());
  assert.deepEqual(
    offenders,
    [],
    `these steps run npm without continue-on-error: ${offenders.join(", ")}`
  );
});

test("escalation path is reachable even when an earlier step fails", () => {
  const steps = stepBlocks(readConfig(REMEDIATION_WORKFLOW));
  // GitHub implicitly ANDs a bare `if` with `success()`. Without an explicit
  // `!cancelled()`, a failure in any earlier step that lacks its own
  // continue-on-error skips this entire path — and because the job carries
  // job-level continue-on-error, the run still reports success, so the lost
  // escalation is invisible. Each step here must opt out of that implicit gate.
  for (const name of [
    "Classify remediation failure",
    "Read audit output for escalation",
    "Escalate via issue when remediation fails",
  ]) {
    const step = steps.find((block) => block.includes(name));
    assert.ok(step, `${name} step not found`);
    assert.ok(
      step.includes("!cancelled()"),
      `${name} must gate on !cancelled() so an earlier failure cannot skip it`
    );
  }
});

test("classifier distinguishes a failed npm pin from a failed install", () => {
  const step = stepBlocks(readConfig(REMEDIATION_WORKFLOW)).find((block) =>
    block.includes("Classify remediation failure")
  );
  assert.ok(step, "classifier step not found");
  // Without this branch a registry outage is reported as a lockfile problem,
  // sending the reader to regenerate a lockfile that was never at fault.
  assert.ok(
    step.includes("steps.npm-pin.outcome"),
    "classifier must name a failed npm pin separately"
  );
  assert.ok(
    step.includes("steps.install.outcome"),
    "classifier must still handle a failed install"
  );
});

test("escalation step passes outputs through env, not JS interpolation", () => {
  const step = stepBlocks(readConfig(REMEDIATION_WORKFLOW)).find((block) =>
    block.includes("Escalate via issue")
  );
  assert.ok(step, "escalation step not found");
  const envIndex = step.indexOf("env:");
  const scriptIndex = step.indexOf("script: |");
  assert.ok(envIndex !== -1, "escalation step must declare an env: block");
  assert.ok(
    envIndex < scriptIndex,
    "env: must be declared before the script it feeds"
  );
  // These values contain backticks (the audit report is full of ``` fences).
  // Interpolating one into the script terminates a JS template literal and
  // makes the step fail, which is exactly what must not happen here.
  for (const output of [
    "steps.failure.outputs.summary",
    "steps.failure.outputs.advice",
    "steps.audit-out.outputs.report",
  ]) {
    assert.ok(
      step.slice(envIndex, scriptIndex).includes(output),
      `${output} must be passed via env:`
    );
    assert.ok(
      !step.slice(scriptIndex).includes(output),
      `${output} must not be interpolated into the script body`
    );
  }
});
