/**
 * CI build-duration trend (scripts/ci-build-trend.mjs).
 *
 * The workflow that feeds this only runs weekly, so a wrong threshold would go
 * unnoticed for a long time — either missing a real slowdown or filing spurious
 * issues. The decision arithmetic is pinned here instead.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  collectSamples,
  decideRegression,
  median,
  parseConfig,
  renderTrendMarkdown,
} from "../scripts/ci-build-trend.mjs";

type Sample = { runId: number; date: string; seconds: number };

// ── median ───────────────────────────────────────────────────────────────────

test("median handles odd, even and empty samples", () => {
  assert.equal(median([]), null);
  assert.equal(median([42]), 42);
  assert.equal(median([100, 110, 105]), 105);
  // Even length rounds the mean of the two middle values.
  assert.equal(median([100, 110, 105, 95]), 103);
  // Unsorted input must not change the answer.
  assert.equal(median([120, 95, 105, 110, 100]), 105);
});

// ── decideRegression ─────────────────────────────────────────────────────────

const BASE = { ratio: 1.5, minDelta: 30, minSamples: 3 };

test("decideRegression: fires only when both bars are cleared", () => {
  const regressed = decideRegression({
    ...BASE,
    current: 400,
    baseline: 105,
    sampleCount: 5,
  });
  assert.equal(regressed.regressed, true);
});

test("decideRegression: a proportional jump alone is not enough on a tiny baseline", () => {
  // 2s → 6s is 3× the median but only +4s; a noisy runner would alert constantly.
  const verdict = decideRegression({
    ...BASE,
    current: 6,
    baseline: 2,
    sampleCount: 5,
  });
  assert.equal(verdict.regressed, false);
  assert.match(verdict.reason, /delta breached: false/);
});

test("decideRegression: an absolute jump alone is not enough", () => {
  // +40s clears minDelta but is nowhere near 1.5× a 500s baseline.
  const verdict = decideRegression({
    ...BASE,
    current: 540,
    baseline: 500,
    sampleCount: 5,
  });
  assert.equal(verdict.regressed, false);
  assert.match(verdict.reason, /ratio breached: false/);
});

test("decideRegression: too few samples never alerts", () => {
  const verdict = decideRegression({
    ...BASE,
    current: 400,
    baseline: 105,
    sampleCount: 2,
  });
  assert.equal(verdict.regressed, false);
  assert.match(verdict.reason, /need 3/);
});

test("decideRegression: an unusable baseline never alerts", () => {
  const verdict = decideRegression({
    ...BASE,
    current: 400,
    baseline: 0,
    sampleCount: 9,
  });
  assert.equal(verdict.regressed, false);
  assert.match(verdict.reason, /baseline is not usable/);
});

// ── collectSamples ───────────────────────────────────────────────────────────

function step(name: string, seconds: number, conclusion = "success") {
  const start = new Date("2026-09-01T06:00:00Z");
  return {
    name,
    started_at: start.toISOString(),
    completed_at: new Date(start.getTime() + seconds * 1000).toISOString(),
    conclusion,
  };
}

function makeFetch(runs: unknown[], jobsByRun: Record<string, unknown>) {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    const jobMatch = /\/runs\/(\d+)\/jobs/.exec(url);
    if (jobMatch) {
      return {
        ok: true,
        status: 200,
        json: async () => jobsByRun[jobMatch[1]],
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ workflow_runs: runs }),
    };
  };
  return { fetchImpl, urls };
}

const CFG = {
  owner: "o",
  repo: "r",
  workflow: "test-canary.yml",
  jobName: "canary",
  stepName: "Build (timed)",
  sampleSize: 20,
  token: "t",
};

test("collectSamples: reads per-step durations and skips unusable runs", async () => {
  const { fetchImpl } = makeFetch(
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    {
      "1": { jobs: [{ name: "canary", steps: [step("Build (timed)", 100)] }] },
      // Step never ran (skipped by an earlier failure).
      "2": { jobs: [{ name: "canary", steps: [] }] },
      // Reached the step but it failed: not a usable timing.
      "3": {
        jobs: [
          { name: "canary", steps: [step("Build (timed)", 90, "failure")] },
        ],
      },
      // A different job must not be sampled.
      "4": { jobs: [{ name: "other", steps: [step("Build (timed)", 10)] }] },
    }
  );

  const samples = (await collectSamples({
    ...CFG,
    fetchImpl,
  })) as Sample[];

  assert.equal(samples.length, 1);
  assert.equal(samples[0].seconds, 100);
  assert.equal(samples[0].runId, 1);
});

test("collectSamples: excludes the current run and asks only for successful runs", async () => {
  const { fetchImpl, urls } = makeFetch([{ id: 1 }, { id: 999 }], {
    "1": { jobs: [{ name: "canary", steps: [step("Build (timed)", 100)] }] },
    "999": { jobs: [{ name: "canary", steps: [step("Build (timed)", 5)] }] },
  });

  const samples = (await collectSamples({
    ...CFG,
    fetchImpl,
    excludeRunId: "999",
  })) as Sample[];

  assert.deepEqual(
    samples.map((s) => s.runId),
    [1]
  );
  assert.match(urls[0], /status=success/);
});

test("collectSamples: a non-OK response is surfaced, not swallowed", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  await assert.rejects(() => collectSamples({ ...CFG, fetchImpl }), /HTTP 403/);
});

test("collectSamples: a 404 names the default-branch constraint", async () => {
  // The Actions API resolves a workflow by file name only when the file exists
  // on the default branch — and a scheduled workflow never fires otherwise.
  const fetchImpl = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    () => collectSamples({ ...CFG, fetchImpl }),
    /must exist on the default\s+branch/
  );
});

// ── renderTrendMarkdown ──────────────────────────────────────────────────────

test("renderTrendMarkdown: reports the baseline and one row per sample", () => {
  const markdown = renderTrendMarkdown({
    current: 120,
    baseline: 105,
    samples: [
      { runId: 11, date: "2026-09-01T06:00:00Z", seconds: 100 },
      { runId: 12, date: "2026-09-08T06:00:00Z", seconds: 110 },
    ],
    serverUrl: "https://github.com",
    owner: "o",
    repo: "r",
  });

  assert.match(markdown, /Current run: \*\*120s\*\*/);
  assert.match(markdown, /median of last 2: \*\*105s\*\*/);
  assert.match(markdown, /actions\/runs\/11/);
  assert.match(markdown, /actions\/runs\/12/);
  assert.match(markdown, /\| -5s \|/);
  assert.match(markdown, /\| \+5s \|/);
});

