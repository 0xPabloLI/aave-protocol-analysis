function normalizeValue(value) {
  return value ?? "";
}

const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Deployment environment names are not uniform across senders. Railway reports
 * `"<project> / <environment>"` (e.g. `"aaveapy / staging"`) while other senders
 * report a bare `"staging"`. Only the final segment names the environment, so
 * matching against the raw string silently fails for every Railway deployment.
 */
export function normalizeEnvironmentName(environment) {
  const raw = normalizeValue(environment).trim();
  if (raw === "") return "";
  const segments = raw.split("/");
  return segments[segments.length - 1].trim().toLowerCase();
}

/**
 * True when a ref is a commit SHA rather than a branch name. Railway reports
 * `deployment.ref` as the 40-hex commit SHA, so it can never be matched against
 * a branch name.
 */
export function isCommitSha(value) {
  return COMMIT_SHA_RE.test(normalizeValue(value).trim());
}

/**
 * Per-environment hosts. Exported so the scheduled uptime probe reads the same
 * definition that deployment verification uses — two mappings would let the
 * post-deploy check and the 15-minute monitor disagree about the endpoint.
 */
export const ENVIRONMENT_TARGETS = {
  production: {
    environmentLabel: "production",
    deployBranch: "main",
    apiBaseUrl: "https://api.aaveapy.com",
    siteUrl: "https://aaveapy.com",
  },
  staging: {
    environmentLabel: "staging",
    deployBranch: "railway",
    apiBaseUrl: "https://staging-api.aaveapy.com",
    siteUrl: "https://staging.aaveapy.com",
  },
};

// Fallback for senders that report a branch name in `ref` instead of a SHA.
const BRANCH_TARGETS = { main: "production", railway: "staging" };

export function resolveDeploymentTarget({ ref, sha, environment }) {
  const normalizedRef = normalizeValue(ref).trim();
  const environmentName = normalizeEnvironmentName(environment);
  const refKind =
    normalizedRef === ""
      ? "none"
      : isCommitSha(normalizedRef)
        ? "sha"
        : "branch";

  // The deployment environment is authoritative. `ref` is only a fallback:
  // Railway reports it as a commit SHA, which carries no branch name.
  const resolvedName = Object.hasOwn(ENVIRONMENT_TARGETS, environmentName)
    ? environmentName
    : refKind === "branch"
      ? BRANCH_TARGETS[normalizedRef]
      : undefined;

  const deploySha =
    normalizeValue(sha).trim() || (refKind === "sha" ? normalizedRef : "");

  if (!resolvedName) {
    return {
      shouldRun: false,
      deployBranch: refKind === "branch" ? normalizedRef : "",
      deploySha,
      environmentLabel: "",
      environmentName,
      refKind,
      apiBaseUrl: "",
      siteUrl: "",
    };
  }

  const target = ENVIRONMENT_TARGETS[resolvedName];

  return {
    shouldRun: true,
    // When `ref` is a SHA the branch is derived from the environment, so the
    // commit is still labelled with the branch that deploys it.
    deployBranch: refKind === "branch" ? normalizedRef : target.deployBranch,
    deploySha,
    environmentLabel: target.environmentLabel,
    environmentName,
    refKind,
    apiBaseUrl: target.apiBaseUrl,
    siteUrl: target.siteUrl,
  };
}

/**
 * Select the Railway project/service/environment IDs for the environment whose
 * deployment failed. This is the *environment* target; `selectRollbackCandidate`
 * below picks the individual deployment inside it.
 */
export function selectRailwayRollbackTarget(targetEnvironment, secrets) {
  const normalizedTargetEnvironment =
    normalizeValue(targetEnvironment).toLowerCase();
  const useProduction = normalizedTargetEnvironment === "production";
  const selected = useProduction ? secrets.production : secrets.staging;

  return {
    environmentLabel: useProduction ? "production" : "staging",
    projectId: normalizeValue(selected.projectId),
    serviceId: normalizeValue(selected.serviceId),
    environmentId: normalizeValue(selected.environmentId),
  };
}

/**
 * Pick the deployment to roll back to from Railway's `deployments` edges.
 *
 * The first edge is the head — the deployment whose smoke test just failed.
 * Rolling back to the head would redeploy the broken commit, so the head is
 * never a candidate. If the head is itself a rollback deployment
 * (`meta.reason === "rollback"`), a second automatic rollback would loop, so
 * the function fails closed with `head-is-rollback` and lets a human decide.
 * When no non-head deployment can roll back, the caller must fail closed
 * (create a manual-intervention issue) instead of retrying the same broken
 * version.
 *
 * Only a release deployment (`meta.reason === "deploy"`) is a rollback target.
 * `redeploy` and `rollback` deployments are recovery copies of an earlier
 * release: rolling back to one is redundant, and it can point at the head's own
 * commit. (The workflow recovers with `deploymentRedeploy` rather than
 * `deploymentRollback`; see the workflow for the 2026-11-16 latency evidence.)
 * A release whose commit equals the head's commit is also skipped — it cannot
 * change what is served.
 *
 * `edges` are passed straight from the GraphQL response; malformed shapes are
 * treated as "no deployments" so a bad response can never select arbitrarily.
 */
