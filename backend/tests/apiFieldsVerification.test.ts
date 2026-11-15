import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OLD_FIELD_NAMES = [
  "reserveSize",
  "totalVariableDebt",
  "availableLiquidity",
  "reserveFactor",
  "variableRateSlope1",
  "variableRateSlope2",
  "optimalUsageRate",
  "baseVariableBorrowRate",
] as const;

/**
 * Present on every reserve: the supply side plus the protocol-level parameters
 * that come from `supplyInfo` / the market itself. None of these depend on
 * `borrowInfo` existing, so a reserve missing one is a real hole.
 *
 * `supplyApy` is deliberately absent: it is `undefined` when supply is disabled
 * or the market reports a zero cap, and both are legitimate.
 */
const ALWAYS_PRESENT = [
  "supplied",
  "supplyCap",
  "baseBorrowRate",
  "ltv",
  "liquidationThreshold",
] as const;

/**
 * Every one of these is read from `reserve.borrowInfo` in
 * `packages/aave-fetcher/src/concurrent-fetch.ts`. They are all-or-nothing: the
 * SDK either returns a borrow side or it returns `borrowInfo: null` (a reserve
 * whose borrowing was switched off), and the fetcher does not synthesise a
 * partial block. A half-populated block means the field mapping drifted.
 *
 * `protocolFee` is not in this list on purpose — see ABSENT_MEANS_ZERO.
 */
const BORROW_SIDE = [
  "borrowApy",
  "borrowCap",
  "borrowed",
  "liquidity",
  "slopeBelowOptimal",
  "slopeAboveOptimal",
  "optimalUtilization",
  "utilizationPct",
] as const;

/**
 * `protocolFee: 0` is omitted by the API on purpose: the frontend contract is
 * "absent means 0" (`aaveapy/docs/rate-calculation.md`, AAV-1350), and
 * `serializeReserveForApi` has a test pinning that behaviour. It therefore
 * cannot take part in a presence assertion — 45 of the 441 staging reserves
 * have a zero fee and would read as missing.
 */
const ABSENT_MEANS_ZERO = "protocolFee";

interface MarketsResponse {
  snapshot: { version: string };
  reserves: Array<Record<string, unknown>>;
}

const API_URL =
  process.env.API_FIELDS_TEST_URL ??
  "https://staging-api.aaveapy.com/api/markets";

let snapshot: MarketsResponse | null | undefined;

/**
 * One fetch per run, shared by every assertion: five independent requests can
 * land on different snapshots (reserves are added and removed between them) and
 * a staging hiccup on one of them used to fail only the assertions after it.
 */
function markets(): MarketsResponse | null {
  if (snapshot === undefined) {
    snapshot = fetchMarkets();
  }
  return snapshot;
}

