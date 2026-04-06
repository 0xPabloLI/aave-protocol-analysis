function normalizeValue(value) {
  return value ?? '';
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
