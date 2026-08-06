import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectCrossAssetPairing,
  type ComposedSubCampaign,
  type MerklOpportunityData,
} from "../src/merkl-api.js";

// Use lowercase addresses consistently — resolveOffsetReserveIds lowercases token addresses
// and constructs candidates as `${prefix}:${normalizedAddr}`, so reserve IDs must match.
const POOL_ADDR = "0xa736a6319d4ba1e2b0ebc4c4c4c4c4c4c4c4c4c4";
const CBETH_ADDR = "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22";
const WETH_ADDR = "0x4200000000000000000000000000000000000006";
const V3_RESERVE_ID_CBETH = `8453:${POOL_ADDR}:${CBETH_ADDR}`;
const V3_RESERVE_ID_WETH = `8453:${POOL_ADDR}:${WETH_ADDR}`;
const RESERVE_SET = new Set([V3_RESERVE_ID_CBETH, V3_RESERVE_ID_WETH]);

const EXPLORER_ADDR = "0x24e6e0795b3c7c71d965fcc4f371803d1c1dca1e";

function makeOpp(
  overrides: Partial<MerklOpportunityData> = {}
): MerklOpportunityData {
  return {
    supply: [],
    borrow: [],
    hold: [],
    marketName: "Base",
    chainId: 8453,
    protocolVersion: "v3",
    opportunityType: "MULTILOG_DUTCH",
    composedCampaignsCompute: "min(1,2)",
    explorerAddress: EXPLORER_ADDR,
    ...overrides,
  };
}

function makeCbEthSubs(): ComposedSubCampaign[] {
  return [
    {
      underlyingToken: CBETH_ADDR,
      campaignType: 60,
      composedType: "MAIN",
      mainParameter: "0xcf3d55c10db69f28fd1a75bd73f3d8a2d9c595ad",
      symbolTargetToken: "aBascbETH",
      composedMultiplier: 0.823,
      composedIndex: 1,
    },
    {
      underlyingToken: WETH_ADDR,
      campaignType: 61,
      composedType: "DEFAULT",
      mainParameter: EXPLORER_ADDR,
      symbolTargetToken: "variableDebtBasWETH",
      composedMultiplier: 1.0,
      composedIndex: 2,
    },
  ];
}

