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
  - Renovate merges non-major updates itself once CI is green; majors get a comment and wait for a human — see "Renovate automerge" below
  - `Auto-merge Bot PRs` still auto-approves non-major Renovate PRs as a record of the automated review. It deliberately does **not** arm GitHub's native auto-merge — see "Renovate automerge" below for why that is unsafe on this branch.
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

**This workflow must never conclude in `failure`.** A `workflow_run` run is attributed to the _default branch's_ HEAD regardless of which branch triggered it, so a hard failure while remediating a `renovate/**` branch is indistinguishable from a failure on `main` — and Railway skips the next production deploy (see "A failed check suite does not hold the deploy" above). Three things keep it safe:

- `jobs.remediate.continue-on-error: true`, so the run passes even when the job fails.
- Every step whose command can fail on its own (`npm install -g npm@11.6.2`, `npm ci`, `npm audit fix`) carries step-level `continue-on-error`, so the job still reaches the escalation step instead of aborting. Downstream steps gate on `steps.npm-pin.outcome` / `steps.install.outcome` / `steps.reinstall.outcome`.
- The escalation steps (classify → read audit output → open issue) each gate on `!cancelled()` rather than a bare condition. GitHub implicitly ANDs a bare `if` with `success()`, so a failure in any earlier step would skip the entire path — while the job-level `continue-on-error` still reports the run as successful, making the lost escalation invisible. `!cancelled()` keeps the escalation reachable no matter which step broke.

⚠️ **A `workflow_run` workflow always runs the file from the default branch.** Editing this workflow on `railway` changes nothing until the change reaches `main` — verified 2026-11-09, when a fix already on `railway` was ignored and the old `main` version failed anyway. Plan a `workflow_run` fix as: land it on `main`, then re-check the next trigger.

Its npm is pinned to the same version as `ci.yml` (`npm install -g npm@11.6.2`). The lockfile is only valid for the npm version that generated it: an unpinned npm rejects the `@emnapi/*` entries with `EUSAGE`, which is what failed this job on 2026-11-09 and skipped the production deploy for `0a8e8c7`. That pin step is itself a network call, so it carries `continue-on-error` too — a registry outage there must not abort the job before the escalation runs. The classifier names that case separately from a lockfile mismatch, so the reader is not sent to regenerate a lockfile that was never at fault.

The workflow also declares `issues: write`. Because it sets `permissions:`, every unlisted scope is `none`, and without that scope the escalation call returns 403 — silently, since the escalation step tolerates failure. Verified 2026-11-09: escalation had never once succeeded.

`backend/tests/ciAutoRemediationWorkflow.test.ts` guards the npm pin parity, the never-fail job setting, the issue scope, step-level tolerance for every npm command, escalation reachability under `!cancelled()`, and the classifier's branch coverage.

### Security Audit Layered Architecture

The `continue-on-error: true` on `security-audit` in `ci.yml` is a **hard constraint** — see ADR-0037. Removing it reintroduces the auto-revert loop. Audit remediation is handled by a layered system:

| Layer | Mechanism                               | Trigger                | Coverage                                                             |
| ----- | --------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| 1     | `continue-on-error` on `security-audit` | Every CI run           | Prevents audit from blocking PRs + auto-revert loop                  |
| 2     | Renovate (`renovate.json`)              | OSV alerts + weekly    | Dependency security + routine updates, lockfile maintenance          |
| 3     | CI Auto Remediation                     | CI build failure       | Other CI failures (build break, etc.)                                |
| 4     | Security Moderate Report                | Weekly (Mon 04:00 UTC) | **Runtime** dependencies at `moderate` severity, minus the allowlist |

**Dependabot security updates are disabled** (repo setting, 2026-11-09). The toggle outlived the Renovate migration but had nothing left to do: both remaining alerts (`elliptic`, `minimatch`) have no fix path, so Dependabot could not open a PR — it could only fail a workflow run on every push to `main`, which made Railway skip the production deploy (see "A failed check suite does not hold the deploy" above). Dependabot **alerts** remain enabled for visibility; Renovate is the update path.

