import { schedule } from 'node-cron';
import { warmCoingeckoCategoriesCache, warmCoingeckoFdvCache } from '../controllers/coingeckoController.js';
import { warmCampaignForecastStatesCache } from '../controllers/merklForecastController.js';
import { getMarketsSnapshot, refreshMarketsSnapshot } from './marketsService.js';
import { refreshOnchainCache } from './onchainDataService.js';
import { getCachedOraclePricesSnapshot, refreshOracleCache } from './oracleService.js';
import { isPersistenceEnabled, isPoolHealthy, getPool } from './dbPool.js';
import {
  persistSnapshotIfNeeded,
} from './persistenceService.js';
import { fetchAndPersistGscDaily } from './gscService.js';
import { setGscFetchSuccess, setGscFetchFailure } from './gscFetchState.js';
import { runArchiveCheck } from './archiveService.js';
import { logger } from '../logger.js';
import { BACKEND_SCHEDULE_CRON } from '../cacheTtl.js';

const _MB = 1024 * 1024;
const _heapDiagEnabled = process.env.MEMORY_DIAG === '1';

function snapshotMem(): { heapUsed: number; heapTotal: number; rss: number; arrayBuffers: number } {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss, arrayBuffers: m.arrayBuffers ?? 0 };
}

function logHeapDiff(label: string, before: ReturnType<typeof snapshotMem>): void {
  if (!_heapDiagEnabled) return;
  const after = snapshotMem();
  const dHeap = (after.heapUsed - before.heapUsed) / _MB;
  const dRss = (after.rss - before.rss) / _MB;
  const dAb = (after.arrayBuffers - before.arrayBuffers) / _MB;
  const absHeap = after.heapUsed / _MB;
  if (Math.abs(dHeap) > 0.5 || Math.abs(dRss) > 0.5) {
    logger.info(
      `🔍 heap-diff [${label}] heap=${dHeap >= 0 ? '+' : ''}${dHeap.toFixed(1)}MB rss=${dRss >= 0 ? '+' : ''}${dRss.toFixed(1)}MB ab=${dAb >= 0 ? '+' : ''}${dAb.toFixed(1)}MB → absHeap=${absHeap.toFixed(0)}MB`
    );
  }
}

async function withHeapTrace<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const before = snapshotMem();
  try {
    return await fn();
  } finally {
    if (_heapDiagEnabled) {
      logHeapDiff(label + ':pre-gc', before);
      if (globalThis.gc) {
        globalThis.gc();
        logHeapDiff(label + ':post-gc', before);
      }
    }
  }
}

/**
 * 启动定时更新任务
 * 所有数据使用 cron-write/API-read-only 模式
 *
 * Architecture:
 * - Markets (V3+V4 merged): every 1 minute at :00
 * - On-chain: every 1 minute at :10, concurrent per-chain fetch with 30-min TTL
 */
export function startUpdateScheduler(): void {
  logger.info('📅 Starting cron schedulers (all cron-write/API-read-only):');
  logger.info('   • Markets (V3+V4 merged): every 1 minute at :00');
  logger.info('   • On-chain (deficit, baseRate): every 1 minute at :10');
  logger.info('   • Persistence (PostgreSQL): every 1 minute at :20');
  logger.info('   • Oracle (V3+V4 prices): every 60s (60s TTL, V4 reserveToken 1h cached)');
  logger.info('   • Forecast: every 10 minutes');
  logger.info('   • FDV: every 15 minutes');
  logger.info('   • Categories: every 6 hours');
  logger.info('   • GSC daily fetch: every day at 06:00 UTC');
  logger.info('   • Archive-clean pipeline: every hour at :40');

  schedule(BACKEND_SCHEDULE_CRON.marketsBackupEveryMinuteAtSecond0, async () => {
    try {
      await withHeapTrace('markets', refreshMarketsSnapshot);
    } catch (error) {
      logger.warn(
        `Markets refresh scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  schedule(BACKEND_SCHEDULE_CRON.onchainDataWarmEveryMinuteAtSecond10, async () => {
    try {
      await withHeapTrace('onchain', refreshOnchainCache);
    } catch (error) {
      logger.warn(
        `On-chain cache refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Persist memory snapshots to PostgreSQL every minute at :20.
  // Runs independently after markets (:00) + oracle (:00) + onchain (:10) settle.
  // Onchain failure does NOT block persist — markets + oracle data is still valid.
  schedule(BACKEND_SCHEDULE_CRON.persistSnapshotsEveryMinuteAtSecond20, async () => {
    try {
      const marketsSnapshot = getMarketsSnapshot();
      const oracleSnapshot = getCachedOraclePricesSnapshot();
      if (isPersistenceEnabled() && isPoolHealthy()) {
        await persistSnapshotIfNeeded(marketsSnapshot?.payload ?? null, oracleSnapshot);
      }
    } catch (error) {
      logger.warn(
        `Persistence flush failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  schedule(BACKEND_SCHEDULE_CRON.oraclePriceWarmEveryMinuteAtSecond0, async () => {
    try {
      await withHeapTrace('oracle', refreshOracleCache);
    } catch (error) {
      logger.warn(
        `Oracle cache refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  schedule(BACKEND_SCHEDULE_CRON.coingeckoFdvWarmEveryFifteenMinutesAtSecond5, async () => {
    try {
      await withHeapTrace('fdv', warmCoingeckoFdvCache);
    } catch (error) {
      logger.warn(
        `FDV warm scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  schedule(BACKEND_SCHEDULE_CRON.campaignForecastWarmEveryTenMinutesAtSecond30, async () => {
    try {
      const summary = await withHeapTrace('forecast', warmCampaignForecastStatesCache);
      logger.info(
        `✅ Campaign forecast warm scheduler finished: requested=${summary.requested}, fulfilled=${summary.fulfilled}, failed=${summary.failed}`
      );
    } catch (error) {
      logger.warn(
        `Campaign forecast warm scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  schedule(BACKEND_SCHEDULE_CRON.coingeckoCategoriesWarmEverySixHoursAtSecond10, async () => {
    try {
      await withHeapTrace('categories', warmCoingeckoCategoriesCache);
    } catch (error) {
      logger.warn(
        `Categories warm scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // GSC daily fetch at 06:00 UTC.
  schedule(BACKEND_SCHEDULE_CRON.gscDailyFetchAtSixAmUtc, async () => {
    if (!process.env.GSC_SA_EMAIL) {
      logger.info('GSC daily fetch skipped: GSC_SA_EMAIL not configured');
      return;
    }
    try {
      const pool = getPool();
      const result = await fetchAndPersistGscDaily(pool);
      setGscFetchSuccess(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setGscFetchFailure(msg);
      logger.error(`GSC daily fetch failed: ${msg}`);
    }
  });

  // Archive-clean pipeline: check DB size every hour, trigger GitHub Actions
  // workflow if over threshold, then clean PG on next check after workflow completes.
  schedule(BACKEND_SCHEDULE_CRON.archiveCheckEveryHourAtMinute40, async () => {
    if (!isPersistenceEnabled()) return;
    try {
      const result = await runArchiveCheck();
      if (result.action !== 'skipped_below_threshold' && result.action !== 'skipped_no_db') {
        logger.info(`Archive check: action=${result.action}, pgSize=${(result.pgSizeBytes / 1024 / 1024).toFixed(0)}MB, threshold=${(result.thresholdBytes / 1024 / 1024).toFixed(0)}MB`);
      }
    } catch (error) {
      logger.warn(
        `Archive check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}
