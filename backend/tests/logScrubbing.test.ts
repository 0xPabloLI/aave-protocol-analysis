import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import winston from "winston";

import {
  logger,
  scrubSensitiveMeta,
  scrubSecretsInString,
} from "../src/logger.js";
import { getAnalyticsLogger } from "../src/analytics.js";

const MESSAGE = Symbol.for("message");
// logform's colorize() looks the level up through this symbol; a hand-built
// info object without it makes colorize throw.
const LEVEL = Symbol.for("level");

/**
 * Render an info object through a format chain and return the emitted line.
 * Winston resolves a transport's format at log time and always passes the
 * format's own options (`format.transform(info, format.options)`); calling
 * `transform(info)` with no options makes colorize read `opts.all` off
 * `undefined` and throw, so the harness has to mirror winston here.
 */
function renderWith(
  format: {
    transform(info: unknown, opts?: unknown): unknown;
    options?: unknown;
  },
  info: Record<string, unknown>
): string {
  const formatted = format.transform(
    {
      level: "info",
      [LEVEL]: "info",
      ...info,
    },
    format.options ?? {}
  ) as Record<symbol | string, unknown>;
  return String(formatted[MESSAGE] ?? "");
}

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

// ── Pattern scrub: secrets embedded in free-text values ──────────────────────

test("scrubSecretsInString: redacts Bearer tokens and JWT triples", () => {
  assert.equal(
    scrubSecretsInString("upstream said: Bearer eyJhbGciOiJIUzI1NiJ9xx"),
    "upstream said: Bearer [REDACTED]"
  );
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.ok(!scrubSecretsInString(`auth failed for ${jwt}`).includes("eyJ"));
});

test("scrubSecretsInString: redacts URL credentials and query-string secrets", () => {
  const url = "postgres://admin:s3cret@db.internal:5432/aave";
  assert.equal(
    scrubSecretsInString(url),
    "postgres://[REDACTED]@db.internal:5432/aave"
  );
  assert.equal(
    scrubSecretsInString("GET https://x.test/v1?a=1&api_key=abc123&b=2"),
    "GET https://x.test/v1?a=1&api_key=[REDACTED]&b=2"
  );
  assert.equal(
    scrubSecretsInString("retry ?token=live_token_987"),
    "retry ?token=[REDACTED]"
  );
});

test("scrubSecretsInString: redacts provider key prefixes and header-style values", () => {
  assert.ok(
    !scrubSecretsInString("using sk-abcdefghijklmnopqrstuvwxyz").includes(
      "sk-abcdefghij"
    )
  );
  assert.ok(
    !scrubSecretsInString(
      "push with ghp_abcdefghijklmnopqrstuvwxyz0123"
    ).includes("ghp_")
  );
  assert.equal(
    scrubSecretsInString('curl -H "x-api-key: abcdef123456"'),
    'curl -H "x-api-key: [REDACTED]"'
  );
});

test("scrubSecretsInString: leaves ordinary prose and short strings intact", () => {
  assert.equal(
    scrubSecretsInString("the token is required for this endpoint"),
    "the token is required for this endpoint"
  );
  assert.equal(scrubSecretsInString("ok"), "ok");
  assert.equal(
    scrubSecretsInString("merkl campaign 0xdeadbeef expired"),
    "merkl campaign 0xdeadbeef expired"
  );
});

test("scrubSensitiveMeta: scrubs secret-shaped values under innocent keys", () => {
  const out = scrubSensitiveMeta({
    upstream: "Bearer eyJhbGciOiJIUzI1NiJ9xx",
    requestUrl: "https://api.test/x?apikey=abcdef123456",
    detail: "retry scheduled in 30s",
  });
  assert.equal(out.upstream, "Bearer [REDACTED]");
  assert.equal(out.requestUrl, "https://api.test/x?apikey=[REDACTED]");
  assert.equal(out.detail, "retry scheduled in 30s");
});

// ── Transport wiring: every channel must sit behind the scrub format ─────────

const LEAKY_INFO = {
  message: "auth header was Bearer eyJhbGciOiJIUzI1NiJ9xx",
  authorization: "Bearer eyJhbGciOiJIUzI1NiJ9xx",
  nested: { apiKey: "should-not-leak-1234" },
};

