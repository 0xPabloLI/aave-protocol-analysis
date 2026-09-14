import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { BrowserPool } from "./browser-pool.js";
import { createLogger } from "./logger.js";

export interface Env {
  MY_BROWSER: BrowserWorker;
  BROWSER_POOL: DurableObjectNamespace;
}

const logger = createLogger("worker");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const url = new URL(request.url);

    // Liveness endpoint: cheap, no browser binding or DO round-trip.
    if (url.pathname === "/health") {
      logger.info("health check", {
        method: request.method,
        path: url.pathname,
      });
      return jsonResponse({ status: "ok" });
    }

    if (url.pathname === "/limits") {
      try {
        const limits = await (puppeteer as any).limits(env.MY_BROWSER);
        return jsonResponse({ success: true, limits });
      } catch (error) {
        logger.warn("browser limits lookup failed", {
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonResponse(
          { success: false, error: "Failed to fetch browser limits" },
          200
        );
      }
    }

    const id = env.BROWSER_POOL.idFromName("global-browser-pool");
    const stub = env.BROWSER_POOL.get(id);
    const response = await stub.fetch(request);
    logger.info("request", {
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - start,
    });
    return response;
  },
};

export { BrowserPool };
