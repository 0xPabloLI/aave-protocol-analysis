import type { Request, Response } from 'express';
import { logger } from '../logger.js';
import { getCoingeckoCategoriesSnapshot, getCoingeckoFdvSnapshot } from './coingeckoController.js';

export const getSideDataMeta = async (_req: Request, res: Response) => {
  const [categoriesResult, fdvResult] = await Promise.allSettled([
    getCoingeckoCategoriesSnapshot('meta'),
    getCoingeckoFdvSnapshot('meta'),
  ]);

  const errors: Record<string, string> = {};
  const payload: {
    generatedAt: string;
    partial: boolean;
    categories?: {
      uniqueSymbolsStablecoins: string[];
      uniqueSymbolsEth: string[];
      fetchedAt: string;
      staleTimeMs: number;
    };
    fdv?: {
      items: Array<{ id: string; symbol: string | null; name: string | null; fdvUsd: number | null; source: string }>;
      fetchedAt: string;
      staleTimeMs: number;
    };
    errors?: Record<string, string>;
  } = {
    generatedAt: new Date().toISOString(),
    partial: false,
  };

  if (categoriesResult.status === 'fulfilled') {
    payload.categories = {
      ...categoriesResult.value.data,
      fetchedAt: categoriesResult.value.fetchedAt,
      staleTimeMs: categoriesResult.value.staleTimeMs,
    };
  } else {
    errors.categories = categoriesResult.reason instanceof Error
      ? categoriesResult.reason.message
      : String(categoriesResult.reason);
  }

  if (fdvResult.status === 'fulfilled') {
    payload.fdv = {
      ...fdvResult.value.data,
      staleTimeMs: fdvResult.value.staleTimeMs,
    };
  } else {
    errors.fdv = fdvResult.reason instanceof Error
      ? fdvResult.reason.message
      : String(fdvResult.reason);
  }

  const successCount = Number(Boolean(payload.categories)) + Number(Boolean(payload.fdv));
  payload.partial = successCount < 2;
  if (Object.keys(errors).length > 0) {
    payload.errors = errors;
  }

  if (successCount === 0) {
    logger.error('Side-data meta failed: both categories and fdv unavailable');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to load side-data meta',
      ...payload,
    });
    return;
  }

  res.status(200).json(payload);
};

