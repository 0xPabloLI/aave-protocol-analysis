import { getPool, isPersistenceEnabled } from './dbPool.js';
import { logger } from '../logger.js';

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_THRESHOLD_BYTES = 3 * 1024 * 1024 * 1024; // 3GB
const DEFAULT_RETAIN_DAYS = 7;
const WORKFLOW_ID = 'db-backup.yml';

function getThresholdBytes(): number {
  const env = process.env.ARCHIVE_THRESHOLD_BYTES;
  if (!env) return DEFAULT_THRESHOLD_BYTES;
  const parsed = parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THRESHOLD_BYTES;
}

function getRetainDays(): number {
  const env = process.env.ARCHIVE_RETAIN_DAYS;
  if (!env) return DEFAULT_RETAIN_DAYS;
  const parsed = parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETAIN_DAYS;
}

function getGithubToken(): string | undefined {
  return process.env.GITHUB_ACTIONS_TOKEN;
}

function getRepoInfo(): { owner: string; repo: string } | null {
  const url = process.env.GITHUB_REPOSITORY; // "owner/repo" set by GitHub Actions
  if (!url || !url.includes('/')) return null;
  const [owner, repo] = url.split('/');
  return { owner, repo };
}

export interface ArchiveCheckResult {
  action: 'skipped_no_db' | 'skipped_below_threshold' | 'skipped_no_token' | 'skipped_pending_job' | 'triggered' | 'check_pending' | 'check_running' | 'cleanup_done' | 'cleanup_failed' | 'workflow_failed';
  pgSizeBytes: number;
  thresholdBytes: number;
  workflowRunId?: number;
  jobId?: number;
}

async function getPgSizeBytes(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ pg_database_size: bigint }>(
    `SELECT pg_database_size(current_database()) AS pg_database_size`
  );
  return Number(result.rows[0].pg_database_size);
}

async function hasPendingArchiveJob(): Promise<{ id: number; workflowRunId: number | null } | null> {
  const pool = getPool();
  const result = await pool.query<{ id: number; workflow_run_id: number | null }>(
    `SELECT id, workflow_run_id FROM archive_jobs WHERE status = 'pending' ORDER BY triggered_at DESC LIMIT 1`
  );
  const row = result.rows[0];
  return row ? { id: row.id, workflowRunId: row.workflow_run_id } : null;
}

async function hasRunningArchiveJob(): Promise<{ id: number; workflowRunId: number } | null> {
  const pool = getPool();
  const result = await pool.query<{ id: number; workflow_run_id: number }>(
    `SELECT id, workflow_run_id FROM archive_jobs WHERE status = 'running' ORDER BY triggered_at DESC LIMIT 1`
  );
  const row = result.rows[0];
  return row ? { id: row.id, workflowRunId: row.workflow_run_id } : null;
}

async function insertArchiveJob(pgSizeBytes: number): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ id: number }>(
    `INSERT INTO archive_jobs (triggered_at, status, pg_size_bytes) VALUES (NOW(), 'pending', $1) RETURNING id`,
    [pgSizeBytes]
  );
  return result.rows[0].id;
}

async function updateArchiveJob(jobId: number, updates: Record<string, unknown>): Promise<void> {
  const pool = getPool();
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(updates)) {
    sets.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  values.push(jobId);
  await pool.query(
    `UPDATE archive_jobs SET ${sets.join(', ')} WHERE id = $${idx}`,
    values
  );
}

async function triggerArchiveWorkflow(): Promise<number> {
  const token = getGithubToken();
  if (!token) throw new Error('GITHUB_ACTIONS_TOKEN not configured');
  const repoInfo = getRepoInfo();
  if (!repoInfo) throw new Error('GITHUB_REPOSITORY not configured');

  const url = `${GITHUB_API_BASE}/repos/${repoInfo.owner}/${repoInfo.repo}/actions/workflows/${WORKFLOW_ID}/dispatches`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'railway', inputs: { mode: 'archive' } }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub workflow_dispatch failed (${response.status}): ${body}`);
  }

  const runId = await findLatestWorkflowRun(token, repoInfo);
  return runId;
}

async function findLatestWorkflowRun(
  token: string,
  repoInfo: { owner: string; repo: string }
): Promise<number> {
  const url = `${GITHUB_API_BASE}/repos/${repoInfo.owner}/${repoInfo.repo}/actions/workflows/${WORKFLOW_ID}/runs?per_page=1&event=workflow_dispatch`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`Failed to list workflow runs (${response.status})`);
  const data = await response.json() as { workflow_runs: Array<{ id: number }> };
  if (!data.workflow_runs?.length) throw new Error('No workflow runs found');
  return data.workflow_runs[0].id;
}

async function checkWorkflowRunStatus(runId: number): Promise<{ status: string; conclusion: string | null }> {
  const token = getGithubToken();
  if (!token) throw new Error('GITHUB_ACTIONS_TOKEN not configured');
  const repoInfo = getRepoInfo();
  if (!repoInfo) throw new Error('GITHUB_REPOSITORY not configured');

  const url = `${GITHUB_API_BASE}/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${runId}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`Failed to check workflow run ${runId} (${response.status})`);
  const data = await response.json() as { status: string; conclusion: string | null };
  return { status: data.status, conclusion: data.conclusion };
}

