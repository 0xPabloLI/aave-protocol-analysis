import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIDE_DATA_ETAG_OMIT_PATHS,
  canonicalJson,
  computeSideDataETag,
  computeWeakETag,
} from "../src/services/sideDataEtag.js";

type SideData = {
  generatedAt: string;
  categories?: {
    uniqueSymbolsStablecoins: string[];
    uniqueSymbolsEth: string[];
    fetchedAt: string;
    staleTimeMs: number;
  };
  fdv?: {
    items: Array<{ symbol: string | null; fdvUsd: number | null }>;
    fetchedAt: string;
    staleTimeMs: number;
  };
  campaignAccess?: {
    campaigns: Record<string, { chainId: number; whitelist: string[] }>;
    updatedAt: string;
  };
};

function payload(overrides: Partial<SideData> = {}): SideData {
  return {
    generatedAt: "2026-11-17T14:00:00.000Z",
    categories: {
      uniqueSymbolsStablecoins: ["USDC", "USDT"],
      uniqueSymbolsEth: ["ETH", "WETH"],
      fetchedAt: "2026-11-17T12:00:00.000Z",
      staleTimeMs: 21_600_000,
    },
    fdv: {
      items: [
        { symbol: "AAVE", fdvUsd: 3_000_000_000 },
        { symbol: "UNI", fdvUsd: 6_000_000_000 },
      ],
      fetchedAt: "2026-11-17T13:50:00.000Z",
      staleTimeMs: 900_000,
    },
    campaignAccess: {
      campaigns: { "1001": { chainId: 1, whitelist: ["0xabc"] } },
      updatedAt: "2026-11-17T13:59:00.000Z",
    },
    ...overrides,
  };
}

const ETAG_RE = /^W\/"[0-9a-f]{32}"$/;

describe("AAV-365 canonical JSON", () => {
  it("S12 sorts object keys so insertion order cannot change the hash", () => {
    const a = { z: 1, a: { y: 2, b: 3 } };
    const b = { a: { b: 3, y: 2 }, z: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(computeWeakETag(a), computeWeakETag(b));
  });

  it("S13 keeps array order significant", () => {
    assert.notEqual(
      computeWeakETag({ items: ["USDC", "USDT"] }),
      computeWeakETag({ items: ["USDT", "USDC"] })
    );
  });

  it("omits undefined object keys like JSON.stringify does, and renders undefined array slots as null", () => {
    const withUndefined = { a: undefined, b: 1 };
    const explicit = { b: 1 };
    assert.equal(canonicalJson(withUndefined), canonicalJson(explicit));
    assert.equal(
      canonicalJson({ list: [1, undefined, 3] }),
      '{"list":[1,null,3]}'
    );
  });

  it("distinguishes null from missing", () => {
    assert.notEqual(canonicalJson({ a: null }), canonicalJson({}));
  });

  it("throws on bigint rather than inventing an encoding JSON cannot carry", () => {
    assert.throws(() => canonicalJson({ a: BigInt(1) }), TypeError);
  });
});

describe("AAV-365 deterministic side-data ETag", () => {
  it("S1 emits a weak 128-bit tag", () => {
    assert.match(computeSideDataETag(payload()), ETAG_RE);
  });

  it("S2 generatedAt churn alone does not change the tag", () => {
    const first = computeSideDataETag(payload());
    const second = computeSideDataETag(
      payload({ generatedAt: "2026-11-17T14:00:05.000Z" })
    );
    assert.equal(first, second);
  });

  it("S8 campaignAccess.updatedAt churn alone does not change the tag", () => {
    const first = computeSideDataETag(payload());
    const second = computeSideDataETag(
      payload({
        campaignAccess: {
          campaigns: { "1001": { chainId: 1, whitelist: ["0xabc"] } },
          updatedAt: "2026-11-17T14:05:00.000Z",
        },
      })
    );
    assert.equal(first, second);
  });

  it("S7 changes to any content block change the tag", () => {
    const base = computeSideDataETag(payload());
    assert.notEqual(
      base,
      computeSideDataETag(
        payload({
          fdv: {
            items: [
              { symbol: "AAVE", fdvUsd: 3_000_000_001 },
              { symbol: "UNI", fdvUsd: 6_000_000_000 },
            ],
            fetchedAt: "2026-11-17T13:50:00.000Z",
            staleTimeMs: 900_000,
          },
        })
      )
    );
    assert.notEqual(
      base,
      computeSideDataETag(
        payload({
          categories: {
            uniqueSymbolsStablecoins: ["USDC"],
            uniqueSymbolsEth: ["ETH", "WETH"],
            fetchedAt: "2026-11-17T12:00:00.000Z",
            staleTimeMs: 21_600_000,
          },
        })
      )
    );
    assert.notEqual(
      base,
      computeSideDataETag(
        payload({
          campaignAccess: {
            campaigns: { "1001": { chainId: 1, whitelist: ["0xdef"] } },
            updatedAt: "2026-11-17T13:59:00.000Z",
          },
        })
      )
    );
  });

  it("S7b a real refetch (fetchedAt) still invalidates the tag even when values match", () => {
    const base = computeSideDataETag(payload());
    assert.notEqual(
      base,
      computeSideDataETag(
        payload({
          fdv: {
            items: [
              { symbol: "AAVE", fdvUsd: 3_000_000_000 },
              { symbol: "UNI", fdvUsd: 6_000_000_000 },
            ],
            fetchedAt: "2026-11-17T14:05:00.000Z",
            staleTimeMs: 900_000,
          },
        })
      )
    );
  });

  it("S11 computes a stable tag when optional blocks are absent", () => {
    const minimal = { generatedAt: "2026-11-17T14:00:00.000Z" };
    assert.match(computeSideDataETag(minimal), ETAG_RE);
    assert.equal(
      computeSideDataETag(minimal),
      computeSideDataETag({ generatedAt: "2026-11-17T14:00:07.000Z" })
    );
  });

  it("pins the omit list — freshness markers only, no data fields", () => {
    assert.deepEqual(
      [...SIDE_DATA_ETAG_OMIT_PATHS],
      ["generatedAt", "campaignAccess.updatedAt"]
    );
  });

  it("omits nested paths without touching sibling keys", () => {
    const a = { keep: { keep: 1, drop: "x" }, drop: "y" };
    const b = { keep: { keep: 1, drop: "z" }, drop: "w" };
    assert.equal(
      computeWeakETag(a, { omitPaths: ["drop", "keep.drop"] }),
      computeWeakETag(b, { omitPaths: ["drop", "keep.drop"] })
    );
  });

  it("S14 is reproducible across processes", () => {
    const here = computeSideDataETag(payload());
    const modulePath = fileURLToPath(
      new URL("../src/services/sideDataEtag.ts", import.meta.url)
    );
    const dir = mkdtempSync(join(tmpdir(), "aav365-etag-"));
    const script = join(dir, "recompute.mjs");
    writeFileSync(
      script,
      `import { computeSideDataETag } from ${JSON.stringify(`file://${modulePath}`)};\n` +
        `process.stdout.write(computeSideDataETag(${JSON.stringify(payload())}));\n`,
      "utf8"
    );
    try {
      const stdout = execFileSync(process.execPath, ["--no-warnings", script], {
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(stdout.trim(), here);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
