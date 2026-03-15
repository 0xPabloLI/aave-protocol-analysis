# CI + Security Automation Flow

## Local Hooks

This repo uses `pre-commit` and `pre-push` hooks that run `npm run ci:remote`. On failure, hooks attempt `npm run ci:auto-fix` then re-run `ci:remote`. See [AGENTS.md](../AGENTS.md#local-git-hook-policy-mandatory).

### Lock File Drift Prevention

**Problem**: Local hooks run against working directory files, but CI runs against committed files. If `package-lock.json` is updated locally (via `npm install` or `npm audit fix`) but not committed, local checks pass while CI fails.

**Solution**: Hooks now include lock file drift detection:

| Hook | Behavior |
|------|----------|
| `pre-commit` | Auto-stages uncommitted `package-lock.json` / `backend/package-lock.json` |
| `pre-push` | Blocks push if lock files have uncommitted changes |

This ensures lock file changes are always included in commits, preventing local/CI audit result drift.

## GitHub Actions

This repository has four related workflows:

1. `CI` (`.github/workflows/ci.yml`)
   - Triggered by `push` and `pull_request`
   - Runs build + prune checks
   - Audit: root `npm audit --omit=dev --audit-level=high`; backend `npm --prefix backend audit --omit=dev --audit-level=moderate` (see `ci:remote` in root `package.json`)
   - Result: root blocks on High/Critical; backend blocks on Moderate and above (low-only vulns allowed for transitive deps with no fix, e.g. elliptic)

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
    - `npm --prefix backend audit fix --omit=dev`
  - Validates by running:
    - `npm run build`
    - `npm --prefix backend run build`
  - If changes exist and validation passes, opens a bot PR to the same branch

4. `Auto Approve Remediation PR` (`.github/workflows/auto-approve-remediation-pr.yml`)
   - Triggered on remediation PR updates (`pull_request_target`)
   - Applies policy checks:
     - only dependency manifest/lock files may change
   - If policy passes:
     - bot submits an approval review
     - auto-merge is enabled (squash)
   - Result: remediation PR can merge automatically after required checks pass

## How to use

- Normal daily flow:
  - Push code -> `CI` runs automatically
  - If High/Critical vulnerabilities appear, `CI` fails and blocks merge
- Auto-fix flow:
  - Failed `CI` on push -> `CI Auto Remediation` tries to fix -> opens PR if safe
  - `Auto Approve Remediation PR` auto-approves that PR and enables auto-merge
- Moderate tracking flow:
  - Weekly scheduled run updates the single tracking issue

## Manual trigger

In GitHub UI:
- Open `Actions`
- Select a workflow (`Security Moderate Report` or `CI Auto Remediation`)
- Click `Run workflow`
- For `CI Auto Remediation`, optional `branch` can be specified

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

### Workflow Run Trigger Conditions

`ci-auto-remediation.yml` only triggers when:
1. `CI` workflow completes with `conclusion == 'failure'`
2. The triggering event was `push` (not PR)
3. Branch matches configured list (main, railway, feature/**)

This prevents:
- Duplicate runs on PR events (PRs don't need auto-remediation PRs)
- Runs on successful CI (no remediation needed)
- Infinite loops (remediation branches start with `bot/ci-auto-remediation-`)
