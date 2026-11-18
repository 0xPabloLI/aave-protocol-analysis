import type { Request, Response } from "express";
import { logger } from "../logger.js";
import {
  getCoingeckoCategoriesSnapshot,
  getCoingeckoFdvSnapshot,
} from "./coingeckoController.js";
import { getForecastSnapshot } from "./merklForecastController.js";
import type {
  SideDataPayload,
  SideDataSubSourceErrors,
} from "@internal/aave-shared-contracts";
import { getCampaignAccessSnapshot } from "../services/merklCampaignAccessService.js";
import { computeSideDataETag } from "../services/sideDataEtag.js";

/**
 * Snapshot readers for `/api/meta/side-data`. Injectable so route tests can
 * exercise the full controller (including the conditional-request path) without
 * warming real CoinGecko/Merkl caches.
 */
export interface SideDataMetaDeps {
  getCategories?: typeof getCoingeckoCategoriesSnapshot;
  getFdv?: typeof getCoingeckoFdvSnapshot;
  getForecast?: typeof getForecastSnapshot;
  getCampaignAccess?: typeof getCampaignAccessSnapshot;
  /** Request clock; overridable in tests so `generatedAt` churn is deterministic. */
  now?: () => Date;
}

export function createSideDataMetaHandler(deps: SideDataMetaDeps = {}) {
  const {
    getCategories = getCoingeckoCategoriesSnapshot,
    getFdv = getCoingeckoFdvSnapshot,
    getForecast = getForecastSnapshot,
    getCampaignAccess = getCampaignAccessSnapshot,
    now = () => new Date(),
  } = deps;

  return async (_req: Request, res: Response) => {
    const [categoriesResult, fdvResult, forecastResult] =
      await Promise.allSettled([
        getCategories("meta"),
        getFdv("meta"),
        getForecast(),
      ]);

    const errors: SideDataSubSourceErrors = {};
    const payload: SideDataPayload = { generatedAt: now().toISOString() };

    if (categoriesResult.status === "fulfilled") {
      const { data, fetchedAt, staleTimeMs } = categoriesResult.value;
      payload.categories = { ...data, fetchedAt, staleTimeMs };
    } else {
      errors.categories = String(
        categoriesResult.reason instanceof Error
          ? categoriesResult.reason.message
          : categoriesResult.reason
      );
    }

    if (fdvResult.status === "fulfilled") {
      const { data, staleTimeMs } = fdvResult.value;
      payload.fdv = { ...data, staleTimeMs };
    } else {
      errors.fdv = String(
        fdvResult.reason instanceof Error
          ? fdvResult.reason.message
          : fdvResult.reason
      );
    }

    if (forecastResult.status === "fulfilled") {
      payload.forecast = forecastResult.value;
    } else {
      errors.forecast = String(
        forecastResult.reason instanceof Error
          ? forecastResult.reason.message
          : forecastResult.reason
      );
    }

    const campaignAccessSnapshot = getCampaignAccess();
    if (campaignAccessSnapshot) {
      payload.campaignAccess = campaignAccessSnapshot;
    }

    if (Object.keys(errors).length > 0) payload.errors = errors;

    const successCount = [
      payload.categories,
      payload.fdv,
      payload.forecast,
      payload.campaignAccess,
    ].filter(Boolean).length;
    if (successCount === 0) {
      logger.error("Side-data meta failed: all sources unavailable");
      // Never let a failure look cacheable: the route-level Cache-Control is a
      // public 60s policy, which would let a 5xx body be stored and later
      // answered with a 304 (Express compares If-None-Match regardless of
      // status). The error path carries no content-derived tag either.
      res.set("Cache-Control", "no-store");
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to load side-data meta",
        ...payload,
      });
      return;
    }

    // AAV-365 — content-derived tag; Express answers `If-None-Match` with 304
    // from this header.
    res.set("ETag", computeSideDataETag(payload));
    res.status(200).json(payload);
  };
}