⚠️ **Layer 4 does not track either of those two advisories.** It reads `npm audit`, not the Dependabot API, and it narrows the result twice: it reports only `moderate` severity, and it runs `npm audit --omit=dev`. So:

- `minimatch` (`GHSA-g3hv-75wg-m249`, moderate) is a dev-only dependency — every lockfile entry is `dev: true` — and `--omit=dev` never sees it.
- `elliptic` (`GHSA-848j-6mx2-7j84`) is `low`, not moderate, **and** its advisory is the first entry in the audit allowlist in `package.json`, so layer 4 would filter it out anyway.

Both are therefore **known and accepted with no layer tracking them** — visible only in the Dependabot alerts list. Closing that gap means either dropping an allowlist entry (which fails the `npm run audit` gate, since neither advisory has a fix path) or adding a dev-dependency audit path. The layer-4 table row above is scoped to what it actually reports.

### Renovate automerge

**Renovate merges its own non-major PRs** (`automerge: true` in `renovate.json`). It does not delegate to GitHub's native auto-merge.

Before 2026-11-09 nothing merged at all. `auto-merge-bot-prs.yml` approved every non-major Renovate PR and then tried `enablePullRequestAutoMerge`, but that workflow only runs on `opened`/`synchronize`/`reopened` — moments when CI is necessarily still running. GitHub rejects the mutation with `Pull request is in unstable status`, so in the original observation (PR #194, 09:33) all five 30-second retries failed, and because no further `synchronize` event ever arrived it was never retried again. The result was 10 approved PRs sitting with `autoMergeRequest: null`, each one "Automerge: Disabled by config" in its body. Renovate retries its own automerge on every subsequent run, so it does not have this race.

⚠️ **That retry loop was not merely ineffective — it was dangerous.** When Renovate rebased a branch, the fresh `synchronize` event re-ran it, and its retries eventually found a window GitHub would accept. Verified 2026-11-09 on the rebased PR #186: attempts 1-3 were rejected with `unstable status`, attempt 4 armed native auto-merge at 11:16:36 (SQUASH), and GitHub merged at 11:17:16 — with CI already failed at 11:15:11. At the time `railway` declared no required status checks, so GitHub's merge gate had nothing to wait for. The merged lockfile was one `npm ci` rejects (`Missing: @emnapi/wasi-threads@1.2.3 from lock file`), and the staging deploy for that commit was `SKIPPED` with `reason=deploy`.

So the Renovate job in `auto-merge-bot-prs.yml` now approves and stops; Renovate merges its own PRs after waiting for green checks itself.

### Required status checks on `main` and `railway` (added 2026-11-09)

The hazard above had a second half that the workflow change could not fix. `railway` declared `required_status_checks` with **empty** `contexts`, so GitHub's merge gate had nothing to wait for — arming native auto-merge was enough to merge a red PR, by any actor, not just the retry loop. That is a repo setting, not a file, so it is fixed by configuration:

```
required_status_checks.contexts = [
  build-and-prune, security-audit, socket-firewall, quality-gates
]
```

All four are jobs in `ci.yml` that run unconditionally on every PR to `railway` **or** `main` — confirmed on three historical `main`-targeted PRs (#201, #202, #204), not assumed from the `railway` result. `auto-revert-on-failure` is deliberately **not** in the list: it is gated on `if: failure() && github.event_name == 'push'`, so it reports `skipped` on PRs, and a required check that never reports blocks merges forever.

`security-audit` is worth including even though its audit step carries `continue-on-error: true` (ADR-0037): the job still fails if its `npm ci` fails, which is precisely the #186 failure mode (a lockfile `npm ci` rejects).

Verified the same day: PRs #190 and #195, whose `build-and-prune`/`quality-gates` had failed, went from mergeable-by-arming to `mergeable_state: blocked`. With `required_pull_request_reviews` unset, the required checks are the only possible blocker. PRs with green checks stayed `clean`.

**`main` was worse than `railway`:** its `required_status_checks` was entirely absent (`null`, not an empty list), so the protection had to be enabled through the top-level branch-protection `PUT`, with every existing field sent explicitly to avoid silently resetting `allow_force_pushes`/`allow_deletions`. The repository ruleset (`protection`, id 13445333 — `deletion` + `non_fast_forward` on `main` and `railway`) is a separate mechanism and was unaffected.

Why `main` needed it: `coingecko-platform-sync` checks out the default branch and calls `peter-evans/create-pull-request` without a `base`, so its PRs target **`main`** — #148 and #162 confirm it, and #162 merged. `approve-github-actions-pr` matches that branch prefix and arms native auto-merge, so before this change a `bot/sync-coingecko-platform-map-*` PR could reach production with failing CI, through exactly the #186 mechanism.

Two settings on `main` are deliberately **left off**:

- **`required_pull_request_reviews`** — the repository has one human collaborator, and GitHub does not let you approve your own PR. Enabling it would block production permanently. Every historical `railway` → `main` PR (#201, #202, #204) carries `COMMENTED` reviews only, never an `APPROVED`. So required checks here constrain **bots**, not the owner.
- **A "require a pull request before merging" rule** — `ci.yml`'s `auto-revert-on-failure` job reverts a failing direct push with `git push origin "${{ github.ref_name }}"`. Forbidding direct pushes would break that safety net. Required status checks do not block direct pushes (GitHub documents direct push as a valid path once checks pass), verified here: `b01e3c1` was pushed straight to `railway` after its checks were set.

⚠️ **This setting is load-bearing and lives outside the repository.** Clearing `required_status_checks.contexts` silently reopens the hole — `approve-github-actions-pr` in `auto-merge-bot-prs.yml` arms native auto-merge for `bot/ci-auto-remediation-*`, `bot/subgraph-sync-*` and `bot/sync-coingecko-platform-map-*` PRs, and that arming is only safe because GitHub now waits for these four checks. On `main` that path is production. No test can assert it (reading branch protection needs admin scope, which `GITHUB_TOKEN` cannot request), so it is documented here and in `AGENTS.md` instead.

Four config invariants hold this together:

| Setting                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automerge: true`                                  | Renovate merges once its own checks pass, and retries on later runs.                                                                                                                                                                                                                                                                                                                               |
| `platformAutomerge: false`                         | With `true`, Renovate arms GitHub's native auto-merge. That is no longer unsafe now that `railway` declares required checks, but it is the less reliable path: arming has to land as a one-shot mutation, whereas Renovate's own automerge simply re-checks on every run. Keep it `false` so there is one merge controller per PR.                                                                 |
| `matchUpdateTypes: ["major"]` → `automerge: false` | Breaking changes still need a human. Majors get a comment instead.                                                                                                                                                                                                                                                                                                                                 |
| `postUpdateOptions: ["npmInstallTwice"]`           | npm sometimes writes a lockfile its own `npm ci` rejects. Observed 2026-11-09: `renovate/pin-dependencies` omitted the hoisted `node_modules/@emnapi/wasi-threads` entry (3 `@emnapi/*` entries instead of `railway`'s 4) and `npm ci` failed with `Missing: @emnapi/wasi-threads@1.2.3 from lock file`. This is the fix Renovate's own npm docs recommend for "Invalid lock file (npm ci fails)". |

⚠️ **The npm cool-down needs its own rule.** `config:best-practices` pulls in `security:minimumReleaseAgeNpm`, which sets `minimumReleaseAge: '3 days'` for npm **inside a `packageRule`**. Renovate applies matching `packageRules` _after_ the top-level config and merges them in array order, so the repo's top-level `minimumReleaseAge: "7 days"` does not win — without the npm override below, the effective cool-down is 3 days, not the documented 7. The override must stay scoped to update types that carry a release timestamp (`major`, `minor`, `patch`, `digest`, `pinDigest`): the preset sets `minimumReleaseAge: null` for `lockFileMaintenance`, `pin`, `replacement`, `bump`, `lockfileUpdate` and `rollback` because those have no timestamp to check, and an unscoped rule would re-impose an age requirement they can never satisfy — lock file maintenance would silently stop being raised at all.

`backend/tests/renovate-config.test.ts` guards all four invariants, the cool-down scoping, and the rule that the Renovate job never arms native auto-merge.
