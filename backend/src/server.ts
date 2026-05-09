import './env.js';
import express from 'express';
import compression from 'compression';
import { corsMiddleware } from './middleware/cors.js';
import { apiCacheHeadersMiddleware } from './middleware/cacheHeaders.js';
import marketsRouter from './routes/markets.js';
import metaRouter from './routes/meta.js';
import { startUpdateScheduler } from './services/updateScheduler.js';
import { warmCoingeckoCategoriesCache, warmCoingeckoFdvCache } from './controllers/coingeckoController.js';
import { warmCampaignForecastStatesCache } from './controllers/merklForecastController.js';
import { warmMarketsCache } from './services/marketsService.js';
import { refreshOnchainCache } from './services/onchainDataService.js';
import { refreshOracleCache } from './services/oracleService.js';
import { logger } from './logger.js';
import { explainServerListenError } from './startup.js';
import { closePool } from './services/dbPool.js';
import { getPersistenceStatus } from './services/persistenceService.js';

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

// Security.txt — RFC 9116 vulnerability disclosure policy
app.get('/.well-known/security.txt', (_req, res) => {
  res.type('text/plain').send(
    'Contact: mailto:0xpablo.li@proton.me\n' +
    'Expires: 2027-05-08T00:00:00.000Z\n' +
    'Preferred-Languages: en, zh\n' +
    'Canonical: https://aaveapy.com/.well-known/security.txt\n'
  );
});

// Routes
app.use('/api/markets', marketsRouter);
app.use('/api/meta', metaRouter);
// Note: /api/rate-inputs endpoint removed - rate-inputs are now merged into /api/markets

const healthHandler = (req: express.Request, res: express.Response) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    // Railway injects RAILWAY_GIT_COMMIT_SHA at runtime; smoke tests poll this
    // to confirm the new deployment is live before running checks.
    ...(process.env.RAILWAY_GIT_COMMIT_SHA && { commitSha: process.env.RAILWAY_GIT_COMMIT_SHA }),
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

// Persistence diagnostics — exposes whether DB writes are happening on schedule.
// Useful for catching silent persistence failures (the cron writer never throws
// up the call stack, so without this endpoint a failed DB connection could go
// unnoticed for days).
app.get('/api/persistence-status', (_req, res) => {
  res.json(getPersistenceStatus());
});

// 启动时预热所有缓存，避免首个请求冷启动
// 注意：cron 不会在启动时立即执行，所以需要显式 warmup
// 所有 API 数据现在使用 cron-write/API-read-only 模式
// Persistence via DATABASE_URL env var (set in Railway staging, references postgres-mdwg)
logger.info('🔄 Starting cache warmup (all data will be fetched before server accepts requests)...');

// Phase 1: independent caches (can run in parallel)
Promise.allSettled([
  refreshOnchainCache()
    .then(() => logger.info('✅ On-chain cache (deficit, baseRate) warmed on startup'))
    .catch((error) => logger.warn('⚠️  Failed to warm on-chain cache on startup:', error)),
  refreshOracleCache()
    .then(() => logger.info('✅ Oracle price cache warmed on startup'))
    .catch((error) => logger.warn('⚠️  Failed to warm oracle cache on startup:', error)),
  warmMarketsCache()
    .then(() => logger.info('✅ Markets cache warmed on startup'))
    .catch((error) => logger.warn('⚠️  Failed to warm markets on startup:', error)),
  warmCoingeckoCategoriesCache()
    .then(() => logger.info('✅ Coingecko categories cache warmed on startup'))
    .catch((error) => logger.warn('⚠️  Failed to warm coingecko categories on startup:', error)),
  warmCoingeckoFdvCache()
    .then(() => logger.info('✅ Coingecko FDV cache warmed on startup'))
    .catch((error) => logger.warn('⚠️  Failed to warm coingecko FDV on startup:', error)),
])
  .then(async () => {
    // Phase 2: forecast depends on markets snapshot being ready
    try {
      const summary = await warmCampaignForecastStatesCache();
      logger.info(`✅ Forecast snapshot cache warmed on startup: requested=${summary.requested}, fulfilled=${summary.fulfilled}, failed=${summary.failed}`);
    } catch (error) {
      logger.warn('⚠️  Failed to warm forecast snapshot on startup:', error);
    }

    logger.info('✅ All caches warmed');
    
    // 启动定时更新任务
    startUpdateScheduler();
    
    // 启动服务器
    const server = app.listen(PORT, () => {
      logger.info(`🚀 Server ready on http://localhost:${PORT}`);
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      const explanation = explainServerListenError(error, PORT);
      if (explanation) {
        logger.error(explanation);
      } else {
        logger.error('❌ Failed to start HTTP server:', error);
      }
      process.exit(1);
    });

    // Graceful shutdown — stop accepting new requests, drain in-flight ones,
    // then close the DB pool so any open connections to Railway PG are released
    // cleanly during deploy/restart.
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`📴 Received ${signal}, shutting down gracefully…`);
      server.close((err) => {
        if (err) logger.warn('Error closing HTTP server:', err);
        closePool()
          .catch((e) => logger.warn('Error closing DB pool:', e))
          .finally(() => process.exit(0));
      });
      // Hard timeout: force-exit if shutdown stalls (>10s).
      setTimeout(() => {
        logger.warn('⏱️  Graceful shutdown timed out, forcing exit');
        process.exit(1);
      }, 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((error) => {
    logger.error('❌ Startup warmup failed:', error);
    process.exit(1);
  });

// ts-prune-ignore-next
export default app;
