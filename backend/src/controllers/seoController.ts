import type { Request, Response } from 'express';
import dayjs from 'dayjs';
import { getPool, isPersistenceEnabled } from '../services/dbPool.js';
import { getGscFetchState, setGscFetchSuccess, setGscFetchFailure } from '../services/gscFetchState.js';
import { fetchAndPersistGscDaily, getGscClient } from '../services/gscService.js';
import { escapeIlike } from '../utils/escapeIlike.js';
import { logger } from '../logger.js';

const VALID_GROUP_BY = ['date', 'country', 'page', 'query'] as const;
type GroupBy = (typeof VALID_GROUP_BY)[number];

const METRIC_SELECT = `
  SUM(clicks)::int AS clicks,
  SUM(impressions)::int AS impressions,
  CASE WHEN SUM(impressions) > 0 THEN (SUM(clicks)::numeric / SUM(impressions))::numeric(8,5) ELSE 0 END AS ctr,
  CASE WHEN SUM(impressions) > 0 THEN (SUM(position * impressions) / SUM(impressions))::numeric(7,2) ELSE 0 END AS position
`;

export function parseCountryList(raw: string): string[] {
  return raw.split(',').map(c => c.trim()).filter(Boolean).slice(0, 20);
}

function buildGscQuery(groups: GroupBy[]): { sql: string; hasGroupBy: boolean } {
  if (groups.length === 0) {
    return {
      sql: `SELECT date, country, page, query, clicks, impressions, ctr, position FROM gsc_daily`,
      hasGroupBy: false,
    };
  }
  const cols = groups.join(', ');
  return {
    sql: `SELECT ${cols}, ${METRIC_SELECT} FROM gsc_daily`,
    hasGroupBy: true,
  };
}

function daysBetween(from: string, to: string): number {
  return dayjs(to).diff(dayjs(from), 'day');
}

