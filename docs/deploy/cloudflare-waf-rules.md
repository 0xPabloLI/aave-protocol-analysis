# Cloudflare WAF Rules — Bot & Scanner Filtering

## Background

On May 31, the service received 584 4xx errors in a single interval, followed by 99 in another.
The catch-all 404 handler now logs these requests (`404: GET /admin from 1.2.3.4 ua="..."`),
but they still consume server resources. Cloudflare WAF rules can block them upstream.

## Rule Set

Apply these in the Cloudflare dashboard → **Security → WAF → Custom rules** for the
`staging-api.aaveapy.com` / `aaveapy.com` zone.

### 1. Block known bot-target paths

| Filter | Action | Reason |
|--------|--------|--------|
| URI Path in `{/robots.txt, /sitemap.xml, /sitemap.xml.gz}` | Block | No such files exist; crawlers generate 404s |
| URI Path in `{/admin, /wp-admin, /wp-login.php, /wp-json, /.env, /.git, /config.json, /api/v1, /graphql}` | Block | Security scanners probing common endpoints |
| URI Path in `{/xmlrpc.php, /phpmyadmin, /pma, /server-status, /actuator, /.well-known/security.txt}` but method ≠ GET | Block | Non-GET probes to well-known paths; server serves `/.well-known/security.txt` via GET, so only non-GET should be blocked |

### 2. Challenge suspicious user-agents (optional)

| Filter | Action | Reason |
|--------|--------|--------|
| User-Agent contains `{Shodan, Censys, masscan, ZmEu, sqlmap}` | Block | Known scanner user-agents |
| User-Agent is empty AND URI Path starts with `/api/` | Block | Legit API clients always send UA |

### 3. Rate-limit by IP (complementary)

| Filter | Action | Reason |
|--------|--------|--------|
| Requests per 10s > 50 from same IP | Block | Generic brute-force protection |

## Implementation Steps

1. Go to Cloudflare dashboard → select the zone for `aaveapy.com`
2. Navigate to **Security → WAF → Custom rules**
3. Create each rule above as a separate custom filter with **Block** action
4. Monitor **Security → Events** for 24h to verify legitimate traffic is unaffected
5. Adjust thresholds if false positives appear

## Monitoring

After enabling WAF rules:
- **Server-side**: Watch `combined.log` for `404:` entries — count should drop significantly
- **Cloudflare-side**: Check **Security → Events** for blocked request analytics
- **Railway**: Compare 4xx error rate before/after in HTTP logs

## Rollback

WAF rules can be disabled instantly in the Cloudflare dashboard. No server-side changes required.
