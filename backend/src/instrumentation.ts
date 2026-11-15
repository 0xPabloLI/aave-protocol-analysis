import * as Sentry from "@sentry/node";

/**
 * Sentry error tracking — env-gated.
 *
 * Dormant unless SENTRY_DSN is set (and SENTRY_ENABLED !== false); the app
 * runs identically without it, so local dev and tests need no Sentry account.
 * Request IDs (see middleware/requestId.ts) are attached as tags so a
 * production error can be traced back to the exact request + log line.
 */

export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || process.env.SENTRY_ENABLED === "false") {
    return false;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // Sentry v11 removed `sendDefaultPii` *and* the restrictive mapping it
    // selected. With no `dataCollection` set the SDK now collects user info
    // (the client IP), request/response bodies and database query data, and it
    // no longer filters IP-bearing headers such as `x-forwarded-for` (v10's
    // `PII_HEADER_SNIPPETS` is gone). Each category is denied explicitly to
    // hold the posture documented in docs/operations/pii-handling-policy.md.
    // `graphQL` and `stackFrameVariables` stay at their defaults, which is what
    // `sendDefaultPii: false` gave us in v10 — this migration does not change
    // them.
    dataCollection: {
      userInfo: false,
      cookies: false,
      // Object form, not `false`: v10 types `httpHeaders` as an object only
      // (the bare `CollectBehavior` union arrived in v11), so this spelling is
      // the one that compiles on both.
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      genAI: { inputs: false, outputs: false },
      // TODO(AAV-1358): v11 adds `mcp` and `queues`, both enabled by default.
      // Deny them in the same commit as the version bump — v10's
      // `DataCollection` has no such fields, so they cannot be listed here yet.
    },
    beforeSend(event) {
      // Belt and braces: `dataCollection.httpHeaders: false` already keeps
      // headers out of events, so this only bites if that is ever loosened.
      // Never ship credential-looking material.
      if (event.request?.headers) {
        delete (event.request.headers as Record<string, unknown>)[
          "authorization"
        ];
        delete (event.request.headers as Record<string, unknown>)["cookie"];
      }
      return event;
    },
  });
  return true;
}

export function tagRequestScope(req: { requestId?: string }): void {
  if (!req.requestId) return;
  Sentry.getCurrentScope().setTag("request_id", req.requestId);
}
