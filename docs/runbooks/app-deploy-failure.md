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
5. **Escalate** — rolling back means pushing a revert commit; the normal chain then
   deploys it. `railway redeploy --service aave-protocol-analysis --from-source -y`
   is **not** a rollback: `--from-source` deploys the newest commit of the
   configured source ("latest commit or image from the configured source", per
   `railway redeploy --help`), not the last commit that passed CI. Use it only
   after triaging the failing CI run as infrastructure noise (runner/registry
   flake, upstream 5xx); a real regression must be fixed, not deployed around.
   Confirm the linked service with `railway status` first, and verify
   `curl https://staging-api.aaveapy.com/health` after ~3 min warm-up.
