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
 *   5. the drill must restore the head deployment after a real rollback;
 *   6. recovery uses `deploymentRedeploy`, because every `deploymentRollback`
 *      on 2026-11-16 left the service down for 10m43s or longer.
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

/** The lines of a named step inside a job block. */
function stepBlock(job: string, step: string): string {
  const lines = job.split("\n");
  const start = lines.findIndex((line) => line === `      - name: ${step}`);
  if (start === -1) {
    throw new Error(`step "${step}" not found in the job block`);
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^ {6}- /.test(line)
  );

  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("workflow: exposes a plan/execute drill with an explicit confirmation input", () => {
  const workflow = readWorkflow();
  const dispatch = workflow.slice(
    workflow.indexOf("  workflow_dispatch:"),
    workflow.indexOf("\npermissions:")
  );

  assert.ok(dispatch.length > 0, "workflow_dispatch block not found");
  assert.ok(dispatch.includes("      environment:"));
  assert.ok(dispatch.includes("      mode:"));
  assert.ok(dispatch.includes("      confirm:"));
  assert.match(dispatch, /options:\s*\n\s*- staging\s*\n\s*- production/);
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

test("rollback: the workflow never calls deploymentRollback", () => {
  const workflow = readWorkflow();

  assert.ok(
    !workflow.includes("mutation($id: String!) { deploymentRollback"),
    "deploymentRollback never served within 30 minutes on 2026-11-16; keep it in the runbook, not the automated path"
  );
  assert.ok(
    !workflow.includes(".data.deploymentRollback"),
    "no workflow step may read a deploymentRollback response"
  );
});

test("rollback: the production gate is evaluated before the recovery mutation", () => {
  const rollback = jobBlock(readWorkflow(), "rollback");
  const mutationQuery =
    "mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }";
  const gateIndex = rollback.indexOf("resolveRollbackGate");
  const mutationIndex = rollback.indexOf(mutationQuery);

  assert.ok(gateIndex > -1, "rollback job must call resolveRollbackGate");
  assert.ok(mutationIndex > -1, "rollback job must call deploymentRedeploy");
  assert.ok(
    gateIndex < mutationIndex,
    "the gate must run before the mutation, not after it"
  );
  assert.equal(
    rollback.split(mutationQuery).length - 1,
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
  const validate = stepBlock(drill, "Validate drill request");
  const plan = stepBlock(drill, "Fetch deployments and plan the rollback");

  assert.ok(drill.includes("if: github.event_name == 'workflow_dispatch'"));
  assert.ok(validate.includes('"$DRILL_ENVIRONMENT" != "staging"'));
  assert.ok(validate.includes("exit 1"));
  assert.ok(validate.includes("rollback-staging"));
  assert.ok(drill.includes("if: inputs.mode == 'execute'"));
  assert.ok(
    plan.includes('"$DRILL_MODE" = "execute"') &&
      plan.includes('"$GATE_ALLOWED" != "true"'),
    "execute must fail closed when the gate is closed, even if the staging check changes"
  );
});

test("rollback: a drill and a smoke rollback share one environment mutex", () => {
  const workflow = readWorkflow();
  const rollback = jobBlock(workflow, "rollback");
  const drill = jobBlock(workflow, "drill");

  assert.ok(
    rollback.includes(
      "group: railway-rollback-${{ needs.smoke-test.outputs.environment_label }}"
    )
  );
  assert.ok(
    drill.includes("group: railway-rollback-${{ inputs.environment }}")
  );
  assert.ok(
    !drill.includes("rollback-drill-"),
    "a separate drill group could mutate the same environment concurrently with a real rollback"
  );
});

test("rollback: the plan writes head/target/eligible to the step summary", () => {
  const rollback = jobBlock(readWorkflow(), "rollback");

  assert.ok(
    rollback.includes("$GITHUB_STEP_SUMMARY"),
    "the eligible count must reach the run summary, not only the log"
  );
  assert.ok(rollback.includes("${ELIGIBLE_COUNT}"));
  assert.ok(rollback.includes("${ROLLBACK_REASON}"));
});

test("rollback: the deployments window is wide enough for recovery copies", () => {
  const workflow = readWorkflow();

  assert.equal(
    workflow.split("first: 10").length - 1,
    2,
    "both deployments queries must inspect 10 edges; five can be exhausted by recovery copies"
  );
});

test("rollback: shared Railway query literals and success predicates stay in sync", () => {
  const workflow = readWorkflow();
  const deploymentsQuery =
    "query($input: DeploymentListInput!, $first: Int) { deployments(input: $input, first: $first) { edges { node { id status createdAt canRollback meta } } } }";
  const redeployMutation =
    "mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }";
  const redeploySucceeded =
    '.data.deploymentRedeploy.id != null and .data.deploymentRedeploy.id != ""';

  assert.equal(
    workflow.split(deploymentsQuery).length - 1,
    2,
    "the rollback job and the drill plan must use the exact same deployments query"
  );
  assert.equal(
    workflow.split(redeployMutation).length - 1,
    3,
    "auto-rollback, drill execute and restore must use the exact same redeploy mutation"
  );
  assert.equal(
    workflow.split(redeploySucceeded).length - 1,
    3,
    "every redeploy response check must use the same non-empty id predicate"
  );
  assert.ok(
    !workflow.includes("jq -e '.data.deploymentRedeploy.id'"),
    "a bare truthiness check accepts a null id; use the shared predicate"
  );
});

test("drill: plan mode is read-only, execute mode rolls back and restores", () => {
  const drill = jobBlock(readWorkflow(), "drill");
  const planStep = stepBlock(drill, "Fetch deployments and plan the rollback");
  const executeStep = stepBlock(drill, "Execute rollback (staging only)");
  const restoreStep = stepBlock(drill, "Restore the original head deployment");
  const waitRollback = stepBlock(
    drill,
    "Wait for the rolled-back commit to serve"
  );
  const waitRestore = stepBlock(
    drill,
    "Wait for the restored head commit to serve"
  );

  assert.ok(
    !planStep.includes("deploymentRedeploy"),
    "plan mode must never call the recovery mutation"
  );
  assert.ok(planStep.includes("selectRollbackCandidate"));
  assert.ok(executeStep.includes("deploymentRedeploy"));
  assert.ok(
    restoreStep.includes("deploymentRedeploy"),
    "a real rollback drill must restore the original head"
  );
  assert.ok(
    restoreStep.includes(
      "if: always() && steps.rollback.outputs.executed == 'true'"
    ),
    "restore must run even when the post-rollback health check fails"
  );
  assert.ok(waitRollback.includes("wait-for-commit-sha.sh"));
  assert.ok(waitRestore.includes("wait-for-commit-sha.sh"));
  assert.ok(
    waitRollback.includes('"$EXPECTED_SHA" 30 10'),
    "a redeploy served in 40-72s on 2026-11-16; the wait allows five minutes"
  );
  assert.ok(waitRestore.includes('"$EXPECTED_SHA" 30 10'));
});
