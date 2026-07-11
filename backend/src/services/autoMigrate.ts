import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { logger } from '../logger.js';

const MIGRATIONS_DIR = join(
  fileURLToPath(import.meta.url),
  '..', '..', '..', 'migrations'
);

function stripTransactionWrappers(sql: string): string {
  return sql
    .split('\n')
    .filter(line => {
      const trimmed = line.trim().toUpperCase();
      return trimmed !== 'BEGIN;' && trimmed !== 'COMMIT;';
    })
    .join('\n');
}

const SQUASH_MIGRATION = '001_init_schema.sql';
const PRE_SQUASH_PREFIXES = ['001_', '002_', '003_', '004_', '005_', '006_', '007_', '008_', '009_', '010_', '012_', '013_', '014_', '015_'];

export async function runMigrations(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = new Set(
    (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r: any) => r.filename)
  );

  await reconcileSquashMigrations(pool, applied);

  if (!existsSync(MIGRATIONS_DIR)) {
    logger.warn(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    return;
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  logger.info(`Found ${files.length} migration(s) in ${MIGRATIONS_DIR}`);

  let appliedCount = 0;

  for (const file of files) {
    if (applied.has(file)) {
      logger.info(`Skipping already applied migration: ${file}`);
      continue;
    }

    const rawSql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    const sql = stripTransactionWrappers(rawSql);
    logger.info(`Running migration: ${file}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      appliedCount++;
      logger.info(`Migration ${file} applied`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${file} failed — aborting remaining migrations. Fix the migration and restart. Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }

  if (appliedCount > 0) {
    logger.info(`${appliedCount} migration(s) applied successfully`);
  }
}

async function reconcileSquashMigrations(pool: pg.Pool, applied: Set<string>): Promise<void> {
  if (applied.has(SQUASH_MIGRATION)) return;

  const preSquashApplied = [...applied].filter(f =>
    PRE_SQUASH_PREFIXES.some(p => f.startsWith(p))
  );

  if (preSquashApplied.length === 0) return;

  logger.info(`Squash reconciliation: replacing ${preSquashApplied.length} pre-squash migration record(s) with ${SQUASH_MIGRATION}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of preSquashApplied) {
      await client.query('DELETE FROM schema_migrations WHERE filename = $1', [f]);
    }
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [SQUASH_MIGRATION]);
    await client.query('COMMIT');
    for (const f of preSquashApplied) {
      applied.delete(f);
    }
    applied.add(SQUASH_MIGRATION);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`Squash reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    client.release();
  }
}
