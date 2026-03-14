/**
 * Markets Controller - Cron-write/API-read-only pattern
 *
 * This controller ONLY reads from the in-memory snapshot.
 * All data updates are handled by cron + startup warmup in marketsService.
 * Rate-inputs are merged into each reserve for APR simulation.
 */

import { Request, Response } from 'express';
import { getMarketsData } from '../services/marketsService.js';
import { getRateInputsMap } from '../services/rateInputsService.js';
import { MarketsResponse, MarketWithSpread, EmbeddedRateInputs } from '../types/index.js';
import { logger } from '../logger.js';

/**
 * GET /api/markets
 * Returns all markets data from the in-memory snapshot.
 * Rate-inputs are merged into each reserve if available.
 * Cron-write/API-read-only: never triggers external fetches.
 */
export async function getMarkets(req: Request, res: Response): Promise<void> {
  try {
    const { payload, staleTimeMs } = getMarketsData();

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

    // Get rate-inputs map for merging (may be null if not yet populated)
    const rateInputsMap = getRateInputsMap();

    // Filter invalid entries and merge rate-inputs
    const reserves: MarketWithSpread[] = payload.data
      .filter((item) => {
        return (
          item.marketName &&
          item.marketName.trim() !== '' &&
          item.chainName &&
          item.chainName.trim() !== '' &&
          item.tokenSymbol &&
          item.tokenSymbol.trim() !== ''
        );
      })
      .map((item) => {
        // Build lookup key: marketName:chainId:tokenAddress (lowercase)
        const key = `${item.marketName}:${item.chainId}:${item.tokenAddress.toLowerCase()}`;
        const rateInput = rateInputsMap?.get(key);

        if (!rateInput) {
          return item;
        }

        // Merge rate-inputs into reserve
        // deficitAvailable indicates if deficit was fetched from on-chain RPC (true)
        // or is a placeholder '0' from Aave API/Subgraph fallback (false)
        const embedded: EmbeddedRateInputs = {
          decimals: rateInput.decimals,
          deficit: rateInput.deficit,
          deficitAvailable: rateInput.deficitAvailable,
          availableLiquidity: rateInput.availableLiquidity,
          totalScaledVariableDebt: rateInput.totalScaledVariableDebt,
          variableBorrowIndex: rateInput.variableBorrowIndex,
          reserveFactor: rateInput.reserveFactor,
          variableRateSlope1: rateInput.variableRateSlope1,
          variableRateSlope2: rateInput.variableRateSlope2,
          baseVariableBorrowRate: rateInput.baseVariableBorrowRate,
          optimalUsageRate: rateInput.optimalUsageRate,
        };

        return {
          ...item,
          rateInputs: embedded,
        };
      });

    const response: MarketsResponse = {
      snapshot: {
        lastUpdated: payload._metadata.timestamp,
        version: 'markets-v2',
        staleTimeMs,
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
