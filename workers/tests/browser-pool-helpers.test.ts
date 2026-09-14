import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSemaphore,
  isRateLimitError,
  getRetryAfterMs,
  secureRandomIndex,
  secureRandomAlphaNum,
} from "../src/browser-pool.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("isRateLimitError", () => {
  it("detects error code 429", () => {
    const err: Error & { code: number } = Object.assign(
      new Error("launch failed"),
      { code: 429 }
    );
    assert.equal(isRateLimitError(err), true);
  });

  it("detects rate limit message variants", () => {
    assert.equal(
      isRateLimitError(new Error("Rate limit exceeded: 2 launches")),
      true
    );
    assert.equal(isRateLimitError(new Error("got 429 from upstream")), true);
    assert.equal(isRateLimitError(new Error("Too Many Requests")), true);
    assert.equal(
      isRateLimitError(new Error("quota exceeded for binding")),
      true
    );
  });

  it("rejects non-rate-limit errors and non-errors", () => {
    assert.equal(isRateLimitError(new Error("network down")), false);
    assert.equal(isRateLimitError("429 string not an error"), false);
    assert.equal(isRateLimitError(null), false);
    assert.equal(isRateLimitError(undefined), false);
  });
});

describe("getRetryAfterMs", () => {
  it("parses retry-after seconds into milliseconds", () => {
    assert.equal(
      getRetryAfterMs(new Error("Rate limit: retry-after: 30"), 0),
      30000
    );
    assert.equal(getRetryAfterMs(new Error("Retry-After:12 wait"), 0), 12000);
    assert.equal(getRetryAfterMs(new Error("retry after 5"), 0), 5000);
  });

  it("falls back to the default when absent or not an error", () => {
    assert.equal(getRetryAfterMs(new Error("no hint here"), 1500), 1500);
    assert.equal(getRetryAfterMs("not an error", 2000), 2000);
  });
});

describe("createSemaphore", () => {
  it("admits up to concurrency holders immediately", async () => {
    const semaphore = createSemaphore(2);
    const release1 = await semaphore.acquire();
    const release2 = await semaphore.acquire();
    assert.ok(typeof release1 === "function");
    assert.ok(typeof release2 === "function");
    release1();
    release2();
  });

  it("queues holders beyond concurrency and resolves on release (FIFO)", async () => {
    const semaphore = createSemaphore(1);
    const release1 = await semaphore.acquire();

    const order: string[] = [];
    const second = semaphore.acquire().then((release) => {
      order.push("second");
      return release;
    });
    const third = semaphore.acquire().then((release) => {
      order.push("third");
      return release;
    });

    await sleep(20);
    assert.deepEqual(order, [], "no queued holder should run before release");

    release1();
    await sleep(20);
    assert.deepEqual(
      order,
      ["second"],
      "only one queued holder resolves per release"
    );

    const release2 = await second;
    release2();
    await sleep(20);
    assert.deepEqual(order, ["second", "third"]);

    const release3 = await third;
    release3();
  });
});

describe("secureRandomIndex", () => {
  it("returns values within [0, maxExclusive) across many samples", () => {
    for (let i = 0; i < 1000; i++) {
      const value = secureRandomIndex(7);
      assert.ok(
        Number.isInteger(value) && value >= 0 && value < 7,
        `out of range: ${value}`
      );
    }
  });

  it("covers the full range for a small bound", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(secureRandomIndex(3));
    assert.deepEqual([...seen].sort(), [0, 1, 2]);
  });

  it("rejects invalid bounds", () => {
    assert.throws(() => secureRandomIndex(0), /invalid maxExclusive/);
    assert.throws(() => secureRandomIndex(-3), /invalid maxExclusive/);
    assert.throws(() => secureRandomIndex(2.5), /invalid maxExclusive/);
  });
});

describe("secureRandomAlphaNum", () => {
  it("produces lowercase alphanumeric strings of the requested length", () => {
    for (const len of [1, 6, 16]) {
      const out = secureRandomAlphaNum(len);
      assert.equal(out.length, len);
      assert.match(out, /^[a-z0-9]+$/);
    }
  });

  it("returns an empty string for length 0", () => {
    assert.equal(secureRandomAlphaNum(0), "");
  });

  it("is not degenerate (repeated calls differ)", () => {
    const a = secureRandomAlphaNum(16);
    const b = secureRandomAlphaNum(16);
    assert.notEqual(a, b);
  });
});
