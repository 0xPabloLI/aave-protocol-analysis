import 'dotenv/config';
import express from 'express';
import { corsMiddleware } from './middleware/cors.js';
import marketsRouter from './routes/markets.js';
import { dataService } from './services/dataService.js';
import { startUpdateScheduler } from './services/updateScheduler.js';
import { logger } from './logger.js';

const app = express();
// 端口配置：优先读取环境变量，默认 3001
// 环境变量读取优先级（使用 dotenv 后）：
// 1. 系统环境变量 PORT（最高优先级，会覆盖 .env 文件）
// 2. backend/.env 文件中的 PORT（推荐，统一配置位置）
// 3. 默认值 3001
// 注意：PM2 启动时，PM2配置文件env > PM2读取的.env文件 > 系统环境变量
const PORT = process.env.PORT || 3001;

// Middleware
app.use(corsMiddleware);
app.use(express.json());

// Routes
app.use('/api/markets', marketsRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 启动时加载数据到缓存
dataService.loadData()
  .then(() => {
    logger.info('✅ Data loaded into cache');
    
    // 启动定时更新任务
    startUpdateScheduler();
    
    // 启动服务器
    app.listen(PORT, () => {
      logger.info(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    logger.error('❌ Failed to load data:', error);
    // 即使加载失败也启动服务器（可能是首次运行，数据文件不存在）
    app.listen(PORT, () => {
      logger.warn('⚠️  Data file not found. Please run data fetch script first.');
      logger.info(`🚀 Server running on http://localhost:${PORT}`);
    });
  });

export default app;
