import type {
  EModeCategoryData,
  EModeMarketData,
} from "@internal/aave-shared-contracts";
import { normalizeAddress, v3MarketKey } from "@internal/aave-shared-contracts";
import { percentValueToPercent } from "./utils/number.js";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * Map the SDK `markets` response into the compact eMode payload (AAV-1394).
 *
 * The Aave GraphQL `Market` fragment already requests `eModeCategories`; this
 * function only reshapes data that the fetcher has already fetched. It performs
 * no network or on-chain reads.
 *
 * Invalid markets/categories are skipped rather than throwing: one malformed
 * row must not drop the whole snapshot. Duplicate market keys keep the first
 * occurrence, matching the "don't let a duplicate SDK row overwrite real data"
 * intent.
 */
export function buildEModeMarkets(markets: unknown[]): EModeMarketData[] {
  const byKey = new Map<string, EModeMarketData>();

  for (const rawMarket of markets) {
    if (!rawMarket || typeof rawMarket !== "object") continue;
    const market = rawMarket as Record<string, any>;

    const chainId = Number(market.chain?.chainId);
    const poolAddress =
      typeof market.address === "string"
        ? normalizeAddress(market.address)
        : "";
    if (!Number.isSafeInteger(chainId) || chainId <= 0) continue;
    if (!ADDRESS_RE.test(poolAddress)) continue;

    const marketKey = v3MarketKey(chainId, poolAddress);
    if (byKey.has(marketKey)) continue;

    const categories = buildCategories(market.eModeCategories);
    byKey.set(marketKey, {
      marketKey,
      chainId,
      chainName:
        typeof market.chain?.name === "string" ? market.chain.name : "",
      marketName: typeof market.name === "string" ? market.name : "",
      categories,
    });
  }

  return [...byKey.values()].sort(
    (a, b) => a.chainId - b.chainId || a.marketKey.localeCompare(b.marketKey)
  );
}

/**
 * Choose the value the refresh may publish as fresh eMode data.
 *
 * `undefined` means "do not replace the stale cache":
 * - the bulk V3 query returned no markets (soft failure), or
 * - markets came back but every one failed validation.
 *
 * A parsed market with zero categories is still a real result, so it returns
 * `[{ categories: [] }]` rather than `undefined`.
 */
export function selectFreshEModeMarkets(
  markets: unknown[]
): EModeMarketData[] | undefined {
  if (markets.length === 0) return undefined;
  const built = buildEModeMarkets(markets);
  return built.length > 0 ? built : undefined;
}

function buildCategories(rawCategories: unknown): EModeCategoryData[] {
  if (!Array.isArray(rawCategories)) return [];

  const categories: EModeCategoryData[] = [];
  for (const rawCategory of rawCategories) {
    if (!rawCategory || typeof rawCategory !== "object") continue;
    const category = rawCategory as Record<string, any>;

    const id = Number(category.id);
    if (!Number.isSafeInteger(id) || id < 0) continue;
    if (typeof category.label !== "string" || category.label.trim() === "") {
      continue;
    }

    const maxLtv = percentValueToPercent(category.maxLTV);
    const liquidationThreshold = percentValueToPercent(
      category.liquidationThreshold
    );
    const liquidationPenalty = percentValueToPercent(
      category.liquidationPenalty
    );
    if (
      maxLtv === undefined ||
      liquidationThreshold === undefined ||
      liquidationPenalty === undefined
    ) {
      continue;
    }

    const collateral = new Set<string>();
    const borrowable = new Set<string>();
    for (const rawReserve of Array.isArray(category.reserves)
      ? category.reserves
      : []) {
      if (!rawReserve || typeof rawReserve !== "object") continue;
      const reserve = rawReserve as Record<string, any>;
      const address =
        typeof reserve.underlyingToken?.address === "string"
          ? normalizeAddress(reserve.underlyingToken.address)
          : "";
      if (!ADDRESS_RE.test(address)) continue;

      if (reserve.canBeCollateral === true) collateral.add(address);
      if (reserve.canBeBorrowed === true) borrowable.add(address);
    }

    categories.push({
      id,
      label: category.label,
      maxLtv,
      liquidationThreshold,
      liquidationPenalty,
      collateralReserves: [...collateral].sort(),
      borrowableReserves: [...borrowable].sort(),
    });
  }

  return categories.sort((a, b) => a.id - b.id);
}
