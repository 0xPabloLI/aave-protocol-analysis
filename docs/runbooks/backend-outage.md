# Runbook: Backend API outage (aave-dashboard-backend)

Symptom: `/health` non-200, 5xx spikes, or no snapshot updates.

1. **Check service state** — `railway status` (app must be `● Online`).
2. **Check the API** — `curl https://staging-api.aaveapy.com/health` and
   `curl https://staging-api.aaveapy.com/metrics` (Prometheus format;
   `aave_backend_` prefix — look at event loop lag / GC metrics).
3. **Read logs** — Railway logs, or locally `backend/logs/error.log`
   (rotated: `error1.log`…). Structured, scrubbed of credentials.
4. **Common failure modes**
   - **OOM / RSS spike** — one-shot large allocations (see AGENTS.md memory
     lessons: heap snapshots, connection pools). Check
     `aave_backend_process_resident_memory_bytes` on /metrics.
   - **DB unreachable** — pool backoff (60s) engages automatically;
     `aave_backend_db_query_duration_seconds` shows timing, warn logs show
     slow queries (`DB_SLOW_QUERY_MS`). Persistence is opt-in: API runs
     memory-only without DATABASE_URL.
   - **Stale data, no errors** — check marketsService staleness + cache TTLs;
     `/api/markets` returns documented 503 while warming.
5. **Recovery** — `railway up` a fix or `railway redeploy --service aave-protocol-analysis --from-source -y`. Verify /health after ~3 min warm-up.
6. **Post-incident** — file the follow-up issue with the `ci-failure` /
   incident labels; update this runbook if the diagnosis was non-obvious.
