#!/usr/bin/env node
/**
 * CI build-duration trend + regression detection (AAV-1290).
 *
 * `ci.yml` records each run's duration in its own step summary, but a single
 * run cannot say whether that number is normal. This script samples the build
 * stage of recent runs of one workflow from the Actions API, compares the
 * current run against their median, and prints the trend.
 *
 * It is invoked by `.github/workflows/test-canary.yml`, which owns the issue
 * side-effect (open / update / close) so that the alerting channel stays in one
 * place. Only same-workflow runs are sampled, keeping the series
 * apples-to-apples — `ci.yml` measures a different command.
 *
 * The process always exits 0: a broken trend reading must never fail the
 * canary, which exists to detect flaky tests.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";

/** Median of a numeric sample, rounded to a whole second. `null` when empty. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * A regression must clear *both* bars:
 *
 * - `current > baseline * ratio` — a proportional jump
 * - `current - baseline > minDelta` — an absolute jump, so a 1s → 3s wobble on
 *   a tiny baseline stays quiet while a 400s build on a 100s baseline fires
 *
 * and it needs at least `minSamples` historical runs before it can fire at all,
 * so the first couple of canary runs cannot produce a spurious issue.
 */
export function decideRegression({
  current,
  baseline,
  sampleCount,
  ratio,
  minDelta,
  minSamples,
}) {
  if (sampleCount < minSamples) {
    return {
      regressed: false,
      reason: `only ${sampleCount} sample(s), need ${minSamples}`,
    };
  }
  if (!(baseline > 0)) {
    return { regressed: false, reason: "baseline is not usable" };
  }
  const ratioBreached = current > baseline * ratio;
  const deltaBreached = current - baseline > minDelta;
  if (ratioBreached && deltaBreached) {
    return {
      regressed: true,
      reason: `${current}s exceeds ${baseline}s × ${ratio} and +${minDelta}s`,
    };
  }
  return {
    regressed: false,
    reason: `ratio breached: ${ratioBreached}, delta breached: ${deltaBreached}`,
  };
}