async function cleanupPostgres(retainDays: number): Promise<void> {
  const pool = getPool();
  const cutoff = `NOW() - INTERVAL '${retainDays} days'`;

  const tables = [
    { table: 'market_snapshots', timeCol: 'snapshot_ts' },
    { table: 'oracle_prices', timeCol: 'snapshot_ts' },
  ];

  for (const { table, timeCol } of tables) {
    logger.info(`Cleaning ${table}: deleting rows older than ${retainDays} days`);
    const deleteResult = await pool.query(
      `DELETE FROM ${table} WHERE ${timeCol} < ${cutoff}`
    );
    logger.info(`Deleted ${deleteResult.rowCount} rows from ${table}`);
    await pool.query(`VACUUM ${table}`);
    logger.info(`VACUUM ${table} completed`);
  }

  logger.info('Also cleaning stale oracle_source_configs duplicates');
  await pool.query(`
    DELETE FROM oracle_source_configs a USING oracle_source_configs b
    WHERE a.id > b.id
      AND a.source = b.source
      AND a.pool_key = b.pool_key
      AND a.chain_id = b.chain_id
      AND a.pool_address = b.pool_address
      AND a.oracle_address = b.oracle_address
      AND a.spoke_address = b.spoke_address
  `);
  await pool.query(`VACUUM oracle_source_configs`);
  logger.info('oracle_source_configs dedup + VACUUM completed');
}

export async function runArchiveCheck(): Promise<ArchiveCheckResult> {
  if (!isPersistenceEnabled()) {
    return { action: 'skipped_no_db', pgSizeBytes: 0, thresholdBytes: getThresholdBytes() };
  }

  const pgSizeBytes = await getPgSizeBytes();
  const thresholdBytes = getThresholdBytes();

  if (pgSizeBytes < thresholdBytes) {
    return { action: 'skipped_below_threshold', pgSizeBytes, thresholdBytes };
  }

  if (!getGithubToken()) {
    logger.warn('DB size exceeds threshold but GITHUB_ACTIONS_TOKEN not configured; skipping archive');
    return { action: 'skipped_no_token', pgSizeBytes, thresholdBytes };
  }

  const pendingJob = await hasPendingArchiveJob();
  if (pendingJob) {
    return { action: 'skipped_pending_job', pgSizeBytes, thresholdBytes, jobId: pendingJob.id };
  }

  const runningJob = await hasRunningArchiveJob();
  if (runningJob) {
    const runStatus = await checkWorkflowRunStatus(runningJob.workflowRunId);
    if (runStatus.status !== 'completed') {
      return { action: 'check_running', pgSizeBytes, thresholdBytes, workflowRunId: runningJob.workflowRunId, jobId: runningJob.id };
    }

    if (runStatus.conclusion === 'success') {
      try {
        const retainDays = getRetainDays();
        await cleanupPostgres(retainDays);
        await updateArchiveJob(runningJob.id, { status: 'succeeded', cleaned_at: new Date().toISOString() });
        logger.info(`Archive cleanup succeeded for job ${runningJob.id}`);
        return { action: 'cleanup_done', pgSizeBytes, thresholdBytes, workflowRunId: runningJob.workflowRunId, jobId: runningJob.id };
      } catch (cleanupError) {
        const msg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        await updateArchiveJob(runningJob.id, { status: 'failed', error_message: msg });
        logger.error(`Archive cleanup failed for job ${runningJob.id}: ${msg}`);
        return { action: 'cleanup_failed', pgSizeBytes, thresholdBytes, workflowRunId: runningJob.workflowRunId, jobId: runningJob.id };
      }
    } else {
      const msg = `Workflow run ${runningJob.workflowRunId} concluded with: ${runStatus.conclusion}`;
      await updateArchiveJob(runningJob.id, { status: 'failed', error_message: msg });
      logger.error(`Archive workflow failed: ${msg}`);
      return { action: 'workflow_failed', pgSizeBytes, thresholdBytes, workflowRunId: runningJob.workflowRunId, jobId: runningJob.id };
    }
  }

  try {
    const workflowRunId = await triggerArchiveWorkflow();
    const jobId = await insertArchiveJob(pgSizeBytes);
    await updateArchiveJob(jobId, { status: 'running', workflow_run_id: workflowRunId });
    logger.info(`Triggered archive workflow (run ${workflowRunId}), job ${jobId}`);
    return { action: 'triggered', pgSizeBytes, thresholdBytes, workflowRunId, jobId };
  } catch (triggerError) {
    const msg = triggerError instanceof Error ? triggerError.message : String(triggerError);
    const jobId = await insertArchiveJob(pgSizeBytes);
    await updateArchiveJob(jobId, { status: 'failed', error_message: msg });
    logger.error(`Failed to trigger archive workflow: ${msg}`);
    return { action: 'skipped_no_token', pgSizeBytes, thresholdBytes, jobId };
  }
}

export { getThresholdBytes, getRetainDays, getPgSizeBytes, cleanupPostgres };
