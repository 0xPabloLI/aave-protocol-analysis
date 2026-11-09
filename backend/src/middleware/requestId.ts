import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * X-Request-ID propagation.
 *
 * Honors an incoming X-Request-ID header (validated to a safe token charset,
 * else regenerated) and stamps it on:
 * - the Request object (read `req.requestId` in handlers/logger meta)
 * - the response header (returned to callers)
 * - downstream code via the `x-request-id` field
 *
 * Enables following one request across access logs, error reports (Sentry
 * tags it) and metrics, and across the Node.js app -> Worker fallback chain
 * when callers forward the header.
 */

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
  }
}

const SAFE_REQUEST_ID = /^[\w.-]{8,128}$/;

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const incoming = req.header("x-request-id");
  const requestId =
    incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
}
