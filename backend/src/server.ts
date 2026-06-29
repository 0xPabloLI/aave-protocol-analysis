import './env.js';
import express from 'express';
import compression from 'compression';
import { Agent, setGlobalDispatcher } from 'undici';
import v8 from 'v8';
import { corsMiddleware } from './middleware/cors.js';
import { apiCacheHeadersMiddleware } from './middleware/cacheHeaders.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import marketsRouter from './routes/markets.js';
import metaRouter from './routes/meta.js';
import { seoRouter } from './routes/seo.js';
import { swaggerRouter } from './routes/swagger.js';
import { startUpdateScheduler } from './services/updateScheduler.js';
import { warmCoingeckoCategoriesCache, warmCoingeckoFdvCache } from './controllers/coingeckoController.js';
import { warmCampaignForecastStatesCache } from './controllers/merklForecastController.js';
import { getMerklForecastCacheStats } from './services/merklForecastService.js';
import { warmMarketsCache, getMarketsData } from './services/marketsService.js';
import { refreshOnchainCache, getOnchainCacheStatus } from './services/onchainDataService.js';
import { refreshOracleCache, getOracleCacheStats } from './services/oracleService.js';
import { logger } from './logger.js';
import { providerPool } from '@internal/aave-rpc-infra';
import { getMeritCacheStats, getTokenPriceCacheStats, getBrevisCacheStats } from '@internal/aave-fetcher';
import { explainServerListenError } from './startup.js';
import { closePool, getPool, isPersistenceEnabled } from './services/dbPool.js';
import { getPersistenceStatus, getHashMapSizes, warmConfigHashes } from './services/persistenceService.js';
import { runMigrations } from './services/autoMigrate.js';

// Limit undici globalDispatcher connection pool to cap native memory (TLS buffers)
// consumed by Node.js built-in fetch. Without this, each fetchMarketsData call
// creates ~20 GraphQL requests whose TLS connections allocate native memory
// outside V8 heap, causing steady RSS growth (~14 MB/h). Capping connections
// per host + short keep-alive prevents unbounded accumulation.
let globalAgent: Agent | undefined;
try {
  globalAgent = new Agent({
    connections: 10,
    pipelining: 1,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });
  setGlobalDispatcher(globalAgent);
} catch (e) {
  logger.warn('Failed to set undici globalDispatcher (non-fatal, using defaults):', e instanceof Error ? e.message : String(e));
}

// Wire ProviderPool logFn to winston logger
providerPool.configure({
  logFn: (level, msg, meta) => logger.log(level, msg, meta),
});
// Start periodic 30-min provider TTL cleanup so idle/low-traffic periods still
// reclaim stale viem providers (each holds a connection pool). Without this,
// cleanup only runs on the request path, and TTL eviction never fires when idle.
const stopProviderCleanup = providerPool.startCleanupTimer();

const app = express();
app.set('etag', 'weak');
// Trust Railway's single proxy layer so req.ip reflects the real client IP
// (not the load-balancer's IP). This also makes rate limiter per-IP instead of
// per-proxy (previously all users shared one bucket via the LB IP).
app.set('trust proxy', 1);
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
app.use(express.json({ limit: '256kb' }));
app.use(
  compression({
    // Keep tiny payloads uncompressed to avoid needless CPU overhead.
    threshold: 1024,
  })
);
app.use(apiCacheHeadersMiddleware);

const apiRateLimit = rateLimitMiddleware(60_000, 120);
app.use('/api/markets', apiRateLimit);
app.use('/api/meta', apiRateLimit);
app.use('/api/seo/semrush/batch', express.json({ limit: '5mb' }));

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

