import type {
  EModeIndexPayload,
  EModeMarketData,
  EModeMarketSummary,
  MarketsPayload,
} from "@internal/aave-shared-contracts";
import { v3MarketKey } from "@internal/aave-shared-contracts";

const MARKET_KEY_RE = /^(\d+):(0x[0-9a-fA-F]{40})$/i;

export interface EModeSource {
  payload: MarketsPayload | null;
}

export type EModeSourceReader = () => EModeSource;

/**
 * Parse a `chainId:poolAddress` market key. Returns the canonical lowercase
 * key, or null when the input is not a valid V3 market key.
 */
export function parseEModeMarketKey(raw: string): string | null {
  const match = MARKET_KEY_RE.exec(raw.trim());
  if (!match) return null;
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return v3MarketKey(chainId, match[2]);
}

export function buildEModeIndex(payload: MarketsPayload): EModeIndexPayload {
  const markets: EModeMarketSummary[] = (payload.eModeMarkets ?? [])
    .map((market) => ({
      marketKey: market.marketKey,
      chainId: market.chainId,
      chainName: market.chainName,
      marketName: market.marketName,
      categoryCount: market.categories.length,
    }))
    .sort(
      (a, b) => a.chainId - b.chainId || a.marketKey.localeCompare(b.marketKey)
    );

  return {
    generatedAt: payload._metadata.timestamp,
    markets,
  };
}

export function findEModeMarket(
  payload: MarketsPayload,
  canonicalKey: string
): EModeMarketData | undefined {
  return payload.eModeMarkets?.find(
    (market) => market.marketKey === canonicalKey
  );
}
