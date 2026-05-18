import { schedule } from 'node-cron';
import { warmCoingeckoCategoriesCache, warmCoingeckoFdvCache } from '../controllers/coingeckoController.js';
import { warmCampaignForecastStatesCache } from '../controllers/merklForecastController.js';
import { getMarketsSnapshot, refreshMarketsSnapshot } from './marketsService.js';
import { refreshOnchainCache } from './onchainDataService.js';
import { getCachedOraclePricesSnapshot, refreshOracleCache } from './oracleService.js';
import { isPersistenceEnabled, getPool } from './dbPool.js';
import {
  appendAprObservations,
  markExpiredCampaigns,
  persistCampaignHistory,
  persistSnapshotIfNeeded,
} from './persistenceService.js';
import { fetchAndPersistGscDaily } from './gscService.js';
import { setGscFetchSuccess, setGscFetchFailure } from './gscFetchState.js';
import { logger } from '../logger.js';
import { BACKEND_SCHEDULE_CRON } from '../cacheTtl.js';

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
  logger.info('   • Persistence (PostgreSQL + campaign history): every 1 minute at :20');
  logger.info('   • Oracle (V3+V4 prices): every 60s (60s TTL, V4 reserveToken 1h cached)');
  logger.info('   • Forecast: every 10 minutes');
  logger.info('   • FDV: every 15 minutes');
  logger.info('   • Categories: every 6 hours');
  logger.info('   • GSC daily fetch: every day at 06:00 UTC');

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

  // Persist memory snapshots to PostgreSQL every minute at :20.
  // Runs independently after markets (:00) + oracle (:00) + onchain (:10) settle.
  // Onchain failure does NOT block persist — markets + oracle data is still valid.
  schedule(BACKEND_SCHEDULE_CRON.persistSnapshotsEveryMinuteAtSecond20, async () => {
    try {
      const marketsSnapshot = getMarketsSnapshot();
      const oracleSnapshot = getCachedOraclePricesSnapshot();
      if (isPersistenceEnabled()) {
        await persistSnapshotIfNeeded(marketsSnapshot?.payload ?? null, oracleSnapshot);
        if (marketsSnapshot?.payload) {
          await persistCampaignHistory(marketsSnapshot.payload);
          await markExpiredCampaigns();
          await appendAprObservations(marketsSnapshot.payload);
        }
      }
    } catch (error) {
      logger.warn(
        `Persistence flush failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Oracle price refresh every minute
  schedule(BACKEND_SCHEDULE_CRON.oraclePriceWarmEveryMinuteAtSecond0, async () => {
    try {
      await refreshOracleCache();
    } catch (error) {
      logger.warn(
        `Oracle cache refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Warm FDV cache every 15 minutes so frontend reads hot snapshots.
  schedule(BACKEND_SCHEDULE_CRON.coingeckoFdvWarmEveryFifteenMinutesAtSecond5, async () => {
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

  // GSC daily fetch at 06:00 UTC.
  schedule(BACKEND_SCHEDULE_CRON.gscDailyFetchAtSixAmUtc, async () => {
    if (!process.env.GSC_SA_EMAIL) return;
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
}
