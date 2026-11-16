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
 * every market must be able to describe.
 *
 * `supplied` / `supplyCap` / `ltv` / `liquidationThreshold` come from
 * `supplyInfo` and the market itself. `baseBorrowRate` does not: on V3 it is
 * filled by `marketsService` from the SDK, then an on-chain read, then a
 * fallback derived from the borrow fields; on V4 it comes from the hub's
 * `settings`. It belongs here because a reserve without a rate model cannot be
 * priced at all, but a failure here points at RPC coverage, not at supply
 * serialisation — check `marketsService` first.
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
 * The borrow side. A reserve either has all of these or none of them — the
 * frontend reads them as one block, and a half-populated block is a mapping
 * bug, not a market shape.
 *
 * On V3 they all come from `reserve.borrowInfo` in
 * `packages/aave-fetcher/src/concurrent-fetch.ts`. On V4 they are assembled
 * from two independent sources: the per-spoke summary (`borrowApy`, `borrowed`)
 * and the hub summary/settings (`liquidity`, `utilizationPct`, the slopes,
 * `optimalUtilization`, `borrowCap`). The all-or-nothing rule still applies to
 * both, but on V4 a partial block can also mean one of the two sources came
 * back empty.
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

/**
 * How many reserves are allowed to have no borrow side at all.
 *
 * Measured on the 2026-11-15 staging snapshot: 19 of 441 (14 on Ethereum plus
 * one each on Arbitrum / Avalanche / Linea / Optimism / Polygon), all V3, all
 * with `borrowInfo: null` on the SDK side. Raising this number means a reserve
 * that used to have a borrow side lost it — confirm with the protocol state
 * before touching it, because that is exactly the data gap this guards against.
 * A lower number is fine: the block came back.
 */
const KNOWN_BORROW_SIDE_ABSENT = 19;

interface MarketsResponse {
  snapshot: { version: string };
  reserves: Array<Record<string, unknown>>;
}

const API_URL =
  process.env.API_FIELDS_TEST_URL ??
  "https://staging-api.aaveapy.com/api/markets";

let snapshot: MarketsResponse | null | undefined;

/**
 * One fetch per run, shared by every assertion: independent requests can land
 * on different snapshots (reserves are added and removed between them), and a
 * staging hiccup on one of them used to fail only the assertions after it.
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

/** `in` alone would count an explicit `null` as present. */
function present(reserve: Record<string, unknown>, field: string): boolean {
  const value = reserve[field];
  return value !== undefined && value !== null;
}

function reserveLabel(reserve: Record<string, unknown>): string {
  return String(reserve.reserveId ?? "<no reserveId>");
}

function hasBorrowSide(reserve: Record<string, unknown>): boolean {
  return BORROW_SIDE.some((field) => present(reserve, field));
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
  "API fields v3 — always-present fields are on every reserve",
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
        if (!present(reserve, field)) {
          missing.push(`${reserveLabel(reserve)}:${field}`);
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      `${missing.length} missing field(s) out of ${data.reserves.length} reserves: ${missing.slice(0, 10).join(", ")}. Note baseBorrowRate is filled by an on-chain fallback — check RPC coverage before the serialiser.`
    );
  }
);

/**
 * AAV-1380: 312 of 441 reserves ship `ltv: 0`. That is a real protocol value
 * (governance LTV-0 on stablecoins, non-collateral assets, and V3.6 freeze),
 * not the field-mapping defect the ticket suspected — chain state matched the
 * API on 103/103 reserves. The count is governance-dependent, so nothing here
 * pins it. What must hold forever is the relation between the two slots read
 * from the same reserve config: borrow power can never exceed the liquidation
 * threshold, and on V4 a single `collateralFactor` fills both. A mis-sourced
 * field breaks these long before someone notices borrow capacity is wrong.
 */
