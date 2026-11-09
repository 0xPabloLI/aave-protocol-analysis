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
5. **Escalate** — if the release commit is bad, redeploy the previous tag:
   `railway redeploy --service aave-protocol-analysis --from-source -y` after
   confirming the linked service with `railway status`.
