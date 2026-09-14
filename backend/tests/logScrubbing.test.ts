import { test } from "node:test";
import assert from "node:assert/strict";

import { scrubSensitiveMeta } from "../src/logger.js";

test("scrubSensitiveMeta: redacts credential-looking keys at top level", () => {
  const out = scrubSensitiveMeta({
    authorization: "Bearer abc",
    apiKey: "k-123",
    token: "t",
    password: "p",
    cookie: "session=1",
    sentryDsn: "https://x@o.ingest.sentry.io/1",
    safeField: "visible",
  });
  assert.equal(out.authorization, "[REDACTED]");
  assert.equal(out.apiKey, "[REDACTED]");
  assert.equal(out.token, "[REDACTED]");
  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.cookie, "[REDACTED]");
  assert.equal(out.sentryDsn, "[REDACTED]");
  assert.equal(out.safeField, "visible");
});

test("scrubSensitiveMeta: redacts nested and array elements", () => {
  const out = scrubSensitiveMeta({
    request: {
      headers: {
        Authorization: "Bearer x",
        "Content-Type": "application/json",
      },
      tags: [{ token: "leak" }, { ok: 1 }],
    },
  }) as {
    request: {
      headers: Record<string, unknown>;
      tags: Array<Record<string, unknown>>;
    };
  };
  assert.equal(out.request.headers.Authorization, "[REDACTED]");
  assert.equal(out.request.headers["Content-Type"], "application/json");
  assert.equal(out.request.tags[0].token, "[REDACTED]");
  assert.equal(out.request.tags[1].ok, 1);
});

test("scrubSensitiveMeta: handles null / primitives / deep cycles safely", () => {
  assert.equal(scrubSensitiveMeta(null), null);
  assert.equal(scrubSensitiveMeta("str"), "str");
  assert.equal(scrubSensitiveMeta(42), 42);
  const circular: Record<string, unknown> = { name: "a" };
  circular.self = circular;
  const out = scrubSensitiveMeta(circular) as Record<string, unknown>;
  assert.equal(out.name, "a");
});
