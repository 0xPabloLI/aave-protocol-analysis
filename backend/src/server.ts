import './env.js';
import express from 'express';
import compression from 'compression';
import { corsMiddleware } from './middleware/cors.js';
import { apiCacheHeadersMiddleware } from './middleware/cacheHeaders.js';
import marketsRouter from './routes/markets.js';
import coingeckoRouter from './routes/coingecko.js';
import coingeckoFdvRouter from './routes/coingeckoFdv.js';
import campaignsRouter from './routes/campaigns.js';
import rateInputsRouter from './routes/rateInputs.js';
import metaRouter from './routes/meta.js';
import { dataService } from './services/dataService.js';
import { startUpdateScheduler } from './services/updateScheduler.js';
import { warmCoingeckoCategoriesCache } from './controllers/coingeckoController.js';
import { logger } from './logger.js';

const app = express();
app.set('etag', 'weak');
// 端口配置：优先读取环境变量，默认 3001
// 环境变量读取优先级（使用 dotenv 后）：
// 1. 系统环境变量 PORT（最高优先级，会覆盖 .env 文件）
// 2. 仓库根目录 .env 文件中的 PORT（统一配置位置）
// 3. 默认值 3001
// 注意：PM2 启动时，PM2配置文件env > PM2读取的.env文件 > 系统环境变量
// 注意：PORT=0 是有效值（表示使用任意可用端口），不应被替换为默认值
// 有效端口范围：0（OS选择）或 1-65535
const PORT: number = (() => {
  if (!process.env.PORT) return 3001;
  const parsed = Number.parseInt(process.env.PORT, 10);
  if (Number.isNaN(parsed)) {
    logger.warn(`⚠️  Invalid PORT value "${process.env.PORT}", using default 3001`);
    return 3001;
  }
  // 验证端口范围：0（OS选择）或 1-65535
  if (parsed !== 0 && (parsed < 1 || parsed > 65535)) {
    logger.warn(`⚠️  PORT value ${parsed} is out of valid range (0 or 1-65535), using default 3001`);
    return 3001;
  }
  return parsed;
})();

// Middleware
app.use(corsMiddleware);
app.use(express.json());
app.use(
  compression({
    // Keep tiny payloads uncompressed to avoid needless CPU overhead.
    threshold: 1024,
  })
);
app.use(apiCacheHeadersMiddleware);

// Avoid noisy 404s for automatic browser favicon requests.
// We intentionally return 204 No Content with a cache header instead of serving an icon file.
app.get('/favicon.ico', (req, res) => {
  res.status(204).setHeader('Cache-Control', 'public, max-age=86400');
  res.end();
});

// Routes
app.use('/api/markets', marketsRouter);
app.use('/api/coingecko-categories', coingeckoRouter);
app.use('/api/coingecko-fdv', coingeckoFdvRouter);
app.use('/api/meta', metaRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/rate-inputs', rateInputsRouter);

const healthHandler = (req: express.Request, res: express.Response) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: PORT,
      corsMode: ['production', 'staging'].includes(process.env.NODE_ENV || '') && process.env.FRONTEND_URL 
        ? 'whitelist' 
        : 'allow-all',
      frontendUrl: process.env.FRONTEND_URL || 'not set',
      allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS || 'not set'
    }
  });
};

// Health check endpoints:
// - /health for load balancer probes
// - /api/health for API namespace consistency
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// 启动时加载数据到缓存
dataService.loadData()
  .then(() => {
    logger.info('✅ Data loaded into cache');
    
    // 启动定时更新任务
    startUpdateScheduler();

    // 启动时预热 coingecko categories，避免首个请求冷启动
    return warmCoingeckoCategoriesCache()
      .then(() => {
        logger.info('✅ Coingecko categories cache warmed on startup');
      })
      .catch((error) => {
        logger.warn('⚠️  Failed to warm coingecko categories on startup:', error);
      });
  })
  .finally(() => {
    
    // 启动服务器
    app.listen(PORT, () => {
      logger.info(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    logger.error('❌ Failed to load data:', error);
    logger.warn('⚠️  Data file not found. Please run data fetch script first.');
  });

// ts-prune-ignore-next
export default app;
