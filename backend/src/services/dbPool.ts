/**
 * Postgres connection pool for persistence service.
 *
 * Lazily initialised: callers should always go through `getPool()`. If
 * `DATABASE_URL` is not set, `getPool()` throws — `persistenceService` checks
 * `isPersistenceEnabled()` first so the absence of the env var is treated as
 * "persistence disabled" rather than a recurring error.
 *
 * Pool max=3: persistence cron (~1 conn/min) + SEO admin直查 (QPS<1) + GSC batch write (brief).
 * GSC cron uses batch UPSERT, avoiding long-held connections.
 * Reduced from 5 to 3 to save native memory (each SSL conn ~5-10MB) in 1GB container.
 */
import pg from 'pg';
import { logger } from '../logger.js';

const { Pool } = pg;
type PoolType = pg.Pool;

let pool: PoolType | null = null;
let poolClosed = false;

/**
 * DB-unreachable backoff: after a pool error, reject query attempts for 60s
 * to prevent TCP socket + SSL buffer accumulation in RSS (each failed connect
 * attempt allocates ~5-10MB native memory that lingers until OS reclaims it).
 *
 * Without this, a crashed Postgres causes the cron scheduler to retry every
 * minute, each retry burning a 5s connectionTimeoutMillis socket — resulting
 * in 300-600MB RSS growth per hour.
 */
const POOL_BACKOFF_MS = 60_000;
let lastPoolErrorTime = 0;

export function isPoolHealthy(): boolean {
  if (poolClosed) return false;
  if (Date.now() - lastPoolErrorTime < POOL_BACKOFF_MS) return false;
  return true;
}

export function markPoolUnhealthy(): void {
  lastPoolErrorTime = Date.now();
}

// ts-prune-ignore-next — used in tests only
export function resetPoolHealth(): void {
  lastPoolErrorTime = 0;
}

/**
 * Returns true when the env is configured for persistence.
 * Cheap check used to short-circuit the persist path.
 */
export function isPersistenceEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Decide whether to enable TLS for the pg client.
 *
 * - `DATABASE_SSL=true` → enable SSL, accept self-signed certs.
 * - `DATABASE_SSL=false` → disable SSL entirely.
 * - Not set → enable SSL with self-signed certs for remote hosts;
 *   disable SSL for localhost only.
 *
 * No domain-based guessing: the env var is the single source of truth
 * for non-localhost connections. This avoids mismatches with Railway
 * templates that enforce SSL (e.g. postgres-ssl).
 */
function resolveSslConfig(connectionString: string): pg.PoolConfig['ssl'] {
  const explicit = process.env.DATABASE_SSL?.toLowerCase();
  if (explicit === 'true') return { rejectUnauthorized: false };
  if (explicit === 'false') return undefined;

  // Localhost: SSL typically not configured.
  if (/@(localhost|127\.0\.0\.1)/i.test(connectionString)) return undefined;

  // Remote: default to SSL with self-signed cert acceptance.
  return { rejectUnauthorized: false };
}

export function getPool(): PoolType {
  if (poolClosed) {
    throw new Error('Database pool has been closed (process is shutting down)');
  }
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required for database persistence');
  }

  pool = new Pool({
    connectionString,
    ssl: resolveSslConfig(connectionString),
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    lastPoolErrorTime = Date.now();
    logger.error('Unexpected database pool error:', err);
  });

  return pool;
}

/**
 * Execute a DB operation with automatic unhealthy marking on failure.
 * Wraps pool.query() calls so all DB consumers benefit from the backoff
 * without manually calling markPoolUnhealthy() in every catch block.
 */
export async function queryWithHealthTracking<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  try {
    return await p.query<T>(text, params);
  } catch (error) {
    lastPoolErrorTime = Date.now();
    throw error;
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  poolClosed = true;
  const p = pool;
  pool = null;
  try {
    await p.end();
  } catch (error) {
    logger.warn('Error while closing database pool:', error);
  }
}
