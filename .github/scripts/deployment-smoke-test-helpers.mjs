function normalizeValue(value) {
  return value ?? '';
}

export function resolveDeploymentTarget({ ref, sha, environment }) {
  const normalizedRef = normalizeValue(ref);
  const normalizedEnvironment = normalizeValue(environment).toLowerCase();
  const deploySha = normalizeValue(sha);

  if (normalizedRef === 'main' || normalizedEnvironment === 'production') {
    return {
      shouldRun: true,
      deployBranch: normalizedRef || 'main',
      deploySha,
      environmentLabel: 'production',
      apiBaseUrl: 'https://api.aaveapy.com',
      siteUrl: 'https://aaveapy.com',
    };
  }

  if (normalizedRef === 'railway' || normalizedEnvironment === 'staging') {
    return {
      shouldRun: true,
      deployBranch: normalizedRef || 'railway',
      deploySha,
      environmentLabel: 'staging',
      apiBaseUrl: 'https://staging-api.aaveapy.com',
      siteUrl: 'https://staging.aaveapy.com',
    };
  }

  return {
    shouldRun: false,
    deployBranch: normalizedRef,
    deploySha,
    environmentLabel: '',
    apiBaseUrl: '',
    siteUrl: '',
  };
}

export function selectRailwayRollbackTarget(branch, secrets) {
  const useProduction = branch === 'main';
  const selected = useProduction ? secrets.production : secrets.staging;

  return {
    environmentLabel: useProduction ? 'production' : 'staging',
    projectId: normalizeValue(selected.projectId),
    serviceId: normalizeValue(selected.serviceId),
    environmentId: normalizeValue(selected.environmentId),
  };
}

function getRollbackPresentation(rollbackExecuted, rollbackOutcome) {
  if (rollbackExecuted === 'true') {
    return {
      titleSuffix: 'auto-rollback succeeded',
      status: '✅ Auto-rollback succeeded — previous deployment restored',
    };
  }

  if (rollbackOutcome === 'success') {
    return {
      titleSuffix: 'rollback skipped',
      status: '⚠️ Rollback skipped — secrets not configured, manual intervention required',
    };
  }

  return {
    titleSuffix: 'auto-rollback failed',
    status: '❌ Auto-rollback failed — manual intervention required',
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
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Environment | **${environment}** |`,
      `| Commit | \`${normalizeValue(sha).slice(0, 7)}\` |`,
      `| Rollback | ${rollback.status} |`,
      `| Workflow Run | [View logs](${runUrl}) |`,
      '',
      'Check the workflow logs for details on which check failed.',
    ].join('\n'),
  };
}