export async function getGscData(req: Request, res: Response): Promise<void> {
  try {
    if (!isPersistenceEnabled()) {
      res.status(503).json({ error: 'Database not configured' });
      return;
    }

    const from = req.query.from as string;
    const to = req.query.to as string;
    if (!from || !to) {
      res.status(400).json({ error: 'from and to are required' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !dayjs(from).isValid()) {
      res.status(400).json({ error: 'from must be a valid YYYY-MM-DD date' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || !dayjs(to).isValid()) {
      res.status(400).json({ error: 'to must be a valid YYYY-MM-DD date' });
      return;
    }
    if (dayjs(from).isAfter(dayjs(to))) {
      res.status(400).json({ error: 'from must be <= to' });
      return;
    }

    const maxSpan = parseInt(process.env.SEO_GSC_MAX_DATE_SPAN_DAYS ?? '90', 10);
    if (daysBetween(from, to) > maxSpan) {
      res.status(400).json({ error: `Date span exceeds ${maxSpan} days` });
      return;
    }

    const groupByParam = req.query.groupBy as string | undefined;
    const groups: GroupBy[] = [];
    if (groupByParam) {
      for (const g of groupByParam.split(',')) {
        if (!VALID_GROUP_BY.includes(g as GroupBy)) {
          res.status(400).json({ error: `Invalid groupBy: ${g}` });
          return;
        }
        groups.push(g as GroupBy);
      }
    }

    const pool = getPool();
    const { sql, hasGroupBy } = buildGscQuery(groups);

    const conditions: string[] = ['date >= $1', 'date <= $2'];
    const params: unknown[] = [from, to];
    let paramIdx = 3;

    const country = req.query.country as string | undefined;
    if (country) {
      const countries = parseCountryList(country);
      conditions.push(`country = ANY($${paramIdx}::text[])`);
      params.push(countries);
      paramIdx++;
    }

    const page = req.query.page as string | undefined;
    if (page) {
      conditions.push(`page = $${paramIdx}`);
      params.push(page);
      paramIdx++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    let fullSql = `${sql} ${where}`;

    if (hasGroupBy) {
      fullSql += ` GROUP BY ${groups.join(', ')}`;
      fullSql += ` ORDER BY ${groups[0]} DESC`;
    }

    fullSql += ` LIMIT 10000`;

    const result = await pool.query(fullSql, params);
    res.json(result.rows);
  } catch (error) {
    logger.error(`GSC query failed: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getSemrushSnapshots(req: Request, res: Response): Promise<void> {
  try {
    if (!isPersistenceEnabled()) {
      res.status(503).json({ error: 'Database not configured' });
      return;
    }

    const pool = getPool();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    const country = req.query.country as string | undefined;
    if (country) {
      const countries = parseCountryList(country);
      conditions.push(`country = ANY($${paramIdx}::text[])`);
      params.push(countries);
      paramIdx++;
    }

    const keyword = req.query.keyword as string | undefined;
    if (keyword) {
      conditions.push(`keyword ILIKE $${paramIdx}`);
      params.push(`%${escapeIlike(keyword)}%`);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, snapshot_date, country, keyword, volume, position, cpc_usd, difficulty, notes, created_at
       FROM semrush_snapshots ${where} ORDER BY snapshot_date DESC, keyword LIMIT 10000`,
      params,
    );
    res.json(result.rows);
  } catch (error) {
    logger.error(`Semrush query failed: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function upsertSemrushSnapshot(req: Request, res: Response): Promise<void> {
  try {
    if (!isPersistenceEnabled()) {
      res.status(503).json({ error: 'Database not configured' });
      return;
    }

    const { snapshot_date, country, keyword, volume, position, cpc_usd, difficulty, notes } = req.body;
    if (!snapshot_date || !country || !keyword) {
      res.status(400).json({ error: 'snapshot_date, country, keyword are required' });
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO semrush_snapshots (snapshot_date, country, keyword, volume, position, cpc_usd, difficulty, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (snapshot_date, country, keyword) DO UPDATE SET
         volume = EXCLUDED.volume, position = EXCLUDED.position,
         cpc_usd = EXCLUDED.cpc_usd, difficulty = EXCLUDED.difficulty,
         notes = EXCLUDED.notes, created_at = now()
       RETURNING *`,
      [snapshot_date, country, keyword, volume ?? null, position ?? null, cpc_usd ?? null, difficulty ?? null, notes ?? null],
    );
    res.json(result.rows[0]);
  } catch (error) {
    logger.error(`Semrush upsert failed: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: 'Internal server error' });
  }
}

const BATCH_RATE_LIMIT_WINDOW_MS = 60_000;
const BATCH_RATE_LIMIT_MAX = 5;
const batchRateMap = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of batchRateMap) {
    if (now - entry.windowStart > BATCH_RATE_LIMIT_WINDOW_MS) {
      batchRateMap.delete(key);
    }
  }
}, BATCH_RATE_LIMIT_WINDOW_MS).unref();

function checkBatchRateLimit(token: string): boolean {
  const now = Date.now();
  const entry = batchRateMap.get(token);
  if (!entry || now - entry.windowStart > BATCH_RATE_LIMIT_WINDOW_MS) {
    batchRateMap.set(token, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= BATCH_RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

export async function batchUpsertSemrushSnapshots(req: Request, res: Response): Promise<void> {
  try {
    if (!isPersistenceEnabled()) {
      res.status(503).json({ error: 'Database not configured' });
      return;
    }

    const token = req.headers['x-admin-token'] as string ?? '';
    if (!checkBatchRateLimit(token)) {
      res.status(429).json({ error: 'Batch rate limit exceeded (5 per minute)' });
      return;
    }

    const { snapshots } = req.body;
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      res.status(400).json({ error: 'snapshots must be a non-empty array' });
      return;
    }
    if (snapshots.length > 5000) {
      res.status(400).json({ error: 'Batch size exceeds 5000' });
      return;
    }

    for (const s of snapshots) {
      if (!s.snapshot_date || !s.country || !s.keyword) {
        res.status(400).json({ error: 'Each snapshot requires snapshot_date, country, keyword' });
        return;
      }
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const dates: string[] = [];
      const countries: string[] = [];
      const keywords: string[] = [];
      const volumes: (number | null)[] = [];
      const positions: (number | null)[] = [];
      const cpcUsds: (number | null)[] = [];
      const difficulties: (number | null)[] = [];
      const notesList: (string | null)[] = [];

      for (const s of snapshots) {
        dates.push(s.snapshot_date);
        countries.push(s.country);
        keywords.push(s.keyword);
        volumes.push(s.volume ?? null);
        positions.push(s.position ?? null);
        cpcUsds.push(s.cpc_usd ?? null);
        difficulties.push(s.difficulty ?? null);
        notesList.push(s.notes ?? null);
      }

      const result = await client.query(
        `INSERT INTO semrush_snapshots (snapshot_date, country, keyword, volume, position, cpc_usd, difficulty, notes)
         SELECT * FROM UNNEST($1::date[], $2::text[], $3::text[], $4::int[], $5::numeric[], $6::numeric[], $7::numeric[], $8::text[])
         ON CONFLICT (snapshot_date, country, keyword) DO UPDATE SET
           volume = EXCLUDED.volume, position = EXCLUDED.position,
           cpc_usd = EXCLUDED.cpc_usd, difficulty = EXCLUDED.difficulty,
           notes = EXCLUDED.notes, created_at = now()`,
        [dates, countries, keywords, volumes, positions, cpcUsds, difficulties, notesList],
      );

      await client.query('COMMIT');
      res.json({ upserted: result.rowCount ?? 0, total: snapshots.length });
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error(`Semrush batch upsert failed: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteSemrushSnapshot(req: Request, res: Response): Promise<void> {
  try {
    if (!isPersistenceEnabled()) {
      res.status(503).json({ error: 'Database not configured' });
      return;
    }

    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    const pool = getPool();
    const result = await pool.query('DELETE FROM semrush_snapshots WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ deleted: true });
  } catch (error) {
    logger.error(`Semrush delete failed: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export function getSeoStatus(_req: Request, res: Response): void {
  res.json({ gsc: getGscFetchState() });
}

export async function triggerGscFetch(req: Request, res: Response): Promise<void> {
  if (!process.env.GSC_SA_EMAIL) {
    res.status(503).json({ error: 'GSC_SA_EMAIL not configured — GSC fetch is disabled' });
    return;
  }
  const overrideSiteUrl = req.body?.siteUrl as string | undefined;
  const overrideDaysAgo = req.body?.daysAgo as number | undefined;
  const originalSiteUrl = process.env.GSC_SITE_URL;
  if (overrideSiteUrl) {
    process.env.GSC_SITE_URL = overrideSiteUrl;
  }
  try {
    const pool = getPool();
    const targetDate = overrideDaysAgo
      ? dayjs().subtract(overrideDaysAgo, 'day').format('YYYY-MM-DD')
      : undefined;
    const result = targetDate
      ? await fetchAndPersistGscDaily(pool, targetDate)
      : await fetchAndPersistGscDaily(pool);
    setGscFetchSuccess(result);
    res.json({ ok: true, siteUrl: process.env.GSC_SITE_URL, ...result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setGscFetchFailure(msg);
    logger.error(`GSC manual trigger failed: ${msg}`);
    res.status(500).json({ error: msg });
  } finally {
    if (overrideSiteUrl) {
      process.env.GSC_SITE_URL = originalSiteUrl;
    }
  }
}

export async function listGscSites(_req: Request, res: Response): Promise<void> {
  if (!process.env.GSC_SA_EMAIL) {
    res.status(503).json({ error: 'GSC_SA_EMAIL not configured' });
    return;
  }
  try {
    const webmasters = getGscClient();
    const sites = await webmasters.sites.list({});
    res.json(sites.data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
}

export { buildGscQuery, VALID_GROUP_BY };
