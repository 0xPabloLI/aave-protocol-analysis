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
  selectRailwayRollbackTarget,
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
