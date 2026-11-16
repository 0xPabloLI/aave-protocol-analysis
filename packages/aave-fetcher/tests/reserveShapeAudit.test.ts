import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../src/logger.js";
import {
  auditShape,
  auditV3InputShape,
  auditV4ReserveShape,
  formatShapeAudit,
  reportShapeAudit,
  resetShapeAuditReports,
  v3ReserveLabel,
  V3_MARKET_KEYS,
  V3_RESERVE_KEYS,
  V4_RESERVE_KEYS,
} from "../src/reserve-shape.js";
import { buildV3BaseDataset } from "../src/concurrent-fetch.js";

/**
 * AAV-1379 follow-up: the SDK contract (which keys a payload must carry) is
 * pinned twice — `satisfies keyof` at build time, and a per-cycle runtime audit
 * that reports what actually arrived. These tests cover the runtime half and,
 * critically, the *wiring*: a pure audit helper nobody calls would be exactly
 * the "file exists ≠ it runs" failure shape this repo keeps finding.
 */

/** Deliberately minimal: the audit only cares about key presence, not values. */
function reserve(overrides: Record<string, unknown> = {}): unknown {
  return {
    underlyingToken: { symbol: "T0", address: "0xt0", name: "T", decimals: 18 },
    aToken: { address: "0xa" },
    vToken: { address: "0xv" },
    size: { amount: { raw: "1" } },
    supplyInfo: { apy: { value: "0.01" } },
    borrowInfo: null,
    isFrozen: false,
    isPaused: false,
    usdExchangeRate: "1",
    ...overrides,
  };
}

function market(reserves: unknown[]): unknown {
  return {
    address: "0xpool",
    name: "M0",
    chain: { name: "Ethereum", chainId: 1 },
    supplyReserves: reserves,
  };
}

type LogMethod = "info" | "warn";

function capture(method: LogMethod): { lines: string[]; restore(): void } {
  const original = (logger as unknown as Record<string, unknown>)[method];
  const lines: string[] = [];
  (logger as unknown as Record<string, unknown>)[method] = (msg: unknown) => {
    lines.push(String(msg));
  };
  return {
    lines,
    restore() {
      (logger as unknown as Record<string, unknown>)[method] = original;
    },
  };
}

describe("auditShape — key presence over a payload", () => {
  it("counts a present-but-null key separately from a missing one", () => {
    const audit = auditShape(
      [reserve(), reserve({ borrowInfo: undefined })],
      ["borrowInfo", "isFrozen"]
    );

    assert.equal(audit.total, 2);
    assert.equal(audit.missing.borrowInfo, 1, "`undefined` is a missing key");
    assert.equal(audit.nullish.borrowInfo, 1, "`null` is present-but-null");
    assert.equal(audit.missing.isFrozen, 0);
    assert.equal(audit.clean, false);
  });

  it("is clean when every row carries every key, even all-null", () => {
    const audit = auditShape(
      [reserve(), reserve({ borrowInfo: null })],
      ["borrowInfo", "supplyInfo", "isFrozen"]
    );

    assert.equal(audit.clean, true);
    assert.equal(audit.nullish.borrowInfo, 2);
    assert.equal(audit.samples.length, 0);
  });

  it("treats a non-object row as missing every key, without throwing", () => {
    const audit = auditShape([null, undefined, 42], ["borrowInfo"]);

    assert.equal(audit.total, 3);
    assert.equal(audit.missing.borrowInfo, 3);
    assert.equal(audit.samples.length, 3);
  });

  it("caps the sample list but keeps counting", () => {
    const rows = Array.from({ length: 9 }, () => ({}));
    const audit = auditShape(rows, ["borrowInfo"]);

    assert.equal(audit.missing.borrowInfo, 9);
    assert.equal(audit.samples.length, 5);
  });

  it("labels samples through the caller's lens", () => {
    const audit = auditShape(
      [reserve({ isFrozen: undefined, underlyingToken: { address: "0xz" } })],
      ["isFrozen"],
      (row) =>
        String(
          (row as { underlyingToken?: { address?: string } })?.underlyingToken
            ?.address ?? "?"
        )
    );

    assert.match(audit.samples[0], /0xz/);
    assert.match(audit.samples[0], /isFrozen/);
  });
});

