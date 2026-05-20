-- Step 5a: Create views that derive campaign history and APR observations
-- from the incentive_details JSONB in market_snapshots.
-- After verifying business equivalence, migration 012 will DROP the physical tables + columns.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/011_create_campaign_views.sql

BEGIN;

CREATE OR REPLACE VIEW v_campaign_history AS
WITH expanded AS (
  SELECT ms.reserve_id, ms.snapshot_ts,
         src.source, src.side,
         (entry->>'key')        AS campaign_key,
         entry                   AS campaign_data
  FROM market_snapshots ms
  CROSS JOIN LATERAL (
    VALUES
      ('merit', 'supply',  ms.incentive_details->'meritSupplys'),
      ('merit', 'borrow',  ms.incentive_details->'meritBorrows'),
      ('merkl', 'supply',  ms.incentive_details->'merklSupplys'),
      ('merkl', 'borrow',  ms.incentive_details->'merklBorrows'),
      ('merkl', 'hold',    ms.incentive_details->'merklHolds'),
      ('brevis','supply',  ms.incentive_details->'brevisSupplys'),
      ('brevis','borrow',  ms.incentive_details->'brevisBorrows')
  ) AS src(source, side, group_arr)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_arr, '[]'::jsonb)) AS grp
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN src.source = 'merit'
         THEN jsonb_build_array(grp)
         ELSE COALESCE(grp->'breakdowns', '[]'::jsonb)
    END
  ) AS entry
  WHERE ms.incentive_details IS NOT NULL
)
SELECT reserve_id, source, side, campaign_key,
       MIN(snapshot_ts) AS first_seen_at,
       MAX(snapshot_ts) AS last_seen_at,
       (array_agg(campaign_data ORDER BY snapshot_ts DESC))[1] AS latest_data
FROM expanded
GROUP BY reserve_id, source, side, campaign_key;

CREATE OR REPLACE VIEW v_campaign_apr_observations AS
WITH expanded AS (
  SELECT ms.reserve_id, ms.snapshot_ts,
         src.source, src.side,
         (entry->>'key')        AS campaign_key,
         entry                   AS campaign_data
  FROM market_snapshots ms
  CROSS JOIN LATERAL (
    VALUES
      ('merit', 'supply',  ms.incentive_details->'meritSupplys'),
      ('merit', 'borrow',  ms.incentive_details->'meritBorrows'),
      ('merkl', 'supply',  ms.incentive_details->'merklSupplys'),
      ('merkl', 'borrow',  ms.incentive_details->'merklBorrows'),
      ('merkl', 'hold',    ms.incentive_details->'merklHolds'),
      ('brevis','supply',  ms.incentive_details->'brevisSupplys'),
      ('brevis','borrow',  ms.incentive_details->'brevisBorrows')
  ) AS src(source, side, group_arr)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_arr, '[]'::jsonb)) AS grp
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN src.source = 'merit'
         THEN jsonb_build_array(grp)
         ELSE COALESCE(grp->'breakdowns', '[]'::jsonb)
    END
  ) AS entry
  WHERE ms.incentive_details IS NOT NULL
)
SELECT reserve_id, source, side, campaign_key,
       snapshot_ts AS observed_at,
       (campaign_data->>'apr')::numeric AS apr
FROM expanded
ORDER BY reserve_id, source, side, campaign_key, snapshot_ts;

COMMIT;
