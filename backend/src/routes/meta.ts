import { Router } from "express";
import { getSideDataMeta } from "../controllers/metaController.js";
import { createEModeMetaHandler } from "../controllers/emodeController.js";
import type { EModeSourceReader } from "../services/emodeApi.js";

/**
 * Build the `/api/meta` router. `getEModeSource` is injectable so route tests
 * can exercise the eMode contract without warming a real markets snapshot.
 */
export function createMetaRouter(
  deps: { getEModeSource?: EModeSourceReader } = {}
): Router {
  const router = Router();
  router.get("/side-data", getSideDataMeta);
  router.get("/e-mode", createEModeMetaHandler(deps.getEModeSource));
  router.get("/e-mode/:marketKey", createEModeMetaHandler(deps.getEModeSource));
  return router;
}

export default createMetaRouter();