test("renderTrendMarkdown: says so when there is no baseline yet", () => {
  const markdown = renderTrendMarkdown({
    current: 120,
    baseline: null,
    samples: [],
    serverUrl: "https://github.com",
    owner: "o",
    repo: "r",
  });
  assert.match(markdown, /no baseline yet/);
});

// ── parseConfig ──────────────────────────────────────────────────────────────

const VALID_ENV = {
  GITHUB_TOKEN: "t",
  GITHUB_REPOSITORY: "owner/repo",
  TREND_JOB: "canary",
  TREND_STEP: "Build (timed)",
  CURRENT_SECONDS: "123",
};

test("parseConfig: names every missing required variable", () => {
  assert.throws(
    () => parseConfig({}),
    /missing required env: GITHUB_TOKEN, GITHUB_REPOSITORY, TREND_JOB, TREND_STEP, CURRENT_SECONDS/
  );
});

test("parseConfig: splits the repository and applies threshold defaults", () => {
  const config = parseConfig(VALID_ENV) as Record<string, unknown>;
  assert.equal(config.owner, "owner");
  assert.equal(config.repo, "repo");
  assert.equal(config.current, 123);
  assert.equal(config.workflow, "test-canary.yml");
  assert.equal(config.sampleSize, 20);
  assert.equal(config.ratio, 1.5);
  assert.equal(config.minDelta, 30);
  assert.equal(config.minSamples, 3);
});

test("parseConfig: rejects a repository that is not owner/repo", () => {
  assert.throws(
    () => parseConfig({ ...VALID_ENV, GITHUB_REPOSITORY: "solo" }),
    /not owner\/repo/
  );
});
