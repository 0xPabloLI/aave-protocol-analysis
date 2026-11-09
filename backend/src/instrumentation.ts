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
    sendDefaultPii: false,
    beforeSend(event) {
      // Defense-in-depth: never ship credential-looking material.
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
