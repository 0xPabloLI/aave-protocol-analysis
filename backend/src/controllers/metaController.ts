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

export const getSideDataMeta = async (_req: Request, res: Response) => {
  const [categoriesResult, fdvResult, forecastResult] =
    await Promise.allSettled([
      getCoingeckoCategoriesSnapshot("meta"),
      getCoingeckoFdvSnapshot("meta"),
      getForecastSnapshot(),
    ]);

  const errors: SideDataSubSourceErrors = {};
  const payload: SideDataPayload = { generatedAt: new Date().toISOString() };

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

  const campaignAccessSnapshot = getCampaignAccessSnapshot();
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
    res
      .status(500)
      .json({
        error: "Internal server error",
        message: "Failed to load side-data meta",
        ...payload,
      });
    return;
  }

  res.status(200).json(payload);
};