describe("detectCrossAssetPairing", () => {
  it("S1: cbETH/ETH — borrow opp, paired=cbETH supply, discount=0.823", () => {
    const opp = makeOpp({
      borrow: [
        { campaignApr: 0.4095, campaignStartedAt: "", campaignEndedAt: "" },
      ],
      composedSubCampaigns: makeCbEthSubs(),
    });
    const result = detectCrossAssetPairing(
      opp,
      V3_RESERVE_ID_WETH,
      RESERVE_SET
    );
    assert.ok(result, "should return a crossAssetPairing");
    assert.strictEqual(result!.sourceSide, "borrow");
    assert.strictEqual(result!.pairedSide, "supply");
    assert.strictEqual(result!.pairedReserveId, V3_RESERVE_ID_CBETH);
    assert.strictEqual(result!.discountFactor, 0.823);
  });

  it("S7: pairedReserveId resolve fails → return null", () => {
    const opp = makeOpp({
      borrow: [
        { campaignApr: 0.4095, campaignStartedAt: "", campaignEndedAt: "" },
      ],
      composedSubCampaigns: makeCbEthSubs(),
    });
    const emptySet = new Set<string>([V3_RESERVE_ID_WETH]);
    const result = detectCrossAssetPairing(opp, V3_RESERVE_ID_WETH, emptySet);
    assert.strictEqual(result, null);
  });

  it("S8: composedMultiplier = 0 → discountFactor = 0", () => {
    const subs = makeCbEthSubs();
    subs[0].composedMultiplier = 0;
    const opp = makeOpp({
      borrow: [
        { campaignApr: 0.4095, campaignStartedAt: "", campaignEndedAt: "" },
      ],
      composedSubCampaigns: subs,
    });
    const result = detectCrossAssetPairing(
      opp,
      V3_RESERVE_ID_WETH,
      RESERVE_SET
    );
    assert.ok(result);
    assert.strictEqual(result!.discountFactor, 0);
  });

  it("S9: composedMultiplier undefined → return null", () => {
    const subs = makeCbEthSubs();
    delete subs[0].composedMultiplier;
    const opp = makeOpp({
      borrow: [
        { campaignApr: 0.4095, campaignStartedAt: "", campaignEndedAt: "" },
      ],
      composedSubCampaigns: subs,
    });
    const result = detectCrossAssetPairing(
      opp,
      V3_RESERVE_ID_WETH,
      RESERVE_SET
    );
    assert.strictEqual(result, null);
  });

  it("S10: composedCampaignsCompute not min(1,2) → return null", () => {
    const opp = makeOpp({
      composedCampaignsCompute: "1-2",
      composedSubCampaigns: makeCbEthSubs(),
    });
    const result = detectCrossAssetPairing(
      opp,
      V3_RESERVE_ID_WETH,
      RESERVE_SET
    );
    assert.strictEqual(result, null);
  });

  it("S11: min(1,2) but same underlyingToken → return null (same-asset, not cross-asset)", () => {
    const subs: ComposedSubCampaign[] = [
      {
        underlyingToken: "0xabc",
        mainParameter: "0xdef",
        composedMultiplier: 1.0,
        composedIndex: 1,
      },
      {
        underlyingToken: "0xabc",
        mainParameter: EXPLORER_ADDR,
        composedMultiplier: 1.0,
        composedIndex: 2,
      },
    ];
    const opp = makeOpp({
      composedSubCampaigns: subs,
    });
    const result = detectCrossAssetPairing(
      opp,
      V3_RESERVE_ID_WETH,
      RESERVE_SET
    );
    assert.strictEqual(result, null);
  });

  it("S13: looping keyword + min(1,2) → still returns crossAssetPairing", () => {
    const SUSDE_ADDR = "0xsusde";
    const USDE_ADDR = "0xusde";
    const sUSDeReserveId = `9745:${POOL_ADDR}:${SUSDE_ADDR}`;
    const usDeReserveId = `9745:${POOL_ADDR}:${USDE_ADDR}`;
    const plasmaSet = new Set([sUSDeReserveId, usDeReserveId]);
    const explorerAddr = "0xusde_atoken";

    const opp = makeOpp({
      chainId: 9745,
      supply: [
        { campaignApr: 0.0375, campaignStartedAt: "", campaignEndedAt: "" },
      ],
      borrow: [],
      explorerAddress: explorerAddr,
      name: "Lend sUSDe and USDe on Aave (looping required)",
      description: "looping required",
      composedSubCampaigns: [
        {
          underlyingToken: SUSDE_ADDR,
          campaignType: 61,
          composedType: "DEFAULT",
          mainParameter: "0xsusde_atoken",
          symbolTargetToken: "aPlasUSDe",
          composedMultiplier: 1.196,
          composedIndex: 1,
        },
        {
          underlyingToken: USDE_ADDR,
          campaignType: 60,
          composedType: "MAIN",
          mainParameter: explorerAddr,
          symbolTargetToken: "aPlaUSDe",
          composedMultiplier: 1.0,
          composedIndex: 2,
        },
      ],
    });
    const result = detectCrossAssetPairing(opp, usDeReserveId, plasmaSet);
    assert.ok(
      result,
      "looping + min(1,2) should still return crossAssetPairing"
    );
    assert.strictEqual(result!.sourceSide, "supply");
    assert.strictEqual(result!.pairedSide, "supply");
    assert.strictEqual(result!.discountFactor, 1.196);
  });

  it("S5: sUSDe/USDe — both supply side, sourceSide=supply, pairedSide=supply", () => {
    const SUSDE_ADDR = "0xsusde";
    const USDE_ADDR = "0xusde";
    const sUSDeReserveId = `9745:${POOL_ADDR}:${SUSDE_ADDR}`;
    const usDeReserveId = `9745:${POOL_ADDR}:${USDE_ADDR}`;
    const plasmaSet = new Set([sUSDeReserveId, usDeReserveId]);
    const explorerAddr = "0xusde_atoken";

    const opp = makeOpp({
      chainId: 9745,
      supply: [
        { campaignApr: 0.0375, campaignStartedAt: "", campaignEndedAt: "" },
      ],
      borrow: [],
      explorerAddress: explorerAddr,
      composedSubCampaigns: [
        {
          underlyingToken: SUSDE_ADDR,
          campaignType: 61,
          composedType: "DEFAULT",
          mainParameter: "0xsusde_atoken",
          symbolTargetToken: "aPlasUSDe",
          composedMultiplier: 1.196,
          composedIndex: 1,
        },
        {
          underlyingToken: USDE_ADDR,
          campaignType: 60,
          composedType: "MAIN",
          mainParameter: explorerAddr,
          symbolTargetToken: "aPlaUSDe",
          composedMultiplier: 1.0,
          composedIndex: 2,
        },
      ],
    });
    const result = detectCrossAssetPairing(opp, usDeReserveId, plasmaSet);
    assert.ok(result);
    assert.strictEqual(result!.sourceSide, "supply");
    assert.strictEqual(result!.pairedSide, "supply");
    assert.strictEqual(result!.discountFactor, 1.196);
  });
});
