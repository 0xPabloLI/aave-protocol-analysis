# Runbook: Worker outage (aave-browser-rendering)

Symptom: fetcher Merit dynamic-info fallback reports worker source failures;
Merit enrichment degrades to null (documented fallback chain: Render → Worker
→ Playwright → null, see AGENTS.md "High-Risk Areas").

1. **Check worker health** — `curl https://aave-browser-rendering.<your-subdomain>.workers.dev/health`
   → `{"status":"ok"}`. (Worker deploys: `cd workers && npm run deploy`.)
2. **Check browser quota** — `curl .../limits`. Cloudflare Free plan allows
   ~3 browser launches/min; the pool self-limits to 2/min with 429 backoff.
   Quota exhausted → wait, or reduce `BROWSER_MIN_LAUNCH_INTERVAL_MS` tuning.
3. **Check logs** — `wrangler tail` (structured JSON: level, component, msg).
4. **Check DO stats** — `curl -X POST .../ -d '{"action":"getStats"}' -H 'Content-Type: application/json'`
   → launch/reuse/error counters, `browserActive`.
5. **Recovery** — redeploy `cd workers && npm run deploy`; the DO survives
   deploys (sqlite-backed class). If sessions are wedged:
   `{"action":"closeBrowserInstances"}`.
6. **Impact assessment** — while the worker is down, the fetcher still
   completes via the Render/Playwright fallbacks; Merit dynamic info may be
   missing in campaign payloads (documented degradation, not data loss).
