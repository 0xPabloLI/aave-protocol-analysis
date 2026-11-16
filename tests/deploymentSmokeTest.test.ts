/**
 * Deployment smoke test target resolution
 * (`.github/scripts/deployment-smoke-test-helpers.mjs`) — AAV-1294.
 *
 * The smoke test reported success for every deployment it ever processed while
 * running no checks at all. `resolveDeploymentTarget` matched the deployment
 * `ref` against a branch name, and the `environment` against a bare
 * `staging` / `production`:
 *
 *   ref         = "9596f8b2583f99780ec4b587328fee73ee10b3a8"  (a commit SHA)
 *   environment = "aaveapy / staging"                         (project-prefixed)
 *
 * Neither shape ever matches: Railway reports `ref` as the commit SHA and names
 * the environment `"<project> / <environment>"`. `shouldRun` was therefore false
 * for all 100 deployments in the repository history (85 staging, 15 production),
 * every run skipped all four checks, and the job still reported success — 43
 * green runs that verified nothing.
 *
 * The cases at the bottom pin those two real payload shapes. The first four
 * cases pin the behaviour that already worked.
 *
 * These cases previously lived in `.github/scripts/*.test.mjs`. No runner
 * executes that path — the root runner globs `tests/*.test.ts`, and
 * `check:test-naming` scanned only `.test.ts` — so the file passed while
 * covering nothing. That is why they now live here, where `npm test` runs them.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createSmokeTestIssuePayload,
  isCommitSha,
  normalizeEnvironmentName,
  resolveDeploymentTarget,
  resolveRollbackGate,
  selectRailwayRollbackTarget,
  selectRollbackCandidate,
} from "../.github/scripts/deployment-smoke-test-helpers.mjs";

// Real values from a Railway deployment_status event in this repository.
const RAILWAY_SHA = "9596f8b2583f99780ec4b587328fee73ee10b3a8";
const RAILWAY_STAGING_ENVIRONMENT = "aaveapy / staging";
const RAILWAY_PRODUCTION_ENVIRONMENT = "aaveapy / production";

// ── environment normalisation ────────────────────────────────────────────────

test("normalizeEnvironmentName: strips the Railway project prefix", () => {
  assert.equal(
    normalizeEnvironmentName(RAILWAY_STAGING_ENVIRONMENT),
    "staging"
  );
  assert.equal(
    normalizeEnvironmentName(RAILWAY_PRODUCTION_ENVIRONMENT),
    "production"
  );
});

test("normalizeEnvironmentName: accepts a bare name, trims and lowercases it", () => {
  assert.equal(normalizeEnvironmentName("staging"), "staging");
  assert.equal(normalizeEnvironmentName("  PRODUCTION  "), "production");
  assert.equal(normalizeEnvironmentName("AAveapy / Staging"), "staging");
});

test("normalizeEnvironmentName: empty and trailing-separator inputs yield no name", () => {
  assert.equal(normalizeEnvironmentName(""), "");
  assert.equal(normalizeEnvironmentName(undefined), "");
  assert.equal(normalizeEnvironmentName("   "), "");
  assert.equal(normalizeEnvironmentName("aaveapy /"), "");
});

test("isCommitSha: true for SHAs, false for branch names", () => {
  assert.equal(isCommitSha(RAILWAY_SHA), true);
  assert.equal(isCommitSha(RAILWAY_SHA.slice(0, 7)), true);
  assert.equal(isCommitSha("railway"), false);
  assert.equal(isCommitSha("main"), false);
  assert.equal(isCommitSha(""), false);
});

// ── target resolution: the two shapes Railway actually sends ─────────────────

test("resolveDeploymentTarget: the real staging payload resolves to staging", () => {
  const target = resolveDeploymentTarget({
    ref: RAILWAY_SHA,
    sha: RAILWAY_SHA,
    environment: RAILWAY_STAGING_ENVIRONMENT,
  });

  assert.deepEqual(target, {
    shouldRun: true,
    // `ref` is a SHA, so the branch is derived from the environment rather than
    // copied out of `ref` — otherwise the summary would label a SHA as a branch.
    deployBranch: "railway",
    deploySha: RAILWAY_SHA,
    environmentLabel: "staging",
    environmentName: "staging",
    refKind: "sha",
    apiBaseUrl: "https://staging-api.aaveapy.com",
    siteUrl: "https://staging.aaveapy.com",
  });
});

test("resolveDeploymentTarget: the real production payload resolves to production", () => {
  const target = resolveDeploymentTarget({
    ref: RAILWAY_SHA,
    sha: RAILWAY_SHA,
    environment: RAILWAY_PRODUCTION_ENVIRONMENT,
  });

  assert.equal(target.shouldRun, true);
  assert.equal(target.environmentLabel, "production");
  assert.equal(target.deployBranch, "main");
  assert.equal(target.apiBaseUrl, "https://api.aaveapy.com");
  assert.equal(target.siteUrl, "https://aaveapy.com");
});

test("resolveDeploymentTarget: the environment wins when ref and environment disagree", () => {
  const target = resolveDeploymentTarget({
    ref: "main",
    sha: RAILWAY_SHA,
    environment: RAILWAY_STAGING_ENVIRONMENT,
  });

  assert.equal(target.environmentLabel, "staging");
  assert.equal(target.apiBaseUrl, "https://staging-api.aaveapy.com");
});

test("resolveDeploymentTarget: an unclassified environment is not a silent pass", () => {
  const target = resolveDeploymentTarget({
    ref: RAILWAY_SHA,
    sha: RAILWAY_SHA,
    environment: "aaveapy / preview",
  });

  assert.equal(target.shouldRun, false);
  assert.equal(target.environmentLabel, "");
  // The normalised name is reported so the skip is diagnosable rather than mute.
  assert.equal(target.environmentName, "preview");
  assert.equal(target.refKind, "sha");
});

// ── target resolution: branch-ref senders still work ─────────────────────────

test("resolveDeploymentTarget: falls back to production when the ref is empty", () => {
  const target = resolveDeploymentTarget({
    ref: "",
    sha: "1234567890abcdef",
    environment: "production",
  });

  assert.deepEqual(target, {
    shouldRun: true,
    deployBranch: "main",
    deploySha: "1234567890abcdef",
    environmentLabel: "production",
    environmentName: "production",
    refKind: "none",
    apiBaseUrl: "https://api.aaveapy.com",
    siteUrl: "https://aaveapy.com",
  });
});

test("resolveDeploymentTarget: a branch ref is used as-is when the environment is unknown", () => {
  const target = resolveDeploymentTarget({
    ref: "railway",
    sha: RAILWAY_SHA,
    environment: "preview",
  });

  assert.equal(target.shouldRun, true);
  assert.equal(target.environmentLabel, "staging");
  assert.equal(target.deployBranch, "railway");
  assert.equal(target.refKind, "branch");
});

test("resolveDeploymentTarget: skips deployments that are not staging or production", () => {
  const target = resolveDeploymentTarget({
    ref: "",
    sha: "1234567890abcdef",
    environment: "preview",
  });

  assert.deepEqual(target, {
    shouldRun: false,
    deployBranch: "",
    deploySha: "1234567890abcdef",
    environmentLabel: "",
    environmentName: "preview",
    refKind: "none",
    apiBaseUrl: "",
    siteUrl: "",
  });
});

test("resolveDeploymentTarget: falls back to the ref for the SHA when sha is missing", () => {
  const target = resolveDeploymentTarget({
    ref: RAILWAY_SHA,
    sha: "",
    environment: RAILWAY_STAGING_ENVIRONMENT,
  });

  assert.equal(target.deploySha, RAILWAY_SHA);
});

// ── rollback target selection ────────────────────────────────────────────────

test("selectRailwayRollbackTarget: uses production secrets for production", () => {
  const target = selectRailwayRollbackTarget("production", {
    production: {
      projectId: "",
      serviceId: "prod-service",
      environmentId: "prod-environment",
    },
    staging: {
      projectId: "staging-project",
      serviceId: "staging-service",
      environmentId: "staging-environment",
    },
  });

  assert.deepEqual(target, {
    environmentLabel: "production",
    projectId: "",
    serviceId: "prod-service",
    environmentId: "prod-environment",
  });
});

test("selectRailwayRollbackTarget: a resolved staging deployment never selects production", () => {
  const secrets = {
    production: {
      projectId: "prod-project",
      serviceId: "prod-service",
      environmentId: "prod-environment",
    },
    staging: {
      projectId: "staging-project",
      serviceId: "staging-service",
      environmentId: "staging-environment",
    },
  };

  const resolved = resolveDeploymentTarget({
    ref: RAILWAY_SHA,
    sha: RAILWAY_SHA,
    environment: RAILWAY_STAGING_ENVIRONMENT,
  });
  const rollback = selectRailwayRollbackTarget(
    resolved.environmentLabel,
    secrets
  );

  assert.equal(rollback.environmentLabel, "staging");
  assert.equal(rollback.projectId, "staging-project");
});

// ── failure issue payload ────────────────────────────────────────────────────

test("createSmokeTestIssuePayload: skipped title when rollback was not executed", () => {
  const payload = createSmokeTestIssuePayload({
    environment: "staging",
    sha: "1234567890abcdef",
    runUrl: "https://example.com/run",
    rollbackExecuted: "false",
    rollbackOutcome: "success",
  });

  assert.equal(
    payload.title,
    "🚨 staging smoke test failed — rollback skipped"
  );
  assert.match(payload.body, /Rollback skipped — secrets not configured/);
});

test("createSmokeTestIssuePayload: failure title when the rollback attempt failed", () => {
  const payload = createSmokeTestIssuePayload({
    environment: "production",
    sha: "fedcba0987654321",
    runUrl: "https://example.com/run",
    rollbackExecuted: "false",
    rollbackOutcome: "failure",
  });

  assert.equal(
    payload.title,
    "🚨 production smoke test failed — auto-rollback failed"
  );
  assert.match(
    payload.body,
    /Auto-rollback failed — manual intervention required/
  );
});

test("createSmokeTestIssuePayload: success title when the rollback executed", () => {
  const payload = createSmokeTestIssuePayload({
    environment: "staging",
    sha: "1234567890abcdef",
    runUrl: "https://example.com/run",
    rollbackExecuted: "true",
    rollbackOutcome: "success",
  });

  assert.equal(
    payload.title,
    "🚨 staging smoke test failed — auto-rollback succeeded"
  );
  assert.match(
    payload.body,
    /Auto-rollback succeeded — previous deployment restored/
  );
});

test("createSmokeTestIssuePayload: gated title wins over a failed rollback outcome", () => {
  const payload = createSmokeTestIssuePayload({
    environment: "production",
    sha: "fedcba0987654321",
    runUrl: "https://example.com/run",
    rollbackExecuted: "false",
    rollbackOutcome: "failure",
    rollbackGated: "true",
  });

  assert.equal(
    payload.title,
    "🚨 production smoke test failed — auto-rollback GATED (manual action required)"
  );
  assert.match(payload.body, /Auto-rollback gated/);
  assert.match(payload.body, /RAILWAY_PRODUCTION_ROLLBACK_ENABLED/);
});

test("createSmokeTestIssuePayload: gated accepts a boolean true as well as the output string", () => {
  const payload = createSmokeTestIssuePayload({
    environment: "production",
    sha: "fedcba0987654321",
    runUrl: "https://example.com/run",
    rollbackExecuted: "false",
    rollbackOutcome: "success",
    rollbackGated: true,
  });

  assert.match(payload.title, /auto-rollback GATED/);
});

// ── rollback target selection: real Railway payloads ─────────────────────────
//
// Captured 2026-11-16 with the same `deployments(input:, first: 5)` query the
// workflow runs. Only the fields the selector reads are kept. The head is the
// first edge; Railway returns newest first.

const STAGING_EDGES = [
  {
    node: {
      id: "49e5f677-5755-4e9f-a25d-2d3829b030ae",
      status: "SUCCESS",
      createdAt: "2026-11-16T04:02:17.573Z",
      canRollback: true,
      meta: { commitHash: "5ceb6e65ebe2826ab23a79a315a05260d867f918" },
    },
  },
  {
    node: {
      id: "b211ea61-3dbf-4560-b9fb-5517c8188524",
      status: "REMOVED",
      createdAt: "2026-11-16T01:11:47.003Z",
      canRollback: true,
      meta: { commitHash: "878f41e" },
    },
  },
  {
    node: {
      id: "0eadb3dd-ac48-4521-8907-9ab97388852a",
      status: "REMOVED",
      createdAt: "2026-11-15T15:03:52.683Z",
      canRollback: true,
      meta: { commitHash: "91a36af" },
    },
  },
];

const PRODUCTION_EDGES = [
  {
    node: {
      id: "1586d53f-c8ac-46ad-9e16-22ffe458ff1a",
      status: "SUCCESS",
      createdAt: "2026-11-15T13:02:29.843Z",
      canRollback: true,
      meta: { commitHash: "4ab7243fd39df7d771c9ad6656cb31025dc6cce2" },
    },
  },
  {
    node: {
      id: "6195f301-ab73-4f8f-aba6-6cc52b72edd5",
      status: "REMOVED",
      createdAt: "2026-11-11T08:02:09.370Z",
      canRollback: true,
      meta: { commitHash: "192c3dc" },
    },
  },
  {
    node: {
      id: "500bec81-2aa7-47aa-b589-3bc757d435ae",
      status: "REMOVED",
      createdAt: "2026-11-11T07:16:57.119Z",
      canRollback: false,
      meta: { commitHash: "81c0328" },
    },
  },
];

test("selectRollbackCandidate: real staging payload selects the previous deployment, never the head", () => {
  const plan = selectRollbackCandidate(STAGING_EDGES);

  assert.deepEqual(plan, {
    headId: "49e5f677-5755-4e9f-a25d-2d3829b030ae",
    targetId: "b211ea61-3dbf-4560-b9fb-5517c8188524",
    targetCommit: "878f41e",
    targetStatus: "REMOVED",
    targetCreatedAt: "2026-11-16T01:11:47.003Z",
    eligibleCount: 3,
    reason: "selected",
  });
});

test("selectRollbackCandidate: real production payload selects the previous deployment", () => {
  const plan = selectRollbackCandidate(PRODUCTION_EDGES);

  assert.equal(plan.headId, "1586d53f-c8ac-46ad-9e16-22ffe458ff1a");
  assert.equal(plan.targetId, "6195f301-ab73-4f8f-aba6-6cc52b72edd5");
  assert.equal(plan.targetCommit, "192c3dc");
  assert.equal(plan.eligibleCount, 2);
  assert.equal(plan.reason, "selected");
});

test("selectRollbackCandidate: a head-only canRollback list fails closed instead of redeploying the broken head", () => {
  const plan = selectRollbackCandidate([
    {
      node: {
        id: "broken-head",
        status: "SUCCESS",
        createdAt: "2026-11-16T04:00:00.000Z",
        canRollback: true,
        meta: { commitHash: "badc0de" },
      },
    },
  ]);

  assert.equal(plan.headId, "broken-head");
  assert.equal(plan.targetId, "");
  assert.equal(plan.eligibleCount, 1);
  assert.equal(plan.reason, "only-head-eligible");
});

test("selectRollbackCandidate: a rollback head fails closed instead of looping", () => {
  const plan = selectRollbackCandidate([
    {
      node: {
        id: "rollback-head",
        status: "REMOVED",
        createdAt: "2026-11-16T05:46:36.786Z",
        canRollback: true,
        meta: { reason: "rollback", commitHash: "5ceb6e6" },
      },
    },
    {
      node: {
        id: "previous-deploy",
        status: "REMOVED",
        createdAt: "2026-11-16T05:40:13.159Z",
        canRollback: true,
        meta: { reason: "deploy", commitHash: "61879da" },
      },
    },
  ]);

  assert.equal(plan.headId, "rollback-head");
  assert.equal(plan.targetId, "");
  assert.equal(plan.eligibleCount, 2);
  assert.equal(plan.reason, "head-is-rollback");
});

test("selectRollbackCandidate: no canRollback deployment has no target", () => {
  const plan = selectRollbackCandidate([
    {
      node: {
        id: "head",
        status: "SUCCESS",
        createdAt: "2026-11-16T04:00:00.000Z",
        canRollback: false,
      },
    },
    {
      node: {
        id: "older",
        status: "REMOVED",
        createdAt: "2026-11-15T04:00:00.000Z",
        canRollback: false,
      },
    },
  ]);

  assert.equal(plan.targetId, "");
  assert.equal(plan.eligibleCount, 0);
  assert.equal(plan.reason, "no-eligible-deployment");
});

test("selectRollbackCandidate: empty and malformed lists do not throw", () => {
  for (const edges of [[], undefined, null, [null, {}], "not-an-array"]) {
    const plan = selectRollbackCandidate(edges as never);
    assert.equal(plan.targetId, "");
    assert.equal(plan.reason, "no-deployments");
  }
});

test("selectRollbackCandidate: a single non-head eligible deployment is selected", () => {
  const plan = selectRollbackCandidate([
    {
      node: {
        id: "head",
        status: "SUCCESS",
        createdAt: "2026-11-16T04:00:00.000Z",
        canRollback: false,
      },
    },
    {
      node: {
        id: "only-previous",
        status: "REMOVED",
        createdAt: "2026-11-15T04:00:00.000Z",
        canRollback: true,
        meta: { commitHash: "abc1234" },
      },
    },
  ]);

  assert.equal(plan.targetId, "only-previous");
  assert.equal(plan.targetCommit, "abc1234");
  assert.equal(plan.reason, "selected");
});

// ── production rollback gate ─────────────────────────────────────────────────

test("resolveRollbackGate: staging is always allowed", () => {
  assert.deepEqual(
    resolveRollbackGate({
      environmentLabel: "staging",
      productionRollbackEnabled: undefined,
    }),
    { allowed: true, reason: "staging" }
  );
  assert.deepEqual(
    resolveRollbackGate({
      environmentLabel: "STAGING",
      productionRollbackEnabled: "false",
    }),
    { allowed: true, reason: "staging" }
  );
});

test("resolveRollbackGate: production is gated unless the exact literal true is set", () => {
  const gatedValues = [
    undefined,
    null,
    "",
    "false",
    "TRUE",
    "True",
    "1",
    "yes",
    "on",
    " true ",
  ];

  for (const value of gatedValues) {
    assert.deepEqual(
      resolveRollbackGate({
        environmentLabel: "production",
        productionRollbackEnabled: value,
      }),
      { allowed: false, reason: "production-gated" },
      `value ${JSON.stringify(value)} must stay gated`
    );
  }

  assert.deepEqual(
    resolveRollbackGate({
      environmentLabel: "production",
      productionRollbackEnabled: "true",
    }),
    { allowed: true, reason: "production-enabled" }
  );
});

test("resolveRollbackGate: an unknown or empty environment fails closed", () => {
  for (const environmentLabel of [
    "",
    "preview",
    "aaveapy / preview",
    undefined,
  ]) {
    assert.deepEqual(
      resolveRollbackGate({
        environmentLabel,
        productionRollbackEnabled: "true",
      }),
      { allowed: false, reason: "unknown-environment" },
      `environment ${JSON.stringify(environmentLabel)} must stay gated`
    );
  }
});
