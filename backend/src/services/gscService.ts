import { google } from 'googleapis';
import dayjs from 'dayjs';
import type { Pool } from 'pg';
import { logger } from '../logger.js';

const ROW_LIMIT = 25000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 500;
const GSC_DELAY_DAYS = 3;

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

let cachedClient: ReturnType<typeof google.webmasters> | null = null;

function getGscClient() {
  if (cachedClient) return cachedClient;
  const auth = new google.auth.JWT({
    email: process.env.GSC_SA_EMAIL,
    key: process.env.GSC_SA_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  cachedClient = google.webmasters({ version: 'v3', auth });
  return cachedClient;
}

async function fetchGscRows(targetDate: string, dataState: 'final' | 'all' = 'final', siteUrl?: string): Promise<GscRow[]> {
  const webmasters = getGscClient();
  const allRows: GscRow[] = [];
  let startRow = 0;
  const resolvedSiteUrl = siteUrl ?? process.env.GSC_SITE_URL!;

  for (;;) {
    const params = {
      siteUrl: resolvedSiteUrl,
      requestBody: {
        startDate: targetDate,
        endDate: targetDate,
        dimensions: ['country', 'page', 'query'],
        rowLimit: ROW_LIMIT,
        startRow,
        dataState,
      },
    };

    let data: { rows?: GscRow[] } | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await webmasters.searchanalytics.query(params);
        data = res.data as { rows?: GscRow[] } | undefined;
        break;
      } catch (err: unknown) {
        const status = (err as { code?: number }).code ?? 0;
        if ((status === 429 || status >= 500) && attempt < MAX_RETRIES) {
          const delayMs = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }

    const batch = data?.rows ?? [];
    allRows.push(...batch);
    if (batch.length < ROW_LIMIT) break;
    startRow += ROW_LIMIT;
  }

  return allRows;
}

async function upsertGscRows(pool: Pool, targetDate: string, rows: GscRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const validRows = rows.filter(row => {
    if (row.keys.length < 3) {
      logger.warn(`GSC row skipped: keys.length=${row.keys.length}, expected 3`);
      return false;
    }
    return true;
  });

  if (validRows.length === 0) return 0;
  let totalUpserted = 0;

  for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
    const chunk = validRows.slice(i, i + BATCH_SIZE);
    const dates: string[] = [];
    const countries: string[] = [];
    const pages: string[] = [];
    const queries: string[] = [];
    const clicks: number[] = [];
    const impressions: number[] = [];
    const ctrs: number[] = [];
    const positions: number[] = [];

    for (const row of chunk) {
      dates.push(targetDate);
      countries.push(row.keys[0]);
      pages.push(row.keys[1]);
      queries.push(row.keys[2]);
      clicks.push(row.clicks);
      impressions.push(row.impressions);
      ctrs.push(row.ctr);
      positions.push(row.position);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO gsc_daily (date, country, page, query, clicks, impressions, ctr, position)
         SELECT * FROM UNNEST($1::date[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::numeric[], $8::numeric[])
         ON CONFLICT (date, country, page, query) DO UPDATE SET
           clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
           ctr = EXCLUDED.ctr, position = EXCLUDED.position, fetched_at = now()`,
        [dates, countries, pages, queries, clicks, impressions, ctrs, positions],
      );
      await client.query('COMMIT');
      totalUpserted += result.rowCount ?? 0;
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }
  }

  return totalUpserted;
}

export async function fetchAndPersistGscDaily(pool: Pool, targetDateOverride?: string, dataState: 'final' | 'all' = 'final', siteUrl?: string): Promise<{ targetDate: string; rowsUpserted: number }> {
  const targetDate = targetDateOverride ?? dayjs().subtract(GSC_DELAY_DAYS, 'day').format('YYYY-MM-DD');
  const rows = await fetchGscRows(targetDate, dataState, siteUrl);
  const rowsUpserted = await upsertGscRows(pool, targetDate, rows);
  logger.info(`GSC fetch: date=${targetDate}, rows=${rows.length}, upserted=${rowsUpserted}`);
  return { targetDate, rowsUpserted };
}

function setGscClientForTest(client: ReturnType<typeof google.webmasters>) {
  cachedClient = client;
}

export { fetchGscRows, upsertGscRows, getGscClient, setGscClientForTest };
export type { GscRow };
