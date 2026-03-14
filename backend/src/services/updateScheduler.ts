import cron from 'node-cron';
import { warmCoingeckoCategoriesCache, warmCoingeckoFdvCache } from '../controllers/coingeckoController.js';
import { warmCampaignForecastStatesCache } from '../controllers/merklForecastController.js';
import { refreshMarketsSnapshot } from './marketsService.js';
import { logger } from '../logger.js';
import { BACKEND_SCHEDULE_CRON } from '../cacheTtl.js';

/**
 * 启动定时更新任务
 * 所有数据使用 cron-write/API-read-only 模式
 * 
 * Architecture: Markets refresh includes deficit fetch (single cron, single fetchedAt)
 */
export function startUpdateScheduler(): void {
  logger.info('📅 Starting cron schedulers (all cron-write/API-read-only):');
  logger.info('   • Markets + Deficit: every 1 minute (unified)');
  logger.info('   • Forecast: every 10 minutes');
  logger.info('   • FDV: every 5 minutes');
  logger.info('   • Categories: every 6 hours');

  // Markets refresh every minute (includes deficit fetch in parallel)
  cron.schedule(BACKEND_SCHEDULE_CRON.marketsBackupEveryMinuteAtSecond0, async () => {
    try {
      await refreshMarketsSnapshot();
    } catch (error) {
      logger.warn(
        `Markets refresh scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Warm FDV cache every 5 minutes so frontend reads hot snapshots.
  cron.schedule(BACKEND_SCHEDULE_CRON.coingeckoFdvWarmEveryFiveMinutesAtSecond5, async () => {
    try {
      await warmCoingeckoFdvCache();
    } catch (error) {
      logger.warn(
        `FDV warm scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Refresh campaign forecast snapshot every 10 minutes (cron-write, API-read-only pattern).
  cron.schedule(BACKEND_SCHEDULE_CRON.campaignForecastWarmEveryTenMinutesAtSecond30, async () => {
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
  cron.schedule(BACKEND_SCHEDULE_CRON.coingeckoCategoriesWarmEverySixHoursAtSecond10, async () => {
    try {
      await warmCoingeckoCategoriesCache();
    } catch (error) {
      logger.warn(
        `Categories warm scheduler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}
