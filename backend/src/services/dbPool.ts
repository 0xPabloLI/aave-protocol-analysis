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