function assertScrubbed(line: string, channel: string): void {
  assert.ok(line.includes("[REDACTED]"), `${channel} did not scrub: ${line}`);
  assert.ok(
    !line.includes("eyJhbGciOiJIUzI1NiJ9xx"),
    `${channel} leaked a token: ${line}`
  );
  assert.ok(
    !line.includes("should-not-leak-1234"),
    `${channel} leaked a nested key: ${line}`
  );
}

test("logger-level format scrubs (the file-transport path)", () => {
  assertScrubbed(renderWith(logger.format, LEAKY_INFO), "logger.format");
});

test("every transport channel renders redacted output", () => {
  assert.ok(logger.transports.length >= 1, "expected at least one transport");

  for (const transport of logger.transports) {
    const channel = transport.constructor.name;
    // A transport with its own format overrides logger.format (Console does);
    // otherwise it inherits logger.format. Either way the line must be scrubbed.
    const format = transport.format ?? logger.format;
    assertScrubbed(renderWith(format, LEAKY_INFO), `${channel} transport`);
  }
});

test("console transport carries the scrub format (not a bare colouriser)", () => {
  const consoleTransport = logger.transports.find(
    (t) => t instanceof winston.transports.Console
  );
  // The console transport is only registered outside production; in any other
  // environment it must exist so this regression cannot hide.
  assert.ok(
    consoleTransport,
    "console transport missing — logger was built with NODE_ENV=production?"
  );
  assert.ok(
    consoleTransport.format,
    "console transport has no own format, so it cannot be verified independently"
  );
  assertScrubbed(
    renderWith(consoleTransport.format, LEAKY_INFO),
    "console transport"
  );
});

// ── Analytics channel: a separate log file is not a separate policy ──────────

test("analytics channel scrubs secret-shaped fields and keeps the event shape", () => {
  const analytics = getAnalyticsLogger();
  const line = renderWith(analytics.format, {
    message: "",
    event: "api_request",
    requestId: "req-1",
    authorization: "Bearer eyJhbGciOiJIUzI1NiJ9xx",
    nested: { apiKey: "should-not-leak-1234" },
  });

  // The gate must not damage the pipeline's own contract...
  assert.match(line, /"event":"api_request"/);
  assert.match(line, /"requestId":"req-1"/);
  // ...but nothing credential-shaped may reach logs/analytics.log.
  assertScrubbed(line, "analytics.log");
});

test("analytics transport inherits the scrubbed logger format", () => {
  const analytics = getAnalyticsLogger();
  assert.equal(
    analytics.transports.length,
    1,
    "expected a single rotating analytics file"
  );
  // A transport with its own format would silently bypass logger.format.
  assert.equal(
    analytics.transports[0].format,
    undefined,
    "analytics transport overrides the logger format, so it cannot be assumed safe"
  );
  assert.ok(analytics.format, "analytics logger has no format at all");
});

// ── Regression: the scrub format must not eat triple-beam symbols ────────────
//
// Rebuilding the record with `{ ...scrubbed, level, message }` dropped the
// LEVEL symbol, and winston-transport gates every write on
// `levels[info[LEVEL]]`. The result was a silent total log blackout: no
// console output, no file output, and not even an error to notice.

test("the logger format preserves the LEVEL symbol on the record", () => {
  const info = {
    level: "info",
    [LEVEL]: "info",
    message: "kept",
    authorization: "Bearer eyJhbGciOiJIUzI1NiJ9xx",
  };
  const out = logger.format.transform(info, logger.format.options) as Record<
    string | symbol,
    unknown
  >;
  assert.equal(
    out[LEVEL],
    "info",
    "LEVEL symbol was dropped — every transport will now discard the record"
  );
  assert.equal(out.level, "info");
  assert.equal(out.authorization, "[REDACTED]");
});

test("a real log call survives the transport level gate and arrives redacted", async () => {
  const lines: string[] = [];
  let notify: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      notify?.();
      done();
    },
  });

  const capture = new winston.transports.Stream({ stream: sink });
  logger.add(capture);
  try {
    logger.info("auth header was Bearer eyJhbGciOiJIUzI1NiJ9xx", {
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9xx",
      nested: { apiKey: "should-not-leak-1234" },
    });

    await Promise.race([
      arrived,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);

    assert.equal(
      lines.length,
      1,
      "the record never reached the transport — it was dropped silently"
    );
    assertScrubbed(lines.join(""), "live logger.info call");
  } finally {
    logger.remove(capture);
    sink.end();
  }
});
