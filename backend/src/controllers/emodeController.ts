import type { Request, Response } from "express";
import { getMarketsData } from "../services/marketsService.js";
import {
  buildEModeIndex,
  findEModeMarket,
  parseEModeMarketKey,
  type EModeSourceReader,
} from "../services/emodeApi.js";
import type { EModeMarketPayload } from "@internal/aave-shared-contracts";

/**
 * GET /api/meta/e-mode and GET /api/meta/e-mode/:marketKey.
 *
 * Read-only over the markets snapshot: the fetcher writes `eModeMarkets`
 * during its cron cycle (AAV-1394). No GraphQL/RPC call happens here.
 */
export function createEModeMetaHandler(
  getSource: EModeSourceReader = getMarketsData
) {
  return (req: Request, res: Response): void => {
    const { payload } = getSource();

    if (!payload) {
      res.set("Retry-After", "10");
      res.status(503).json({
        errorCode: "EMODE_SNAPSHOT_NOT_READY",
        error: "Service unavailable",
        message: "Markets data is still loading. Please retry shortly.",
      });
      return;
    }

    // `[]` is a valid snapshot (V3 succeeded, no categories); `undefined` means
    // the V3 side has not produced eMode data yet.
    if (payload.eModeMarkets === undefined) {
      res.set("Retry-After", "15");
      res.status(503).json({
        errorCode: "EMODE_DATA_UNAVAILABLE",
        error: "Service unavailable",
        message: "eMode data is not available yet. Please retry shortly.",
      });
      return;
    }

    const rawKey = req.params.marketKey;
    if (rawKey === undefined) {
      res.status(200).json(buildEModeIndex(payload));
      return;
    }

    const canonicalKey = parseEModeMarketKey(String(rawKey));
    if (!canonicalKey) {
      res.status(400).json({
        errorCode: "EMODE_INVALID_MARKET_KEY",
        error: "Bad request",
        message: "marketKey must be `chainId:poolAddress` (0x + 40 hex chars).",
      });
      return;
    }

    const market = findEModeMarket(payload, canonicalKey);
    if (!market) {
      res.status(404).json({
        errorCode: "EMODE_MARKET_NOT_FOUND",
        error: "Not found",
        message: `No eMode data for market ${canonicalKey}.`,
      });
      return;
    }

    const response: EModeMarketPayload = {
      generatedAt: payload._metadata.timestamp,
      ...market,
    };
    res.status(200).json(response);
  };
}
