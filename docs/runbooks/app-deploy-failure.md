# Runbook: App deploy failure (Railway)

Symptom: `railway up` fails, healthcheck stays unhealthy, or CI auto-reverted a push.

1. **Identify the failing service** — `railway status`. The app is
   `aave-protocol-analysis`; NEVER deploy to `Postgres-mDWG` (see AGENTS.md
   hard safety gate).
2. **Read the error** — `railway logs --service aave-protocol-analysis` or the
   GitHub issue opened by `auto-revert-on-failure` (labels `ci-failure`,
   `auto-reverted`).
3. **Common causes**
   - Build failure: run `npm run build` locally; check `buildScriptWriteSafety`
     rule (write targets must mkdirSync first — see AGENTS.md lessons).
   - Test failure: run `npm run ci` locally; root and fetcher suites now run in CI.
   - Coverage threshold regression: `npm run test:coverage -w aave-dashboard-backend`;
     thresholds are a ratchet (raise, never lower — AGENTS.md).
4. **Recover**
   - CI auto-reverted already? Fix forward; do not `git push --no-verify`.
   - App deployed but unhealthy: Railway restarts it; healthcheck needs ~3 min
     warm-up (oracle prices + market data fetch). Verify with
     `curl https://staging-api.aaveapy.com/health` → `{"status":"ok"}`.
   - Still failing after fix: `railway up --detach --service aave-protocol-analysis -m "..."`.
5. **Smoke-test failure and auto-rollback**
   - `deployment-smoke-test.yml` runs after Railway reports a successful deploy.
     On a failed check the `rollback` job selects the newest **release**
     deployment (`meta.reason: "deploy"`) whose commit is **not** the current
     head, calls Railway's `deploymentRedeploy(targetId)` mutation, and opens a
     `smoke-test-failure` issue. `redeploy`/`rollback` deployments are recovery
     copies and are never targets: recovering to one is redundant and can point
     at the head's own commit.
   - **Production is gated.** The mutation runs only when the repository
     variable `RAILWAY_PRODUCTION_ROLLBACK_ENABLED` is exactly `true`
     (case-sensitive; padded values stay gated); staging is never gated. If the
     issue title says `auto-rollback GATED (manual action required)`, nothing
     was rolled back. Triage the failing commit and either revert-and-push or
     run the manual `deploymentRedeploy` below. Do not flip the variable just to
     clear an incident — it exists to make the first production rollback
     deliberate.
   - If the issue says the rollback was accepted, confirm the live commit after
     the ~3 min warm-up:
     `curl -s https://api.aaveapy.com/health | jq -r .commitSha` (or
     `https://staging-api.aaveapy.com/health`).
   - If the recovery itself failed, the run log contains the Railway response.
     Retry the same mutation manually (take the deployment ID from the run's
     "Rollback plan" line):
     ```bash
     curl -sS https://backboard.railway.com/graphql/v2 \
       -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"query":"mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }","variables":{"id":"<deployment-id>"}}'
     ```
     `deploymentRedeploy` returns the new deployment object; poll `/health` until
     `commitSha` matches the target commit (40–92 seconds on 2026-11-16).
   - **Manual `deploymentRollback` experiment (not the auto path).** It returns
     `true`, but on 2026-11-16 four real runs served in 10m43s at best, took
     21m17s in the second, and did not serve within 30 minutes in the last two;
     `/health` was empty throughout. Only run it when you can accept an outage
     of that length and have the current head ID ready for the recovery:
     ```bash
     # 1) roll back to a target deployment (removes the serving deployment)
     curl -sS https://backboard.railway.com/graphql/v2 \
       -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"query":"mutation($id: String!) { deploymentRollback(id: $id) }","variables":{"id":"<target-id>"}}'
     # 2) if /health does not reach the target commit, restore the head
     curl -sS https://backboard.railway.com/graphql/v2 \
       -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"query":"mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }","variables":{"id":"<head-id>"}}'
     ```
     Do not use it for production recovery unless the platform rollout has been
     re-tested. The workflow deliberately does not call it (a static test
     enforces that).
   - If the head is itself a rollback deployment (`meta.reason: "rollback"`),
     the target selector fails closed with `head-is-rollback`; it also fails
     closed with `no-release-deployment` when only recovery copies remain, and
     with `same-commit-as-head` when the only release is the head's commit.
     Do not bypass these guards. Treat a second failure as a manual incident
     and do not re-run the rollback.
6. **Drill the rollback path (staging only)**
   - Read-only plan for either environment:
     `gh workflow run deployment-smoke-test.yml --ref railway -f environment=staging -f mode=plan`
   - Real staging rollback + automatic restore:
     `gh workflow run deployment-smoke-test.yml --ref railway -f environment=staging -f mode=execute -f confirm=rollback-staging`
   - Negative control: the same command with `-f confirm=wrong` must fail in
     "Validate drill request" before any mutation.
   - The run summary records head/target deployment IDs and commits, the
     selection reason, the gate state, and every step outcome. Keep the run URL
     and the `deploymentRedeploy` response with the delivery evidence. The
     health waits allow 5 minutes; the final staging drill `43835257174`
     passed (target 92s, restore 71s).
7. **Escalate** — pushing a revert commit is still the normal recovery when the
   auto-rollback is gated or unavailable. `railway redeploy --service aave-protocol-analysis --from-source -y`
   is **not** a rollback: `--from-source` deploys the newest commit of the
   configured source ("latest commit or image from the configured source", per
   `railway redeploy --help`), not the last commit that passed CI. Use it only
   after triaging the failing CI run as infrastructure noise (runner/registry
   flake, upstream 5xx); a real regression must be fixed, not deployed around.
   Confirm the linked service with `railway status` first, and verify
   `curl https://staging-api.aaveapy.com/health` after ~3 min warm-up.