/** Markdown block for the workflow run summary. */
export function renderTrendMarkdown({
  current,
  baseline,
  samples,
  serverUrl,
  owner,
  repo,
}) {
  const lines = [
    "## Build duration trend",
    "",
    `Current run: **${current}s**` +
      (baseline === null
        ? " — no baseline yet"
        : ` | median of last ${samples.length}: **${baseline}s**`),
    "",
  ];

  if (samples.length > 0) {
    lines.push(
      "| Run | Date | Build | vs median |",
      "| --- | ---- | ----- | --------- |"
    );
    for (const sample of samples) {
      const delta = sample.seconds - baseline;
      lines.push(
        `| [${sample.runId}](${serverUrl}/${owner}/${repo}/actions/runs/${sample.runId}) ` +
          `| ${String(sample.date).slice(0, 10)} | ${sample.seconds}s ` +
          `| ${delta >= 0 ? "+" : ""}${delta}s |`
      );
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

async function apiGet({ fetchImpl, url, token }) {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} → HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Build the sample series from recent successful runs of `workflow`.
 * Runs that never reached the step, or whose step did not succeed, are skipped
 * rather than counted as zero.
 */
export async function collectSamples({
  fetchImpl,
  apiBase = "https://api.github.com",
  owner,
  repo,
  workflow,
  jobName,
  stepName,
  sampleSize,
  excludeRunId,
  token,
}) {
  let runs;
  try {
    runs = await apiGet({
      fetchImpl,
      token,
      url:
        `${apiBase}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs` +
        `?status=success&per_page=${sampleSize}`,
    });
  } catch (error) {
    // A 404 here is not a transient failure: the API resolves a workflow by
    // file name only when that file exists on the *default* branch, and a
    // scheduled workflow never fires unless it does. Say that outright — the
    // generic message sends people looking for the wrong problem.
    if (/HTTP 404/.test(error.message)) {
      throw new Error(
        `${workflow} is not resolvable — the file must exist on the default ` +
          `branch for its schedule to fire at all`
      );
    }
    throw error;
  }

  const samples = [];
  for (const run of runs.workflow_runs.slice(0, sampleSize)) {
    if (String(run.id) === String(excludeRunId)) continue;

    const jobs = await apiGet({
      fetchImpl,
      token,
      url: `${apiBase}/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    });
    const job = jobs.jobs.find((candidate) => candidate.name === jobName);
    const step = job?.steps?.find((candidate) => candidate.name === stepName);
    if (!step?.started_at || !step?.completed_at) continue;
    if (step.conclusion !== "success") continue;

    samples.push({
      runId: run.id,
      date: run.run_started_at ?? run.created_at,
      seconds: Math.round(
        (new Date(step.completed_at) - new Date(step.started_at)) / 1000
      ),
    });
  }

  return samples;
}

/** Read and validate the CLI configuration from the environment. */
export function parseConfig(env) {
  const required = [
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "TREND_JOB",
    "TREND_STEP",
    "CURRENT_SECONDS",
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`missing required env: ${missing.join(", ")}`);
  }

  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY is not owner/repo: ${env.GITHUB_REPOSITORY}`
    );
  }

  const num = (value, fallback) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    token: env.GITHUB_TOKEN,
    owner,
    repo,
    workflow: env.TREND_WORKFLOW || "test-canary.yml",
    jobName: env.TREND_JOB,
    stepName: env.TREND_STEP,
    current: num(env.CURRENT_SECONDS, NaN),
    sampleSize: num(env.TREND_SAMPLE_SIZE, 20),
    ratio: Number.parseFloat(env.TREND_RATIO ?? "") || 1.5,
    minDelta: num(env.TREND_MIN_DELTA_SECONDS, 30),
    minSamples: num(env.TREND_MIN_SAMPLES, 3),
    runId: env.GITHUB_RUN_ID,
    serverUrl: env.GITHUB_SERVER_URL || "https://github.com",
    summaryPath: env.GITHUB_STEP_SUMMARY,
    decisionPath:
      env.TREND_DECISION_PATH ||
      `${env.RUNNER_TEMP || "/tmp"}/ci-build-trend.json`,
    fetchImpl: env.TREND_FETCH_IMPL || fetch,
  };
}

async function main() {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    console.error(`❌ build trend: ${error.message}`);
    return;
  }

  if (!Number.isFinite(config.current)) {
    console.error("❌ build trend: CURRENT_SECONDS is not a number");
    return;
  }

  let samples;
  try {
    samples = await collectSamples({ ...config, excludeRunId: config.runId });
  } catch (error) {
    // A rate limit or a permissions gap must not poison the canary result.
    console.error(`⚠️  build trend: could not read history — ${error.message}`);
    return;
  }

  const baseline = median(samples.map((sample) => sample.seconds));
  const decision = decideRegression({
    current: config.current,
    baseline,
    sampleCount: samples.length,
    ratio: config.ratio,
    minDelta: config.minDelta,
    minSamples: config.minSamples,
  });

  const markdown = renderTrendMarkdown({
    current: config.current,
    baseline,
    samples,
    serverUrl: config.serverUrl,
    owner: config.owner,
    repo: config.repo,
  });
  if (config.summaryPath) appendFileSync(config.summaryPath, markdown);

  writeFileSync(
    config.decisionPath,
    JSON.stringify(
      {
        current: config.current,
        baseline,
        sampleCount: samples.length,
        regressed: decision.regressed,
        reason: decision.reason,
        markdown,
      },
      null,
      2
    )
  );

  console.log(
    `✓ build trend — current ${config.current}s, baseline ${baseline}s, ` +
      `${samples.length} sample(s), regressed: ${decision.regressed} (${decision.reason})`
  );
}

// Only run when invoked as a CLI; importing this module for tests must be inert.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
