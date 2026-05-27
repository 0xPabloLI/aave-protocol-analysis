/**
 * Markets Controller - Cron-write/API-read-only pattern
 *
 * This controller ONLY reads from the in-memory snapshot.
 * All data updates (including deficit) are handled by cron + startup warmup in marketsService.
 * Deficit is merged into reserves at write time (single fetchedAt).
 */

import { Request, Response } from 'express';
import { getMarketsData, type RuntimeReserveData } from '../services/marketsService.js';
import { serializeMarketsReservesForApi, computeSchemaFingerprint } from '../services/marketsApiSerialize.js';
import { MarketsResponse, MarketWithSpread } from '../types/index.js';
import { logger } from '../logger.js';

/** API version — bumped when breaking changes (field renames) are introduced. */
export const MARKETS_API_VERSION = 'snapshot-v3';

/**
 * GET /api/markets
 * Returns all markets data from the in-memory snapshot.
 * Deficit is already merged into each reserve (write-time merge in marketsService).
 * Cron-write/API-read-only: never triggers external fetches.
 */
export async function getMarkets(req: Request, res: Response): Promise<void> {
  try {
    const { payload, staleTimeMs, hardTtlMs, ageMs, isTooStale, deficitFallbackReserveIds, v4FallbackReserveIds } = getMarketsData();

    // If no snapshot yet (cold start before warmup completes)
    if (!payload) {
      if (isTooStale) {
        logger.warn('Markets snapshot is too stale; returning 503');
        res.set('Retry-After', '60');
        res.status(503).json({
          errorCode: 'MARKETS_SNAPSHOT_STALE',
          error: 'Service unavailable',
          message: `Markets snapshot is too old to serve safely (ageMs=${ageMs ?? 'unknown'}, hardTtlMs=${hardTtlMs}).`,
        });
        return;
      }

      logger.warn('Markets snapshot not yet available');
      res.set('Retry-After', '10');
      res.status(503).json({
        errorCode: 'MARKETS_SNAPSHOT_NOT_READY',
        error: 'Service unavailable',
        message: 'Markets data is still loading. Please retry shortly.',
      });
      return;
    }

    // Filter invalid entries (deficit already merged at write time)
    const filtered = payload.data.filter((item) => {
      return (
        item.marketName &&
        item.marketName.trim() !== '' &&
        item.chainName &&
        item.chainName.trim() !== '' &&
        item.tokenSymbol &&
        item.tokenSymbol.trim() !== ''
      );
    });

    const reserves: MarketWithSpread[] = serializeMarketsReservesForApi(filtered as RuntimeReserveData[]);

    const response: MarketsResponse = {
      snapshot: {
        lastUpdated: payload._metadata.timestamp,
        version: MARKETS_API_VERSION,
        staleTimeMs,
        schemaFingerprint: computeSchemaFingerprint(),
        deficitFallbackReserveIds,
        ...(v4FallbackReserveIds.length ? { v4FallbackReserveIds } : {}),
      },
      reserves,
    };

    res.json(response);
  } catch (error) {
    logger.error('Error getting markets:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
