import { schedule } from 'node-cron';
import { warmCoingeckoCategoriesCache, warmCoingeckoFdvCache } from '../controllers/coingeckoController.js';
import { warmCampaignForecastStatesCache } from '../controllers/merklForecastController.js';
import { refreshMarketsSnapshot, refreshV4Snapshot } from './marketsService.js';
import { refreshOnchainCache } from './onchainDataService.js';
import { logger } from '../logger.js';
import { BACKEND_SCHEDULE_CRON } from '../cacheTtl.js';

/**
 * 启动定时更新任务
 * 所有数据使用 cron-write/API-read-only 模式
 * 
 * Architecture:
 * - Markets: every 1 minute at :00, reads from on-chain cache
 * - V4 (Option 3): every 1 minute at :05, independent refresh with own TTL
 * - On-chain: every 1 minute at :10, concurrent per-chain fetch with 30-min TTL
 */
export function startUpdateScheduler(): void {
  logger.info('📅 Starting cron schedulers (all cron-write/API-read-only):');
  logger.info('   • Markets: every 1 minute at :00');
  logger.info('   • V4 (Option 3): every 1 minute at :05 (independent refresh)');
  logger.info('   • On-chain (deficit, baseRate): every 1 minute at :10 (30-min per-chain TTL)');
  logger.info('   • Forecast: every 10 minutes');
  logger.info('   • FDV: every 5 minutes');
  logger.info('   • Categories: every 6 hours');

  // Markets refresh every minute at second 0
  schedule(BACKEND_SCHEDULE_CRON.marketsBackupEveryMinuteAtSecond0, async () => {
    try {
      await refreshMarketsSnapshot();
    } catch (error) {
      logger.warn(
        `Markets refresh scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Option 3: V4 data refresh on independent schedule (every 1 min at second 5)
  // This allows V4 to have its own TTL, error handling, and refresh cycle.
  // When Option 3 is active, V4 data is stored in a separate snapshot
  // and merged with V3 at API read time.
  schedule(BACKEND_SCHEDULE_CRON.v4DataRefreshEveryMinuteAtSecond5, async () => {
    try {
      await refreshV4Snapshot();
    } catch (error) {
      logger.warn(
        `V4 refresh scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // On-chain data refresh every minute at second 10 (per-chain concurrent, no overall timeout)
  schedule(BACKEND_SCHEDULE_CRON.onchainDataWarmEveryMinuteAtSecond10, async () => {
    try {
      await refreshOnchainCache();
    } catch (error) {
      logger.warn(
        `On-chain cache refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Warm FDV cache every 5 minutes so frontend reads hot snapshots.
  schedule(BACKEND_SCHEDULE_CRON.coingeckoFdvWarmEveryFiveMinutesAtSecond5, async () => {
    try {
      await warmCoingeckoFdvCache();
    } catch (error) {
      logger.warn(
        `FDV warm scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Refresh campaign forecast snapshot every 10 minutes (cron-write, API-read-only pattern).
  schedule(BACKEND_SCHEDULE_CRON.campaignForecastWarmEveryTenMinutesAtSecond30, async () => {
    try {
      const summary = await warmCampaignForecastStatesCache();
      logger.info(
        `✅ Campaign forecast warm scheduler finished: requested=${summary.requested}, fulfilled=${summary.fulfilled}, failed=${summary.failed}`
      );
    } catch (error) {
      logger.warn(
        `Campaign forecast warm scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Warm categories cache every 6 hours to reduce cold-start risk after failures.
  schedule(BACKEND_SCHEDULE_CRON.coingeckoCategoriesWarmEverySixHoursAtSecond10, async () => {
    try {
      await warmCoingeckoCategoriesCache();
    } catch (error) {
      logger.warn(
        `Categories warm scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}
