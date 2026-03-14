/**
 * Markets Controller - Cron-write/API-read-only pattern
 *
 * This controller ONLY reads from the in-memory snapshot.
 * All data updates are handled by cron + startup warmup in marketsService.
 */

import { Request, Response } from 'express';
import { getMarketsData } from '../services/marketsService.js';
import { MarketsResponse } from '../types/index.js';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';

/**
 * GET /api/markets
 * Returns all markets data from the in-memory snapshot.
 * Cron-write/API-read-only: never triggers external fetches.
 */
export async function getMarkets(req: Request, res: Response): Promise<void> {
  try {
    const { payload, staleTimeMs, ageMs } = getMarketsData();

    // If no snapshot yet (cold start before warmup completes)
    if (!payload) {
      logger.warn('Markets snapshot not yet available');
      res.status(503).json({
        errorCode: 'MARKETS_SNAPSHOT_NOT_READY',
        error: 'Service unavailable',
        message: 'Markets data is still loading. Please retry shortly.',
      });
      return;
    }

    // Filter invalid entries (missing required fields)
    const filteredData = payload.data.filter((item) => {
      return (
        item.marketName &&
        item.marketName.trim() !== '' &&
        item.chainName &&
        item.chainName.trim() !== '' &&
        item.tokenSymbol &&
        item.tokenSymbol.trim() !== ''
      );
    });

    const response: MarketsResponse = {
      snapshot: {
        lastUpdated: payload._metadata.timestamp,
        version: 'markets-v2',
        staleTimeMs,
      },
      reserves: filteredData,
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
