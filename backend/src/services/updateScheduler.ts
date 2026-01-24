import cron from 'node-cron';
import { fetchAaveMarketsData } from '../../../dist/index.js';
import { dataService } from './dataService.js';
import { setUpdateStatus, getUpdateStatus } from '../controllers/marketsController.js';
import { withTimeout, UPDATE_TIMEOUT_MS } from '../utils/timeout.js';

/**
 * 启动定时更新任务
 * 每 1 分钟执行一次数据更新
 * 注意：此定时任务作为后备机制，主要的数据更新由 API 请求自动触发
 */
export function startUpdateScheduler(): void {
  console.log('📅 Starting update scheduler (every 1 minute) as backup mechanism');

  // 每 1 分钟执行一次
  // node-cron 3.0.3 需要 6 位 cron 表达式（包含秒字段）
  // 使用 '0 */1 * * * *' 表示每分钟的第0秒执行
  cron.schedule('0 */1 * * * *', async () => {
    const currentStatus = getUpdateStatus();

    // 如果正在更新中，跳过本次更新
    if (currentStatus.status === 'updating') {
      console.log('⏭️  Update in progress, skipping scheduled update');
      return;
    }

    // 检查数据是否过期
    const isStale = dataService.isStale();
    if (!isStale) {
      console.log('✅ Data is fresh, skipping scheduled update');
      return;
    }

    console.log('🔄 Starting scheduled data update (backup mechanism)...');

    setUpdateStatus({
      status: 'updating',
      lastUpdated: currentStatus.lastUpdated,
      lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
    });

    try {
      // 使用超时保护，避免因 Cloudflare 重试等导致的长时间阻塞
      await withTimeout(fetchAaveMarketsData(), UPDATE_TIMEOUT_MS);

      // 更新成功后刷新缓存
      await dataService.refreshCache();
      const lastUpdated = dataService.getLastUpdated();

      setUpdateStatus({
        status: 'idle',
        lastUpdated: lastUpdated?.toISOString() || null,
        lastSuccessfulUpdate: lastUpdated?.toISOString() || null,
      });

      console.log('✅ Scheduled update completed successfully');
    } catch (error) {
      console.error('❌ Scheduled update failed:', error);
      const errorStatus = getUpdateStatus();
      
      // 如果是超时错误，特别标记
      const isTimeout = error instanceof Error && error.message.includes('timeout');
      if (isTimeout) {
        console.warn(`⏰ Update timed out after ${UPDATE_TIMEOUT_MS / 1000}s, resetting status to allow next scheduled update`);
      }
      
      setUpdateStatus({
        status: 'error',
        lastUpdated: errorStatus.lastUpdated,
        lastSuccessfulUpdate: errorStatus.lastSuccessfulUpdate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
