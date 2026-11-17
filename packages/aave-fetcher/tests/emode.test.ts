import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEModeMarkets } from "../src/emode.js";

const POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const WETH = "0xC02aaa39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";

function percent(value: string) {
  return { value, raw: "0", decimals: 2, formatted: value };
}

function market(overrides: Record<string, unknown> = {}) {
  return {
    address: POOL,
    name: "AaveV3Ethereum",
    chain: { chainId: 1, name: "Ethereum" },
    eModeCategories: [
      {
        id: 2,
        label: "Stablecoins",
        maxLTV: percent("0.93"),
        liquidationThreshold: percent("0.95"),
        liquidationPenalty: percent("0.01"),
        reserves: [
          {
            underlyingToken: { address: USDC },
            canBeCollateral: false,
            canBeBorrowed: false,
          },
          {
            underlyingToken: { address: DAI },
            canBeCollateral: true,
            canBeBorrowed: false,
          },
        ],
      },
      {
        id: 1,
        label: "ETH correlated",
        maxLTV: percent("0.93"),
        liquidationThreshold: percent("0.95"),
        liquidationPenalty: percent("0.01"),
        reserves: [
          {
            underlyingToken: { address: WETH },
            canBeCollateral: true,
            canBeBorrowed: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("AAV-1394 buildEModeMarkets", () => {
  it("maps categories in id order, converts PercentValue to percent, prunes non-members and lowercases addresses", () => {
    const result = buildEModeMarkets([market()]);

    assert.equal(result.length, 1);
    const entry = result[0];
    assert.equal(entry.marketKey, `1:${POOL.toLowerCase()}`);
    assert.equal(entry.marketName, "AaveV3Ethereum");
    assert.equal(entry.chainName, "Ethereum");
    assert.deepEqual(
      entry.categories.map((c) => c.id),
      [1, 2]
    );

    const eth = entry.categories[0];
    assert.equal(eth.label, "ETH correlated");
    assert.equal(eth.maxLtv, 93);
    assert.equal(eth.liquidationThreshold, 95);
    assert.equal(eth.liquidationPenalty, 1);
    assert.deepEqual(eth.collateralReserves, [WETH.toLowerCase()]);
    assert.deepEqual(eth.borrowableReserves, [WETH.toLowerCase()]);

    const stables = entry.categories[1];
    assert.deepEqual(stables.collateralReserves, [DAI]);
    assert.deepEqual(stables.borrowableReserves, []);
  });

  it("drops a category whose maximum LTV / threshold / penalty cannot be parsed", () => {
    const invalid = {
      id: 3,
      label: "Broken",
      maxLTV: undefined,
      liquidationThreshold: percent("0.9"),
      liquidationPenalty: percent("0.01"),
      reserves: [],
    };
    const result = buildEModeMarkets([
      market({ eModeCategories: [invalid, ...market().eModeCategories] }),
    ]);

    assert.deepEqual(
      result[0].categories.map((c) => c.id),
      [1, 2]
    );
  });

  it("keeps only the first market when the SDK returns a duplicate market key", () => {
    const duplicate = market({
      name: "Duplicate",
      eModeCategories: [],
    });
    const result = buildEModeMarkets([market(), duplicate]);

    assert.equal(result.length, 1);
    assert.equal(result[0].marketName, "AaveV3Ethereum");
  });

  it("skips markets without a valid pool address or chain id", () => {
    const result = buildEModeMarkets([
      market({ address: "not-an-address" }),
      market({ chain: { chainId: 0, name: "Ethereum" } }),
      market(),
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0].marketKey, `1:${POOL.toLowerCase()}`);
  });

  it("returns an empty array for empty input and non-array categories", () => {
    assert.deepEqual(buildEModeMarkets([]), []);
    assert.deepEqual(buildEModeMarkets([market({ eModeCategories: null })]), [
      {
        marketKey: `1:${POOL.toLowerCase()}`,
        chainId: 1,
        chainName: "Ethereum",
        marketName: "AaveV3Ethereum",
        categories: [],
      },
    ]);
  });
});