test(
  "API fields v3 — ltv never exceeds liquidationThreshold on any reserve",
  { skip: !process.env.RUN_API_FIELDS_TESTS },
  () => {
    const data = markets();
    if (!data) {
      assert.fail(`Could not fetch API at ${API_URL}`);
    }

    const violations: string[] = [];
    for (const reserve of data.reserves) {
      const ltv = reserve.ltv;
      const liquidationThreshold = reserve.liquidationThreshold;
      // Absence is the ALWAYS_PRESENT assertion's job; only compare numbers.
      if (typeof ltv !== "number" || typeof liquidationThreshold !== "number") {
        continue;
      }
      if (ltv > liquidationThreshold) {
        violations.push(
          `${reserveLabel(reserve)}: ltv ${ltv} > liquidationThreshold ${liquidationThreshold}`
        );
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Borrow power above liquidation threshold on ${violations.length} reserve(s): ${violations.slice(0, 10).join(", ")}`
    );
  }
);

test(
  "API fields v3 — V4 fills ltv and liquidationThreshold from one collateralFactor",
  { skip: !process.env.RUN_API_FIELDS_TESTS },
  () => {
    const data = markets();
    if (!data) {
      assert.fail(`Could not fetch API at ${API_URL}`);
    }

    const v4 = data.reserves.filter((reserve) =>
      String(reserve.marketName ?? "").startsWith("AaveV4")
    );
    assert.ok(v4.length > 0, "No V4 reserves in response — nothing checked");

    const mismatched: string[] = [];
    for (const reserve of v4) {
      const ltv = reserve.ltv;
      const liquidationThreshold = reserve.liquidationThreshold;
      if (typeof ltv !== "number" || typeof liquidationThreshold !== "number") {
        continue;
      }
      if (ltv !== liquidationThreshold) {
        mismatched.push(
          `${reserveLabel(reserve)}: ltv ${ltv} !== liquidationThreshold ${liquidationThreshold}`
        );
      }
    }

    assert.deepEqual(
      mismatched,
      [],
      `V4 merges both risk parameters into one collateralFactor; ${mismatched.length} of ${v4.length} V4 reserves disagree: ${mismatched.slice(0, 10).join(", ")}`
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
      const presentFields = BORROW_SIDE.filter((field) =>
        present(reserve, field)
      );
      if (
        presentFields.length === 0 ||
        presentFields.length === BORROW_SIDE.length
      ) {
        continue;
      }
      const absent = BORROW_SIDE.filter((field) => !present(reserve, field));
      partial.push(
        `${reserveLabel(reserve)} has ${presentFields.length}/${BORROW_SIDE.length}, missing [${absent.join(", ")}]`
      );
    }

    assert.deepEqual(
      partial,
      [],
      `Borrow side is partially populated on ${partial.length} reserve(s); the block must be emitted whole or not at all: ${partial.slice(0, 10).join("; ")}`
    );
  }
);

test(
  "API fields v3 — no new reserve silently loses its borrow side",
  { skip: !process.env.RUN_API_FIELDS_TESTS },
  () => {
    const data = markets();
    if (!data) {
      assert.fail(`Could not fetch API at ${API_URL}`);
    }

    // Deliberately not filtering on `borrowDisabled`: on V3 that flag is derived
    // from `borrowInfo === null` (concurrent-fetch.ts), so using it to explain a
    // missing block would just restate the observation. 124 of the 441 staging
    // reserves have a complete borrow side *and* `borrowDisabled: true`, so the
    // flag cannot tell the two situations apart either. Count them instead.
    const absent = data.reserves.filter((reserve) => !hasBorrowSide(reserve));

    assert.ok(
      absent.length <= KNOWN_BORROW_SIDE_ABSENT,
      `${absent.length} reserve(s) have no borrow side, up from the recorded ${KNOWN_BORROW_SIDE_ABSENT}. Either the protocol disabled borrowing on a new market — then raise the baseline — or the fetcher dropped a block that used to be there: ${absent
        .slice(0, 10)
        .map(reserveLabel)
        .join(", ")}`
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
      if (!present(reserve, ABSENT_MEANS_ZERO)) continue;
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

test("API fields v3 — this file does not spell a version literal", () => {
  // A literal survives renames: the old assertion kept spelling the previous
  // name and stayed red for as long as nobody ran it. Any quoted slug-vN token
  // fails here, so reading MARKETS_API_VERSION is the only way to name the
  // version. Scope is this file only — marketsVersionBump.test.ts pins the
  // literal on purpose, so a bump has to touch it.
  const source = readFileSync(fileURLToPath(import.meta.url), "utf-8");
  const hardcodedVersion = /["'`][a-z][a-z-]*-v\d+["'`]/;

  assert.ok(
    !hardcodedVersion.test(source),
    "apiFieldsVerification.test.ts must read MARKETS_API_VERSION instead of spelling a version literal"
  );
});
