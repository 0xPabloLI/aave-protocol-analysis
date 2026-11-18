import { Router } from "express";
import {
  createSideDataMetaHandler,
  type SideDataMetaDeps,
} from "../controllers/metaController.js";
import { createEModeMetaHandler } from "../controllers/emodeController.js";
import type { EModeSourceReader } from "../services/emodeApi.js";

/**
 * Build the `/api/meta` router. Both snapshot readers are injectable so route
 * tests can exercise the contracts without warming real caches.
 */
export function createMetaRouter(
  deps: { getEModeSource?: EModeSourceReader; sideData?: SideDataMetaDeps } = {}
): Router {
  const router = Router();
  router.get("/side-data", createSideDataMetaHandler(deps.sideData));
  router.get("/e-mode", createEModeMetaHandler(deps.getEModeSource));
  router.get("/e-mode/:marketKey", createEModeMetaHandler(deps.getEModeSource));
  return router;
}

export default createMetaRouter();