function fetchMarkets(): MarketsResponse | null {
  try {
    const raw = execSync(`curl -sf --max-time 30 "${API_URL}"`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(raw) as MarketsResponse;
  } catch (err) {
    console.error(`Failed to fetch ${API_URL}:`, String(err));
    return null;
  }
}

function reserveLabel(reserve: Record<string, unknown>): string {
  return String(reserve.reserveId ?? "<no reserveId>");
}

test(
  "API fields v3 — snapshot version matches MARKETS_API_VERSION",
  { skip: !process.env.RUN_API_FIELDS_TESTS },
  async () => {
    // Read the constant instead of a literal: the assertion previously pinned
    // the pre-rename name and could not follow the implementation (AAV-1378).
    const { MARKETS_API_VERSION } = await import("../src/types/index.js");

    const data = markets();
    if (!data) {
      assert.fail(`Could not fetch API at ${API_URL}`);
    }
    assert.equal(
      data.snapshot.version,
      MARKETS_API_VERSION,
      `Expected version '${MARKETS_API_VERSION}' but got '${data.snapshot.version}'`
    );
  }
);

test(
  "API fields v3 — no old field names leaked in any reserve",
  { skip: !process.env.RUN_API_FIELDS_TESTS },
  () => {
    const data = markets();
    if (!data) {
      assert.fail(`Could not fetch API at ${API_URL}`);
    }

    const leakedFields = new Set<string>();
    for (const reserve of data.reserves) {
      for (const field of OLD_FIELD_NAMES) {
        if (field in reserve) {
          leakedFields.add(field);
          if (leakedFields.size <= 5) {
            console.warn(
              `  OLD field '${field}' found in reserve ${reserve.reserveId}`
            );
          }
        }
      }
    }
    assert.deepStrictEqual(
      [...leakedFields],
      [],
      `Old field names still present in API response: [${[...leakedFields].join(", ")}]`
    );
  }
);

test(
  "API fields v3 — supply-side fields are present on every reserve",
  { skip: !process.env.RUN_API_FIELDS_TESTS },
  () => {
    const data = markets();
    if (!data) {
      assert.fail(`Could not fetch API at ${API_URL}`);
    }
    assert.ok(data.reserves.length > 0, "No reserves in response");

    const missing: string[] = [];
    for (const reserve of data.reserves) {
      for (const field of ALWAYS_PRESENT) {
        if (!(field in reserve)) {
          missing.push(`${reserveLabel(reserve)}:${field}`);
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      `${missing.length} missing supply-side field(s) out of ${data.reserves.length} reserves: ${missing.slice(0, 10).join(", ")}`
    );
  }
);

test(
  "API fields v3 — the borrow-side block is all-or-nothing",
  { skip: !process.env.RUN_API_FIELDS_TESTS },
  () => {
    const data = markets();
    if (!data) {
      assert.fail(`Could not fetch API at ${API_URL}`);
    }

    const partial: string[] = [];
    for (const reserve of data.reserves) {
      const present = BORROW_SIDE.filter((field) => field in reserve);
      if (present.length === 0 || present.length === BORROW_SIDE.length) {
        continue;
      }
      const absent = BORROW_SIDE.filter((field) => !(field in reserve));
      partial.push(
        `${reserveLabel(reserve)} has ${present.length}/${BORROW_SIDE.length}, missing [${absent.join(", ")}]`
      );
    }

    assert.deepEqual(
      partial,
      [],
      `Borrow side is partially populated on ${partial.length} reserve(s); the fetcher must emit the block whole or not at all: ${partial.slice(0, 10).join("; ")}`
    );
  }
);

test(
  "API fields v3 — a reserve with no borrow side is disabled, frozen, paused or inactive",
  { skip: !process.env.RUN_API_FIELDS_TESTS },
  () => {
    const data = markets();
    if (!data) {
      assert.fail(`Could not fetch API at ${API_URL}`);
    }

    const unexplained: string[] = [];
    for (const reserve of data.reserves) {
      if (BORROW_SIDE.some((field) => field in reserve)) continue;

      const explained =
        reserve.borrowDisabled === true ||
        reserve.isFrozen === true ||
        reserve.isPaused === true ||
        reserve.isActive === false;
      if (!explained) {
        unexplained.push(reserveLabel(reserve));
      }
    }

    assert.deepEqual(
      unexplained,
      [],
      `${unexplained.length} reserve(s) have no borrow side without a protocol flag explaining it — that is a data gap, not a market shape: ${unexplained.slice(0, 10).join(", ")}`
    );
  }
);

test(
  "API fields v3 — protocolFee is a 0..100 percent when present, absent means 0",
  { skip: !process.env.RUN_API_FIELDS_TESTS },
  () => {
    const data = markets();
    if (!data) {
      assert.fail(`Could not fetch API at ${API_URL}`);
    }

    const invalid: string[] = [];
    for (const reserve of data.reserves) {
      if (!(ABSENT_MEANS_ZERO in reserve)) continue;
      const fee = reserve[ABSENT_MEANS_ZERO];
      if (
        typeof fee !== "number" ||
        !Number.isFinite(fee) ||
        fee < 0 ||
        fee > 100
      ) {
        invalid.push(`${reserveLabel(reserve)}: ${String(fee)}`);
      }
    }

    assert.deepEqual(
      invalid,
      [],
      `protocolFee must be a finite percent in 0..100: ${invalid.slice(0, 10).join(", ")}`
    );
  }
);

test("API fields v3 — the version assertion does not hardcode a version", () => {
  // A literal survives renames: the old assertion kept spelling the previous
  // name and stayed red for as long as nobody ran it. Any hardcoded version in
  // this file now fails here, so the constant is the only way to spell it.
  const source = readFileSync(fileURLToPath(import.meta.url), "utf-8");
  const hardcodedVersion = /["'](?:markets|snapshot)-v\d+["']/;

  assert.ok(
    !hardcodedVersion.test(source),
    "apiFieldsVerification.test.ts must read MARKETS_API_VERSION instead of spelling a version literal"
  );
});
