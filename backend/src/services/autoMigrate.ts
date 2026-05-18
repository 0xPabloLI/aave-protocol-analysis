import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { logger } from '../logger.js';

const MIGRATIONS_DIR = join(
  fileURLToPath(import.meta.url),
  '..', '..', '..', 'migrations'
);

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

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    logger.info(`Running migration: ${file}`);

    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      appliedCount++;
      logger.info(`Migration ${file} applied`);
    } catch (error) {
      logger.error(`Migration ${file} failed:`, error);
      throw error;
    }
  }

  if (appliedCount > 0) {
    logger.info(`${appliedCount} migration(s) applied successfully`);
  }
}