export function selectRollbackCandidate(edges) {
  const nodes = Array.isArray(edges)
    ? edges
        .map((edge) => edge?.node)
        .filter((node) => normalizeValue(node?.id).trim() !== "")
    : [];

  if (nodes.length === 0) {
    return {
      headId: "",
      targetId: "",
      targetCommit: "",
      targetStatus: "",
      targetCreatedAt: "",
      eligibleCount: 0,
      reason: "no-deployments",
    };
  }

  const resolvedHeadId = normalizeValue(nodes[0].id).trim();
  const resolvedHeadCommit = normalizeValue(nodes[0].meta?.commitHash).trim();
  const eligible = nodes.filter((node) => node.canRollback === true);
  const headReason = normalizeValue(nodes[0].meta?.reason).trim();

  if (headReason === "rollback") {
    return {
      headId: resolvedHeadId,
      targetId: "",
      targetCommit: "",
      targetStatus: "",
      targetCreatedAt: "",
      eligibleCount: eligible.length,
      reason: "head-is-rollback",
    };
  }

  const nonHeadEligible = eligible.filter(
    (node) => normalizeValue(node.id).trim() !== resolvedHeadId
  );
  const releases = nonHeadEligible.filter(
    (node) => normalizeValue(node.meta?.reason).trim() === "deploy"
  );
  const target = releases.find(
    (node) =>
      normalizeValue(node.meta?.commitHash).trim() !== resolvedHeadCommit
  );

  return {
    headId: resolvedHeadId,
    targetId: target ? normalizeValue(target.id).trim() : "",
    targetCommit: target ? normalizeValue(target.meta?.commitHash).trim() : "",
    targetStatus: target ? normalizeValue(target.status).trim() : "",
    targetCreatedAt: target ? normalizeValue(target.createdAt).trim() : "",
    eligibleCount: eligible.length,
    reason: target
      ? "selected"
      : releases.length > 0
        ? "same-commit-as-head"
        : nonHeadEligible.length > 0
          ? "no-release-deployment"
          : eligible.length > 0
            ? "only-head-eligible"
            : "no-eligible-deployment",
  };
}

function isTrue(value) {
  return value === true || value === "true";
}

/**
 * Production auto-rollback was never exercised before AAV-1295, and the first
 * real use of a recovery path should not be an incident. The gate is closed
 * unless the repository variable holds the exact literal `true`; any other
 * value — including `"TRUE"`, `"1"` and an unset variable — is gated.
 * Staging is always allowed: that is where the drill runs.
 */
export function resolveRollbackGate({
  environmentLabel,
  productionRollbackEnabled,
}) {
  const environment = normalizeValue(environmentLabel).trim().toLowerCase();

  if (environment === "staging") {
    return { allowed: true, reason: "staging" };
  }

  if (environment === "production") {
    return isTrue(productionRollbackEnabled)
      ? { allowed: true, reason: "production-enabled" }
      : { allowed: false, reason: "production-gated" };
  }

  return { allowed: false, reason: "unknown-environment" };
}

function getRollbackPresentation({
  rollbackExecuted,
  rollbackOutcome,
  rollbackGated,
}) {
  if (isTrue(rollbackGated)) {
    return {
      titleSuffix: "auto-rollback GATED (manual action required)",
      status:
        "⛔ Auto-rollback gated — production rollback requires explicit confirmation (`RAILWAY_PRODUCTION_ROLLBACK_ENABLED`).",
    };
  }

  if (isTrue(rollbackExecuted)) {
    return {
      titleSuffix: "auto-rollback accepted",
      status:
        "✅ Auto-rollback accepted — Railway is redeploying the previous release; confirm `/health` after warm-up",
    };
  }

  if (rollbackOutcome === "success") {
    return {
      titleSuffix: "rollback skipped",
      status:
        "⚠️ Rollback skipped — secrets not configured, manual intervention required",
    };
  }

  return {
    titleSuffix: "auto-rollback failed",
    status: "❌ Auto-rollback failed — manual intervention required",
  };
}

export function createSmokeTestIssuePayload({
  environment,
  sha,
  runUrl,
  rollbackExecuted,
  rollbackOutcome,
  rollbackGated,
}) {
  const rollback = getRollbackPresentation({
    rollbackExecuted,
    rollbackOutcome,
    rollbackGated,
  });

  return {
    title: `🚨 ${environment} smoke test failed — ${rollback.titleSuffix}`,
    body: [
      `## Smoke Test Failure (${environment})`,
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Environment | **${environment}** |`,
      `| Commit | \`${normalizeValue(sha).slice(0, 7)}\` |`,
      `| Rollback | ${rollback.status} |`,
      `| Workflow Run | [View logs](${runUrl}) |`,
      "",
      "Check the workflow logs for details on which check failed.",
    ].join("\n"),
  };
}
