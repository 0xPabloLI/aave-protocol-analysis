import type { Request, Response } from 'express';
import { logger } from '../logger.js';
import { rateInputsService } from '../services/rateInputsService.js';

function parseOptionalChainId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseOptionalAsset(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

function parseOptionalMarketName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export async function getRateInputs(req: Request, res: Response): Promise<void> {
  try {
    const chainId = parseOptionalChainId(req.query.chainId);
    const asset = parseOptionalAsset(req.query.asset);
    const marketName = parseOptionalMarketName(req.query.marketName);

    if (req.query.chainId !== undefined && chainId === undefined) {
      res.status(400).json({ error: 'Invalid query parameter: chainId must be a positive integer' });
      return;
    }

    const payload = await rateInputsService.getRateInputs({ chainId, asset, marketName });
    res.json(payload);
  } catch (error) {
    logger.error('Error getting rate inputs:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
