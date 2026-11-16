/**
 * Static guards for `.github/workflows/deployment-smoke-test.yml` — AAV-1295.
 *
 * The rollback job became reachable in AAV-1294, but the mutation had never
 * executed and the target-selection heuristic had only ever been tested against
 * hand-written jq inputs. These assertions pin the safety properties that make
 * the staging drill and the production gate work:
 *
 *   1. a rollback deployment must not cancel the run performing the rollback;
 *   2. the production gate must be evaluated before the mutation;
 *   3. the failure issue must carry the gate state, not silently report "skipped";
 *   4. execute mode must be staging-only and require an explicit confirmation;
 *   5. the drill must restore the head deployment after a real rollback.
 *
 * Behaviour tests live in `tests/deploymentSmokeTest.test.ts`; this file only
 * reads the YAML text so a future edit cannot reorder or drop a guard.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(
  __dirname,
  "..",
  ".github",
  "workflows",
  "deployment-smoke-test.yml"
);

function readWorkflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

/** The lines of a 2-space-indented job, up to the next job key. */
function jobBlock(workflow: string, job: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) {
    throw new Error(`job "${job}" not found in ${WORKFLOW}`);
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:$/.test(line)
  );

  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("workflow: exposes a plan/execute drill with an explicit confirmation input", () => {
  const workflow = readWorkflow();

  assert.ok(workflow.includes("workflow_dispatch:"));
  assert.ok(workflow.includes("      environment:"));
  assert.ok(workflow.includes("      mode:"));
  assert.ok(workflow.includes("      confirm:"));
  assert.ok(workflow.includes("- staging"));
  assert.ok(workflow.includes("- production"));
});

test("workflow: concurrency is keyed by deployment id, not environment", () => {
  const workflow = readWorkflow();
  const concurrency = workflow.slice(
    workflow.indexOf("concurrency:"),
    workflow.indexOf("jobs:")
  );

  assert.ok(
    concurrency.includes("github.event.deployment.id"),
    "a rollback deployment must not share a concurrency group with the run it is replacing"
  );
  assert.ok(concurrency.includes("cancel-in-progress: false"));
  assert.ok(
    !concurrency.includes("deployment.environment"),
    "keying on environment lets the rollback cancel the run performing it"
  );
});

test("rollback: the production gate is evaluated before the mutation", () => {
  const rollback = jobBlock(readWorkflow(), "rollback");
  const gateIndex = rollback.indexOf("resolveRollbackGate");
  const mutationIndex = rollback.indexOf("deploymentRollback");

  assert.ok(gateIndex > -1, "rollback job must call resolveRollbackGate");
  assert.ok(mutationIndex > -1, "rollback job must call deploymentRollback");
  assert.ok(
    gateIndex < mutationIndex,
    "the gate must run before the mutation, not after it"
  );
  assert.equal(
    rollback.split("mutation($id: String!) { deploymentRollback(id: $id) }")
      .length - 1,
    1,
    "the mutation request must have a single call site"
  );
});

test("rollback: the gate state reaches the failure issue payload", () => {
  const rollback = jobBlock(readWorkflow(), "rollback");

  assert.ok(rollback.includes("rollback_gated=true"));
  assert.ok(rollback.includes("RAILWAY_PRODUCTION_ROLLBACK_ENABLED"));
  assert.ok(
    rollback.includes("steps.rollback.outputs.rollback_executed"),
    "the issue must distinguish executed from gated"
  );
  assert.ok(rollback.includes("steps.rollback.outcome"));
  assert.ok(
    rollback.includes("rollbackGated"),
    "createSmokeTestIssuePayload must receive the gate state"
  );
});

test("rollback: target selection uses the shared helper, not an inline jq fallback", () => {
  const rollback = jobBlock(readWorkflow(), "rollback");

  assert.ok(rollback.includes("selectRollbackCandidate"));
  assert.ok(
    !rollback.includes("select(.canRollback == true)"),
    "the inline heuristic must not survive beside the tested helper"
  );
});

test("rollback: only runs after a resolved smoke failure", () => {
  const rollback = jobBlock(readWorkflow(), "rollback");

  assert.ok(
    rollback.includes(
      "if: failure() && needs.smoke-test.outputs.should_run == 'true'"
    )
  );
});

test("smoke-test: a workflow_dispatch does not masquerade as a deployment verification", () => {
  const smoke = jobBlock(readWorkflow(), "smoke-test");

  assert.ok(smoke.includes("github.event_name == 'deployment_status'"));
  assert.ok(
    smoke.includes("github.event.deployment_status.state == 'success'")
  );
});

test("drill: execute mode is staging-only and requires the confirmation string", () => {
  const drill = jobBlock(readWorkflow(), "drill");

  assert.ok(drill.includes("if: github.event_name == 'workflow_dispatch'"));
  assert.ok(
    drill.includes("Only staging rollbacks may be executed by the drill")
  );
  assert.ok(drill.includes("rollback-staging"));
  assert.ok(drill.includes("if: inputs.mode == 'execute'"));
});

test("drill: plan mode is read-only, execute mode rolls back and restores", () => {
  const drill = jobBlock(readWorkflow(), "drill");
  const planStart = drill.indexOf("Fetch deployments and plan the rollback");
  const executeStart = drill.indexOf("Execute rollback (staging only)");
  const planStep = drill.slice(planStart, executeStart);

  assert.ok(planStart > -1 && executeStart > planStart);
  assert.ok(
    !planStep.includes("deploymentRollback"),
    "plan mode must never call the rollback mutation"
  );
  assert.ok(drill.includes("selectRollbackCandidate"));
  assert.ok(drill.includes("deploymentRollback"));
  assert.ok(
    drill.includes("deploymentRedeploy"),
    "a real rollback drill must restore the original head"
  );
  assert.ok(
    drill.includes("if: always() && steps.rollback.outputs.executed == 'true'"),
    "restore must run even when the post-rollback health check fails"
  );
});