describe("reportShapeAudit — logging policy", () => {
  let info: ReturnType<typeof capture>;
  let warn: ReturnType<typeof capture>;

  beforeEach(() => {
    resetShapeAuditReports();
    info = capture("info");
    warn = capture("warn");
  });

  afterEach(() => {
    info.restore();
    warn.restore();
  });

  it("announces a clean audit once per scope, not once per cycle", () => {
    const clean = auditShape([reserve()], V3_RESERVE_KEYS);

    reportShapeAudit("V3.reserve", clean);
    reportShapeAudit("V3.reserve", clean);
    reportShapeAudit("V3.reserve", clean);

    assert.equal(info.lines.length, 1, "deduped per scope");
    assert.equal(warn.lines.length, 0);
    assert.match(info.lines[0], /carried/);
    assert.match(info.lines[0], /borrowInfo/);
  });

  it("different scopes each get their own clean announcement", () => {
    const clean = auditShape([reserve()], V3_RESERVE_KEYS);

    reportShapeAudit("V3.reserve", clean);
    reportShapeAudit("V4.reserve", clean);

    assert.equal(info.lines.length, 2);
  });

  it("logs drift on every call with the missing keys and a sample", () => {
    const drifted = auditShape(
      [reserve({ supplyInfo: undefined })],
      V3_RESERVE_KEYS,
      v3ReserveLabel
    );

    reportShapeAudit("V3.reserve", drifted);
    reportShapeAudit("V3.reserve", drifted);

    assert.equal(info.lines.length, 0);
    assert.equal(warn.lines.length, 2, "drift is never deduped");
    assert.match(warn.lines[0], /supplyInfo on 1\/1/);
    assert.match(warn.lines[0], /loosens flags/);
    assert.match(warn.lines[0], /T0:0xt0/);
  });

  it("stays silent for an empty payload (nothing was audited)", () => {
    reportShapeAudit("V3.reserve", auditShape([], V3_RESERVE_KEYS));

    assert.equal(info.lines.length, 0);
    assert.equal(warn.lines.length, 0);
  });

  it("formatShapeAudit renders the clean line with null counts", () => {
    const line = formatShapeAudit(
      "V3.reserve",
      auditShape([reserve()], V3_RESERVE_KEYS)
    );

    assert.match(line, /1\/1 carried/);
    assert.match(line, /present-but-null: borrowInfo=1/);
  });
});

describe("wiring — buildV3BaseDataset runs the audit for real", () => {
  let info: ReturnType<typeof capture>;
  let warn: ReturnType<typeof capture>;

  beforeEach(() => {
    resetShapeAuditReports();
    info = capture("info");
    warn = capture("warn");
  });

  afterEach(() => {
    info.restore();
    warn.restore();
  });

  it("auditV3InputShape returns both scopes without logging an empty payload", () => {
    const empty = auditV3InputShape([]);
    assert.equal(empty.markets.total, 0);
    assert.equal(empty.reserves.total, 0);

    const audits = auditV3InputShape([market([reserve()])]);
    assert.equal(audits.markets.total, 1);
    assert.equal(audits.markets.clean, true);
    assert.equal(audits.reserves.total, 1);
    assert.equal(audits.reserves.clean, true);
    assert.match(info.lines.join("\n"), /\[V3\.reserve\]/);
  });

  it("a clean payload announces both scopes once and maps normally", () => {
    const dataset = buildV3BaseDataset([market([reserve(), reserve()])]);

    assert.equal(dataset.length, 2);
    assert.match(
      info.lines.join("\n"),
      /\[V3\.market\] reserve shape ok: 1\/1/,
      "market scope audited"
    );
    assert.match(
      info.lines.join("\n"),
      /\[V3\.reserve\] reserve shape ok: 2\/2/,
      "flattened reserve scope audited"
    );
    assert.equal(warn.lines.length, 0);
  });

  it("a reserve missing a decision key turns into a warning naming the token", () => {
    buildV3BaseDataset([market([reserve({ isFrozen: undefined }), reserve()])]);

    assert.equal(warn.lines.length, 1);
    assert.match(warn.lines[0], /\[V3\.reserve\]/);
    assert.match(warn.lines[0], /isFrozen on 1\/2/);
    assert.match(warn.lines[0], /T0:0xt0/);
  });

  it("a market missing `chain` is reported at the market scope", () => {
    const broken = market([reserve()]) as Record<string, unknown>;
    delete broken.chain;

    buildV3BaseDataset([broken]);

    assert.match(warn.lines[0], /\[V3\.market\]/);
    assert.match(warn.lines[0], /chain on 1\/1/);
  });
});

describe("auditV4ReserveShape", () => {
  it("counts the V4 keys the mapper reads", () => {
    const audit = auditV4ReserveShape([
      {
        spoke: {},
        chain: {},
        asset: { underlying: { symbol: "T4", address: "0xt4" } },
        summary: {},
        settings: {},
        status: {},
        canBorrow: true,
        canSupply: true,
      },
    ]);

    assert.equal(audit.total, 1);
    assert.equal(audit.clean, true);
  });

  it("reports a missing `canBorrow` as drift", () => {
    let warn: ReturnType<typeof capture> | null = null;
    try {
      warn = capture("warn");
      auditV4ReserveShape([
        {
          spoke: {},
          chain: {},
          asset: {},
          summary: {},
          settings: {},
          status: {},
        },
      ]);
      assert.match(warn.lines[0], /canBorrow on 1\/1/);
    } finally {
      warn?.restore();
    }
  });
});

describe("key lists cover what the mappers actually read", () => {
  it("V3 market keys match the mapper's top-level reads", () => {
    // `satisfies keyof` in reserve-shape.ts already pins these against the SDK
    // types at build time; this asserts the *runtime* lists are what the audit
    // consumes, so a future edit cannot desynchronise one from the other.
    assert.deepEqual([...V3_MARKET_KEYS].sort(), [
      "address",
      "chain",
      "name",
      "supplyReserves",
    ]);
    assert.deepEqual([...V3_RESERVE_KEYS].sort(), [
      "aToken",
      "borrowInfo",
      "isFrozen",
      "isPaused",
      "size",
      "supplyInfo",
      "underlyingToken",
      "usdExchangeRate",
      "vToken",
    ]);
    assert.deepEqual([...V4_RESERVE_KEYS].sort(), [
      "asset",
      "canBorrow",
      "canSupply",
      "chain",
      "settings",
      "spoke",
      "status",
      "summary",
    ]);
  });
});
