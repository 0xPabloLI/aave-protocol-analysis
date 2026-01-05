import cron from 'node-cron';
import { fetchAaveMarketsData } from '../../../dist/index.js';
import { dataService } from './dataService.js';
import { setUpdateStatus, getUpdateStatus } from '../controllers/marketsController.js';

/**
 * 启动定时更新任务
 * 每 1 分钟执行一次数据更新
 */
export function startUpdateScheduler(): void {
  console.log('📅 Starting update scheduler (every 1 minute)');

  // 每 1 分钟执行一次 (cron: */1 * * * *)
  cron.schedule('*/1 * * * *', async () => {
    const currentStatus = getUpdateStatus();
    
    // 如果正在更新中，跳过本次更新
    if (currentStatus.status === 'updating') {
      console.log('⏭️  Update in progress, skipping scheduled update');
      return;
    }

    console.log('🔄 Starting scheduled data update...');
    
    setUpdateStatus({
      status: 'updating',
      lastUpdated: currentStatus.lastUpdated,
      lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
    });

    try {
      await fetchAaveMarketsData();
      
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
      setUpdateStatus({
        status: 'error',
        lastUpdated: errorStatus.lastUpdated,
        lastSuccessfulUpdate: errorStatus.lastSuccessfulUpdate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
