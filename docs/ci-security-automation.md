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

## GitHub Actions

This repository has six related workflows:

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
     - `bot/ci-auto-remediation-*` / `bot/proactive-audit-fix-*`: only `package.json`, `package-lock.json`, `backend/package.json`
     - `bot/subgraph-sync-*`: only `docs/api/aave-subgraph-deployments.snapshot.json`
     - `bot/sync-coingecko-platform-map-*`: only `src/generated/coingecko-platform-by-chain-id.ts`
   - If policy passes:
     - bot submits an approval review
     - auto-merge is enabled (squash)
   - Result: bot PRs merge automatically after required CI checks pass

5. `Proactive Audit Fix` (`.github/workflows/proactive-audit-fix.yml`)
   - Triggered daily at 06:00 UTC (after Dependabot's 03:00 window) and manually
   - Matrix runs on `main` and `railway` independently
   - Attempts `npm audit fix --omit=dev`, then validates with full build + audit gate
   - If validation passes and lockfile changed → creates PR (`bot/proactive-audit-fix-{branch}`)
   - If validation fails → silent exit (unfixable vulns tracked by Security Moderate Report)
   - Fills the reactive gap left by `continue-on-error: true` on `security-audit` (see ADR-0037)

6. `Deployment Smoke Test` (`.github/workflows/deployment-smoke-test.yml`)
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

**Dependabot**: this repo includes `package-ecosystem: github-actions` in `.github/dependabot.yml`. With `open-pull-requests-limit: 0` (same idea as for npm), **routine** version-update PRs for actions are suppressed; **security-related** updates may still arrive via Dependabot depending on GitHub’s classification. Do not rely only on Dependabot for feature upgrades of pinned actions—use the steps above when you intentionally bump versions.

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
- Proactive audit fix flow (daily):
  - `Proactive Audit Fix` runs -> `npm audit fix` -> validates build + audit gate -> creates PR if safe
  - `Auto Approve Remediation PR` auto-approves and enables auto-merge
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
- Select a workflow (`Security Moderate Report`, `CI Auto Remediation`, or `Proactive Audit Fix`)
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

### Workflow Run Trigger Conditions

`ci-auto-remediation.yml` only triggers when:

1. `CI` workflow completes with `conclusion == 'failure'`
2. The triggering event was `push` (not PR)
3. Branch matches configured list (main, railway, dependabot/\*\*)

This prevents:

- Duplicate runs on PR events (PRs don't need auto-remediation PRs)
- Runs on successful CI (no remediation needed)
- Infinite loops (remediation branches start with `bot/ci-auto-remediation-`)

### Security Audit Layered Architecture

The `continue-on-error: true` on `security-audit` in `ci.yml` is a **hard constraint** — see ADR-0037. Removing it reintroduces the auto-revert loop. Audit remediation is handled by a layered system:

| Layer | Mechanism                               | Trigger                | Coverage                                            |
| ----- | --------------------------------------- | ---------------------- | --------------------------------------------------- |
| 1     | `continue-on-error` on `security-audit` | Every CI run           | Prevents audit from blocking PRs + auto-revert loop |
| 2     | Dependabot                              | Weekly (Mon 03:00 UTC) | Direct dependency security updates                  |
| 3     | Proactive Audit Fix                     | Daily (06:00 UTC)      | Transitive dependency security updates              |
| 4     | CI Auto Remediation                     | CI build failure       | Other CI failures (build break, etc.)               |
| 5     | Security Moderate Report                | Weekly (Mon 04:00 UTC) | Unfixable vulnerability tracking                    |