// Debug endpoint: trigger V8 heap snapshot (MEMORY_DIAG=1 only)
// Writes .heapsnapshot file to /app/ and returns the file path.
// Use with Chrome DevTools → Memory → Load to identify leaking JS objects.
// CAUTION: snapshot is ~50-100MB, blocks the main thread for ~2-5s.
app.get('/api/debug/heap-snapshot', (_req, res) => {
  if (process.env.MEMORY_DIAG !== '1') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const filePath = v8.writeHeapSnapshot();
    logger.info(`🔬 Heap snapshot written: ${filePath}`);
    res.json({ filePath, heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Debug endpoint: V8 heap object statistics by constructor (MEMORY_DIAG=1 only)
// Lightweight — no file I/O, just walks the heap in-process.
// Returns top N constructors by retained size, useful for identifying leaking objects.
app.get('/api/debug/heap-stats', (_req, res) => {
  if (process.env.MEMORY_DIAG !== '1') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const spaces = v8.getHeapSpaceStatistics();
    res.json({
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers ?? 0,
      },
      heapStatistics: {
        totalAvailable: heapStats.total_available_size,
        totalPhysical: heapStats.total_physical_size,
        malloced: heapStats.malloced_memory,
      },
      spaces: spaces.map(s => ({
        name: s.space_name,
        used: s.space_used_size,
        size: s.space_size,
        available: s.space_available_size,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Routes
app.use('/api/markets', marketsRouter);
app.use('/api/meta', metaRouter);
app.use('/api/seo', seoRouter);
app.use('/api/docs', swaggerRouter);

const healthHandler = (_req: express.Request, res: express.Response) => {
  const markets = getMarketsData();
  const marketsReady = markets.payload !== null;
  const marketsStale = markets.isTooStale;

  const rpcHealth = providerPool.getHealthStatus();
  const chainsWithAllSuppressed = findChainsWithAllSuppressed(rpcHealth);

  if (!marketsReady || marketsStale) {
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      markets: { ready: marketsReady, stale: marketsStale, ageMs: markets.ageMs },
      rpc: { summary: rpcHealth.summary, ...(chainsWithAllSuppressed.length > 0 ? { chainsWithAllSuppressed } : {}) },
      ...(process.env.RAILWAY_GIT_COMMIT_SHA && { commitSha: process.env.RAILWAY_GIT_COMMIT_SHA }),
    });
    return;
  }

  const status = chainsWithAllSuppressed.length > 0 ? 'suppressed' : 'ok';

  res.json({
    status,
    timestamp: new Date().toISOString(),
    ...(process.env.RAILWAY_GIT_COMMIT_SHA && { commitSha: process.env.RAILWAY_GIT_COMMIT_SHA }),
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: PORT,
    },
    rpc: { summary: rpcHealth.summary, ...(chainsWithAllSuppressed.length > 0 ? { chainsWithAllSuppressed } : {}) },
  });
};

function findChainsWithAllSuppressed(rpcHealth: { endpoints: Array<{ chainId: number; status: string }> }): number[] {
  const byChain = new Map<number, { total: number; suppressed: number }>();
  for (const ep of rpcHealth.endpoints) {
    const entry = byChain.get(ep.chainId) ?? { total: 0, suppressed: 0 };
    entry.total++;
    if (ep.status === 'suppressed') entry.suppressed++;
    byChain.set(ep.chainId, entry);
  }
  const result: number[] = [];
  for (const [chainId, counts] of byChain) {
    if (counts.suppressed > 0 && counts.suppressed === counts.total) {
      result.push(chainId);
    }
  }
  return result.sort((a, b) => a - b);
}

// Health check endpoints:
// - /health for load balancer probes
// - /api/health for API namespace consistency
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// Catch-all 404 handler — logs unmapped requests for bot/crawler monitoring.
// Must be registered AFTER all valid routes so Express only reaches it on miss.
const MAX_UA_LEN = 120;
const sanitizeForLog = (s: string) => s.replace(/[\r\n]/g, '_');
app.use((req, res) => {
  const { method, path: rawPath } = req;
  const path = sanitizeForLog(rawPath);
  const ip = req.ip ?? req.socket.remoteAddress ?? '-';
  const ua = sanitizeForLog((req.headers['user-agent'] ?? '-')).slice(0, MAX_UA_LEN);
  (logger.info as (meta: object, msg: string) => void)({ method, path, ip, ua }, '404');
  res.status(404).json({ error: 'Not found', message: `No route for ${method} ${rawPath}`, path: rawPath, method });
});

// Persistence diagnostics — exposes whether DB writes are happening on schedule.
// Useful for catching silent persistence failures (the cron writer never throws
// up the call stack, so without this endpoint a failed DB connection could go
// unnoticed for days).
// Moved under /api/seo/ to reuse SEO admin auth middleware.

// Auto-run pending DB migrations before any cron cycles start.
// Non-blocking: if DB is unreachable, the server still starts and serves
// from memory cache. A background retry attempts migration every 60s.
// Note: migrationReady only controls the retry timer — persistence cron
// uses isPoolHealthy() to guard DB writes, not this flag.
let migrationReady = false;

async function runMigrationWithWarmup(): Promise<void> {
  const migrationPool = getPool();
  await runMigrations(migrationPool);
  // Mark ready before warmConfigHashes so a warmConfigHashes failure
  // doesn't trigger unnecessary re-migration on the next retry.
  migrationReady = true;
  await warmConfigHashes();
}

if (isPersistenceEnabled()) {
  logger.info('🔄 Starting auto-migration — acquiring DB pool...');
  try {
    logger.info('🔄 DB pool acquired — running migrations...');
    await runMigrationWithWarmup();
    logger.info('🔄 Migrations complete — persistence ready');
  } catch (error) {
    logger.error('❌ Auto-migration failed — starting server anyway (DB may be unreachable). Background retry every 60s:', error);
    // Background retry: attempt migration every 60s until it succeeds.
    // Server stays up and serves from memory cache; persistence cron skips
    // via isPoolHealthy() check until DB recovers.
    let retryCount = 0;
    const MAX_RETRIES = 60; // 1h at 60s intervals — DB outages rarely exceed 5min
    const migrationRetryTimer = setInterval(async () => {
      if (migrationReady) {
        clearInterval(migrationRetryTimer);
        return;
      }
      if (++retryCount > MAX_RETRIES) {
        logger.error('🔄 Migration retry exhausted after 1h — giving up. Restart the server to retry.');
        clearInterval(migrationRetryTimer);
        return;
      }
      try {
        logger.info(`🔄 Background migration retry #${retryCount} — acquiring DB pool...`);
        await runMigrationWithWarmup();
        logger.info('🔄 Background migration succeeded — persistence ready');
        clearInterval(migrationRetryTimer);
      } catch (error) {
        logger.warn(`⚠️  Background migration retry #${retryCount} failed (will retry in 60s):`, error);
      }
}, 60_000).unref();

// Detailed heap diagnostics every 10 min (MEMORY_DIAG=1 only).
// Tracks V8 malloced_memory, external_memory, and heap space breakdown
// to distinguish V8 heap growth from native/C++ binding leaks.
if (process.env.MEMORY_DIAG === '1') {
  let diagBaseline: { heapUsed: number; rss: number; malloced: number; external: number } | null = null;
  setInterval(() => {
    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const fmt = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
    const now = { heapUsed: mem.heapUsed, rss: mem.rss, malloced: heapStats.malloced_memory, external: heapStats.external_memory };
    if (!diagBaseline) diagBaseline = { ...now };
    const d = (cur: number, base: number) => `${cur >= base ? '+' : ''}${((cur - base) / 1024 / 1024).toFixed(0)}MB`;
    logger.info(
      `🔬 Heap detail: heap=${fmt(mem.heapUsed)} rss=${fmt(mem.rss)} external=${fmt(heapStats.external_memory)} malloced=${fmt(heapStats.malloced_memory)} ` +
      `totalPhysical=${fmt(heapStats.total_physical_size)} totalAvailable=${fmt(heapStats.total_available_size)} ` +
      `| Δfrom1st: heap=${d(now.heapUsed, diagBaseline.heapUsed)} rss=${d(now.rss, diagBaseline.rss)} malloced=${d(now.malloced, diagBaseline.malloced)} external=${d(now.external, diagBaseline.external)}`
    );
  }, 10 * 60_000).unref();
}
  }
} else {
  logger.info('💾 Persistence disabled — skipping auto-migration');
  migrationReady = true;
}

// Start HTTP server immediately — healthcheck returns 503 until caches are warm.
// This avoids Railway deploy failures caused by connection-refused during cold start.
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
    stopProviderCleanup();
    globalAgent?.close().catch(() => {});
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

// Start cron scheduler immediately — independent of warmup.
// If warmup fails, cron retries on its own schedule, so the server can self-heal.
startUpdateScheduler();

const RSS_RESTART_THRESHOLD_MB = Number.parseInt(process.env.RSS_RESTART_THRESHOLD_MB ?? '', 10) || 0;

setInterval(() => {
  const mem = process.memoryUsage();
  const fmt = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
  const merklStats = getMerklForecastCacheStats();
  const onchainStats = getOnchainCacheStatus();
  const oracleStats = getOracleCacheStats();
  const meritStats = getMeritCacheStats();
  const tokenPriceStats = getTokenPriceCacheStats();
  const brevisStats = getBrevisCacheStats();
  const hashSizes = getHashMapSizes();
  const providerStats = providerPool.getCacheStats();
  const snapshots = getMarketsData();
  // Log undici connection pool stats (connected/free/running per origin)
  const undiciStats = globalAgent?.stats ?? {};
  const undiciSummary = Object.entries(undiciStats as Record<string, { connected?: number; free?: number; running?: number; queued?: number }>)
    .map(([origin, s]) => `${new URL(origin).hostname}=${s.connected ?? 0}/${s.free ?? 0}/${s.running ?? 0}`)
    .join(' ') || 'none';
  // V8 heap space breakdown (old_space is where long-lived objects accumulate)
  const heapSpaces = v8.getHeapSpaceStatistics();
  const spaceSummary = heapSpaces
    .filter(s => s.space_used_size > 1024 * 1024)
    .map(s => `${s.space_name.replace(/_space$/, '')}=${Math.round(s.space_used_size / 1024 / 1024)}/${Math.round(s.space_size / 1024 / 1024)}`)
    .join(' ');
  logger.info(
    `📊 Memory: heap=${fmt(mem.heapUsed)}/${fmt(mem.heapTotal)} rss=${fmt(mem.rss)} arrayBuffers=${fmt(mem.arrayBuffers ?? 0)} external=${fmt(v8.getHeapStatistics().external_memory)} malloced=${fmt(v8.getHeapStatistics().malloced_memory)} | ` +
    `spaces=[${spaceSummary}] ` +
    `reserves=${snapshots?.payload?.data?.length ?? 0} ` +
    `onchain=${onchainStats.poolCount}pools/${onchainStats.reserveCount}res ` +
    `oracle=${oracleStats.leanPrice}+${oracleStats.v4ReserveToken} ` +
    `merkl=${merklStats.metricsCacheSize}+${merklStats.zeroBaselineCacheSize}z+${merklStats.inFlightSize}f ` +
    `merit=${meritStats.roundEstimateCache}r+${meritStats.campaignMetadataCache}m+${meritStats.blockNumberCache}b+${meritStats.redirectAliases}a ` +
    `tokenPrice=${tokenPriceStats.priceCache}+${tokenPriceStats.inFlight}f ` +
    `brevis=${brevisStats.chainCallCache} ` +
    `hashes=${hashSizes.marketRow}+${hashSizes.marketConfig}+${hashSizes.oraclePrice} ` +
    `rpc=${providerStats.providers}p+${providerStats.endpoints}e+${providerStats.rpcUrls}u ` +
    `browser=${meritStats.browserActive} ` +
    `undici=[${undiciSummary}]`
  );

  if (RSS_RESTART_THRESHOLD_MB > 0 && mem.rss > RSS_RESTART_THRESHOLD_MB * 1024 * 1024) {
    logger.warn(
      `⚠️ RSS ${fmt(mem.rss)} exceeds threshold ${RSS_RESTART_THRESHOLD_MB}MB — no auto-restart (warn-only, investigate memory growth with cache stats above)`
    );
  }
}, 60_000).unref();

// Warm caches in background — server is already listening.
// /health returns 503 until warmup completes, then 200.
logger.info('🔄 Starting cache warmup (server already listening, health returns 503 until warm)...');

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
  })
  .catch((error) => {
    logger.error('❌ Startup warmup failed:', error);
    // Don't exit — server stays up, /health will keep returning 503
  });

// ts-prune-ignore-next
export default app;
