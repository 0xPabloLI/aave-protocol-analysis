import { google } from 'googleapis';
import dayjs from 'dayjs';
import type { Pool } from 'pg';
import { logger } from '../logger.js';
import { setGscFetchSuccess, setGscFetchFailure } from './gscFetchState.js';

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

async function getGscClient() {
  const auth = new google.auth.JWT({
    email: process.env.GSC_SA_EMAIL,
    key: process.env.GSC_SA_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return google.webmasters({ version: 'v3', auth });
}

async function fetchGscRows(targetDate: string): Promise<GscRow[]> {
  const webmasters = await getGscClient();
  const allRows: GscRow[] = [];
  let startRow = 0;

  for (;;) {
    const params = {
      siteUrl: process.env.GSC_SITE_URL!,
      requestBody: {
        startDate: targetDate,
        endDate: targetDate,
        dimensions: ['country', 'page', 'query'],
        rowLimit: ROW_LIMIT,
        startRow,
        dataState: 'final' as const,
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
  let totalUpserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
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
      countries.push(row.keys[0] ?? '');
      pages.push(row.keys[1] ?? '');
      queries.push(row.keys[2] ?? '');
      clicks.push(row.clicks);
      impressions.push(row.impressions);
      ctrs.push(row.ctr);
      positions.push(row.position);
    }

    const result = await pool.query(
      `INSERT INTO gsc_daily (date, country, page, query, clicks, impressions, ctr, position)
       SELECT * FROM UNNEST($1::date[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::numeric[], $8::numeric[])
       ON CONFLICT (date, country, page, query) DO UPDATE SET
         clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
         ctr = EXCLUDED.ctr, position = EXCLUDED.position, fetched_at = now()`,
      [dates, countries, pages, queries, clicks, impressions, ctrs, positions],
    );
    totalUpserted += result.rowCount ?? 0;
  }

  return totalUpserted;
}

export async function fetchAndPersistGscDaily(pool: Pool): Promise<{ targetDate: string; rowsUpserted: number }> {
  const targetDate = dayjs().subtract(GSC_DELAY_DAYS, 'day').format('YYYY-MM-DD');
  const rows = await fetchGscRows(targetDate);
  const rowsUpserted = await upsertGscRows(pool, targetDate, rows);
  setGscFetchSuccess({ targetDate, rowsUpserted });
  logger.info(`GSC fetch: date=${targetDate}, rows=${rows.length}, upserted=${rowsUpserted}`);
  return { targetDate, rowsUpserted };
}

export { fetchGscRows, upsertGscRows };
export type { GscRow };
