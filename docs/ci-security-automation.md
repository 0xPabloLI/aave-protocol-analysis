# CI + Security Automation Flow

## Local Hooks

This repo uses `pre-commit` and `pre-push` hooks that run `npm run ci:remote`. On failure, hooks attempt `npm run ci:auto-fix` then re-run `ci:remote`. See [AGENTS.md](../AGENTS.md#local-git-hook-policy-mandatory).

### Lock File Drift Prevention

**Problem**: Local hooks run against working directory files, but CI runs against committed files. If `package-lock.json` is updated locally (via `npm install` or `npm audit fix`) but not committed, local checks pass while CI fails.

**Solution**: Hooks now include lock file drift detection:

| Hook         | Behavior                                           |
| ------------ | -------------------------------------------------- |
| `pre-commit` | Auto-stages uncommitted `package-lock.json`        |
| `pre-push`   | Blocks push if lock files have uncommitted changes |

This ensures lock file changes are always included in commits, preventing local/CI audit result drift.

### Security Scanner Gates (pre-push only)

`.husky/pre-push` runs two blocking scanners that have **no CI counterpart** — they gate the local push, not the merge:

| Gate          | Command                                          | Blocks on                           |
| ------------- | ------------------------------------------------ | ----------------------------------- |
| `osv-scanner` | `osv-scanner --lockfile package-lock.json`       | Any advisory not in `OSV_ALLOWLIST` |
| `semgrep`     | `semgrep scan --config p/default src/ packages/` | Any finding                         |

Because the osv-scanner gate has no CI counterpart, an advisory it cannot resolve would block every push indefinitely. `OSV_ALLOWLIST` in `.husky/pre-push` exists for that case; each entry carries its justification inline. Current entries:

| GHSA                  | Package     | Why allowlisted                                                   |
| --------------------- | ----------- | ----------------------------------------------------------------- |
| `GHSA-848j-6mx2-7j84` | `elliptic`  | No upstream fix; reaches us via `ethers@5`.                       |
| `GHSA-3g3m-2fjr-6pw4` | `glob`      | dev-only; latest parents still pin `^13.0.6`, the fix is a major. |
| `GHSA-g3hv-75wg-m249` | `minimatch` | dev-only; latest parents still pin `^10.2.2`, the fix is a major. |

Re-check the two dev-only entries whenever `test-exclude`, `ts-json-schema-generator` or `@typescript-eslint/typescript-estree` widen their ranges.

The `npm audit` allowlist is a separate list, kept in the `"audit"` script in `package.json` (see [Security Audit Layered Architecture](#security-audit-layered-architecture)).

## GitHub Actions

This repository has five related workflows:

1. `CI` (`.github/workflows/ci.yml`)
   - Triggered by `push` and `pull_request`
   - Runs build + prune checks
   - Audit: `npm run audit` (shared script with GHSA allowlist, see `package.json`)
   - `security-audit` job uses `continue-on-error: true` — audit failures do not block PRs or trigger auto-revert (see ADR-0037)
   - Result: build failures block merge; audit failures are non-blocking (tracked by Proactive Audit Fix + Security Moderate Report)

2. `Security Moderate Report` (`.github/workflows/security-moderate-report.yml`)
   - Triggered every Monday at 04:00 UTC and by manual run
   - Runs runtime `npm audit` in JSON mode
   - Creates/updates one tracking issue titled:
     - `Security audit: moderate vulnerabilities (tracking)`
   - Result: Moderate vulnerabilities are tracked without blocking normal delivery

3. `CI Auto Remediation` (`.github/workflows/ci-auto-remediation.yml`)
   - Triggered when `CI` fails on `push` (or manually)

- Attempts automatic dependency remediation:
  - `npm audit fix --omit=dev`
- Validates by running:
  - `npm run build`
  - `npm run build -w aave-dashboard-backend`
  - `npm run audit`
- If changes exist and validation passes, opens a bot PR to the same branch
- If remediation fails, creates an escalation issue with `ci-auto-remediation` label

4. `Auto Approve Remediation PR` (`.github/workflows/auto-approve-remediation-pr.yml`)
   - Triggered on bot PR updates (`pull_request_target`)
   - Applies policy checks per branch pattern:
     - `bot/ci-auto-remediation-*`: only `package.json`, `package-lock.json`, `backend/package.json`
     - `bot/subgraph-sync-*`: only `docs/api/aave-subgraph-deployments.snapshot.json`
     - `bot/sync-coingecko-platform-map-*`: only `packages/aave-fetcher/src/generated/coingecko-platform-by-chain-id.ts`
   - If policy passes:
     - bot submits an approval review
     - auto-merge is enabled (squash)
   - Result: bot PRs merge automatically after required CI checks pass

5. `Deployment Smoke Test` (`.github/workflows/deployment-smoke-test.yml`)
   - Triggered via `deployment_status` when Railway reports a successful deployment on `main` / `railway`
   - **Not** triggered by `push` — avoids deadlock with Railway's "Wait for CI" (see below)
   - Runs right after Railway reports deploy success: resolve target from `deployment.ref` with fallback to deployment environment, then health check, `/api/markets` (≥50 reserves + snapshot), `/api/meta/side-data`, frontend accessibility (curl retries only; no long poll for `commitSha`)
   - On failure: auto-rollback via Railway GraphQL `deploymentRollback` mutation, then creates a GitHub issue with `smoke-test-failure` label
   - Rollback target: newest `canRollback == true` deployment that is not the current broken head
   - Rollback secret selection is branch-specific with no production→staging fallback when the chosen environment secret is empty; notification issue titles also reflect rollback succeeded/skipped/failed state
   - Branch → environment mapping: `main` → production (`api.aaveapy.com`), `railway` → staging (`staging-api.aaveapy.com`)

### Third-party actions: SHA pinning

Workflows pin third-party actions with a **full 40-character commit SHA** in `uses:` (not a floating tag like `@v6`). Each line includes a trailing comment with the human-readable release, for example:

```yaml
uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6
```

**Why**: a tag can be moved to a different commit; a SHA selects one immutable snapshot of the action’s code.

**Triggers and behavior**: pinning does **not** change `on:` (push, PR, schedule, `workflow_run`). CI still runs the same way; only the resolved action bundle is fixed until you edit the workflow.

### How to upgrade a pinned action

The **goal** is the same as with tags—run a newer release—but you edit the **SHA** (and the `# …` comment), not only `@v5` → `@v6`.

1. Open the action’s GitHub repo → **Releases** (or **Tags**) and pick the version you want.
2. Resolve that tag to a commit SHA:
   - In the UI: open the tag → note the commit hash, or
   - API: `GET https://api.github.com/repos/<owner>/<repo>/commits/<tag>` and use the `sha` field (full 40 characters).
3. Update every `uses: <owner>/<repo>@<old-sha> # …` in `.github/workflows/*.yml` to the new SHA and update the comment (e.g. `# v6` → `# v7`).

**Renovate**: `renovate.json` covers the `github-actions` manager (autodiscovered), so action-update PRs arrive via Renovate and are auto-merged when non-major (CI-green). Do not rely only on Renovate for feature upgrades of pinned actions—use the steps above when you intentionally bump versions.

### SHA pins vs tags only

|                                   | Tags only (`@v6`)                                     | SHA + comment                                          |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| **What changes when you upgrade** | Bump the tag in `uses:`                               | Replace the 40-char SHA and refresh the `# vN` comment |
| **Immutability**                  | Same tag name might point to a different commit later | Same SHA always means the same action code             |
| **CI still automatic?**           | Yes                                                   | Yes                                                    |

## How to use

- Normal daily flow:
  - Push code -> `CI` runs automatically
  - Build failures block merge; audit failures are non-blocking (`continue-on-error`)
- Dependency update flow:
  - Renovate opens update PRs against `railway` — vulnerability-alert fixes immediately, routine updates after the 7-day release age, weekly lockfile maintenance
  - `Auto-merge Bot PRs` auto-approves non-major Renovate PRs and enables auto-merge; majors get a comment only
- Reactive auto-fix flow (on CI build failure):
  - Failed `CI` on push -> `CI Auto Remediation` tries to fix -> opens PR if safe
  - `Auto Approve Remediation PR` auto-approves that PR and enables auto-merge
  - If remediation fails -> escalation issue created
- CoinGecko sync flow (weekly):
  - `CoinGecko platform map sync` creates PR -> `CI` runs -> `Auto Approve Remediation PR` auto-approves + auto-merge
- Moderate tracking flow:
  - Weekly scheduled run updates the single tracking issue

## Manual trigger

In GitHub UI:

- Open `Actions`
- Select a workflow (`Security Moderate Report` or `CI Auto Remediation`)
- Click `Run workflow`

## Architecture Notes

### Single Remediation Source (Avoid Duplicate PRs)

**Anti-pattern**: Having both an inline remediation job in `ci.yml` AND a separate `ci-auto-remediation.yml` workflow. Both trigger on CI failure and create duplicate PRs.

**Correct pattern**: Keep remediation logic in ONE place only:

- `ci.yml`: Only build/test/audit checks, read-only permissions
- `ci-auto-remediation.yml`: Triggered via `workflow_run` event when CI fails, has write permissions

```
CI fails (ci.yml, read-only)
      ↓
workflow_run event
      ↓
ci-auto-remediation.yml (write permissions)
      ↓
Single remediation PR
```

### Railway "Wait for CI" and Smoke Test Trigger Design

Railway's "Wait for CI" blocks deployment until **all** push-triggered GitHub check suites pass. If the smoke test were triggered by `push`, it would create a deadlock:

```
push → smoke test polls /health for new SHA → Railway waits for smoke test to pass → never deploys → deadlock
```

**Solution**: The smoke test uses `deployment_status` (sent by Railway after deploying), not `push`. This removes it from Railway's check suite scope:

```
push → CI (push-triggered, Railway waits for this)
         ↓ CI passes
         Railway deploys new commit
         ↓ Railway sends deployment_status: success
         Smoke test triggers (deployment_status event)
              ↓ health + API checks on live backend
              ├→ all checks pass → done
              └→ any check fails → auto-rollback + GitHub issue
```

Context fields come from `github.event.deployment.*` (not `github.sha` / `github.ref_name`). The workflow gates on `deployment_status.state == 'success'`, then resolves target branch/environment from `deployment.ref` with fallback to `deployment.environment` so commit-SHA deployments do not skip smoke tests when `ref` is empty.

⚠️ **A failed check suite does not hold the deploy — it cancels it.** Railway reads each workflow run's conclusion, and a single `failure` on the commit moves the deployment straight to `SKIPPED` (`reason=deploy`), leaving the previous commit serving traffic. This is silent: `/health` still returns `status: ok`, just with the old `commitSha`. Observed 2026-11-09, when Dependabot's `elliptic`/`minimatch` security-update run failed on the `railway` → `main` merge `5e6b87b`. Recovery and diagnosis steps: `docs/operations/railway-environment-config.md` §4.

### Workflow Run Trigger Conditions

`ci-auto-remediation.yml` only triggers when:

1. `CI` workflow completes with `conclusion == 'failure'`
2. The triggering event was `push` (not PR)
3. Branch matches configured list (main, railway, renovate/\*\*)

This prevents:

- Duplicate runs on PR events (PRs don't need auto-remediation PRs)
- Runs on successful CI (no remediation needed)
- Infinite loops (remediation branches start with `bot/ci-auto-remediation-`)

**This workflow must never conclude in `failure`.** A `workflow_run` run is attributed to the _default branch's_ HEAD regardless of which branch triggered it, so a hard failure while remediating a `renovate/**` branch is indistinguishable from a failure on `main` — and Railway skips the next production deploy (see "A failed check suite does not hold the deploy" above). Two things keep it safe:

- `jobs.remediate.continue-on-error: true`, so the run passes even when the job fails.
- The steps that can fail on their own (`npm ci`, `npm audit fix`) carry step-level `continue-on-error`, so the job still reaches the escalation step instead of aborting. Downstream steps gate on `steps.install.outcome`/`steps.reinstall.outcome`.

Its npm is pinned to the same version as `ci.yml` (`npm install -g npm@11.6.2`). The lockfile is only valid for the npm version that generated it: an unpinned npm rejects the `@emnapi/*` entries with `EUSAGE`, which is what failed this job on 2026-11-09 and skipped the production deploy for `0a8e8c7`.

The workflow also declares `issues: write`. Because it sets `permissions:`, every unlisted scope is `none`, and without that scope the escalation call returns 403 — silently, since the escalation step tolerates failure. Verified 2026-11-09: escalation had never once succeeded.

`backend/tests/ciAutoRemediationWorkflow.test.ts` guards all three invariants (npm pin parity, never-fail, issue scope).

### Security Audit Layered Architecture

The `continue-on-error: true` on `security-audit` in `ci.yml` is a **hard constraint** — see ADR-0037. Removing it reintroduces the auto-revert loop. Audit remediation is handled by a layered system:

| Layer | Mechanism                               | Trigger                | Coverage                                                    |
| ----- | --------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| 1     | `continue-on-error` on `security-audit` | Every CI run           | Prevents audit from blocking PRs + auto-revert loop         |
| 2     | Renovate (`renovate.json`)              | OSV alerts + weekly    | Dependency security + routine updates, lockfile maintenance |
| 3     | CI Auto Remediation                     | CI build failure       | Other CI failures (build break, etc.)                       |
| 4     | Security Moderate Report                | Weekly (Mon 04:00 UTC) | Unfixable vulnerability tracking                            |

**Dependabot security updates are disabled** (repo setting, 2026-11-09). The toggle outlived the Renovate migration but had nothing left to do: both remaining alerts (`elliptic`, `minimatch`) have no fix path, so Dependabot could not open a PR — it could only fail a workflow run on every push to `main`, which made Railway skip the production deploy (see "A failed check suite does not hold the deploy" above). Dependabot **alerts** remain enabled for visibility; Renovate is the update path. Unfixable advisories are tracked by layer 4, which reads `npm audit`, not the Dependabot API.
