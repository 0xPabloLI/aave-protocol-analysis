import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSmokeTestIssuePayload,
  selectRailwayRollbackTarget,
} from './deployment-smoke-test-helpers.mjs';

test('selectRailwayRollbackTarget keeps production selection on main without falling back to staging secrets', () => {
  const target = selectRailwayRollbackTarget('main', {
    production: {
      projectId: '',
      serviceId: 'prod-service',
      environmentId: 'prod-environment',
    },
    staging: {
      projectId: 'staging-project',
      serviceId: 'staging-service',
      environmentId: 'staging-environment',
    },
  });

  assert.deepEqual(target, {
    environmentLabel: 'production',
    projectId: '',
    serviceId: 'prod-service',
    environmentId: 'prod-environment',
  });
});

test('createSmokeTestIssuePayload uses a skipped title when rollback was not executed', () => {
  const payload = createSmokeTestIssuePayload({
    environment: 'staging',
    sha: '1234567890abcdef',
    runUrl: 'https://example.com/run',
    rollbackExecuted: 'false',
    rollbackOutcome: 'success',
  });

  assert.equal(payload.title, '🚨 staging smoke test failed — rollback skipped');
  assert.match(payload.body, /Rollback skipped — secrets not configured/);
});

test('createSmokeTestIssuePayload uses a failure title when rollback attempt failed', () => {
  const payload = createSmokeTestIssuePayload({
    environment: 'production',
    sha: 'fedcba0987654321',
    runUrl: 'https://example.com/run',
    rollbackExecuted: 'false',
    rollbackOutcome: 'failure',
  });

  assert.equal(payload.title, '🚨 production smoke test failed — auto-rollback failed');
  assert.match(payload.body, /Auto-rollback failed — manual intervention required/);
});
