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

const ENVIRONMENT_TARGETS = {
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

function getRollbackPresentation(rollbackExecuted, rollbackOutcome) {
  if (rollbackExecuted === "true") {
    return {
      titleSuffix: "auto-rollback succeeded",
      status: "✅ Auto-rollback succeeded — previous deployment restored",
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
}) {
  const rollback = getRollbackPresentation(rollbackExecuted, rollbackOutcome);

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
