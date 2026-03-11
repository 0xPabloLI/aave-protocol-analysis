# CI + Security Automation Flow

**Local hooks**: This repo uses `pre-commit` and `pre-push` hooks that run `npm run ci:remote`. On failure, hooks attempt `npm run ci:auto-fix` then re-run `ci:remote`. See [AGENTS.md](../AGENTS.md#local-git-hook-policy-mandatory).

**GitHub Actions** — this repository has four related workflows:

1. `CI` (`.github/workflows/ci.yml`)
   - Triggered by `push` and `pull_request`
   - Runs build + prune checks
   - Runs `npm audit --omit=dev --audit-level=high`
   - Result: blocks merge when High/Critical runtime vulnerabilities exist

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
