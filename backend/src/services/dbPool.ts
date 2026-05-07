/**
 * Postgres connection pool for persistence service.
 *
 * Lazily initialised: callers should always go through `getPool()`. If
 * `DATABASE_URL` is not set, `getPool()` throws — `persistenceService` checks
 * `isPersistenceEnabled()` first so the absence of the env var is treated as
 * "persistence disabled" rather than a recurring error.
 */
import pg from 'pg';
import { logger } from '../logger.js';

const { Pool } = pg;
type PoolType = pg.Pool;

let pool: PoolType | null = null;
let poolClosed = false;

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
 * - Railway internal network (`*.railway.internal`) does NOT support TLS.
 * - Public Railway endpoints (`*.proxy.rlwy.net`, `*.railway.app`) require TLS
 *   with a self-signed cert; we accept it via `rejectUnauthorized: false`.
 * - Allow explicit override via `DATABASE_SSL=true|false`.
 */
function resolveSslConfig(connectionString: string): pg.PoolConfig['ssl'] {
  const explicit = process.env.DATABASE_SSL?.toLowerCase();
  if (explicit === 'true') return { rejectUnauthorized: false };
  if (explicit === 'false') return undefined;

  if (/\.railway\.internal/i.test(connectionString)) return undefined;
  if (/\.proxy\.rlwy\.net|\.railway\.app/i.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  // Localhost / unknown host: default off.
  if (/@(localhost|127\.0\.0\.1)/i.test(connectionString)) return undefined;
  return undefined;
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
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    logger.error('Unexpected database pool error:', err);
  });

  return pool;
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
