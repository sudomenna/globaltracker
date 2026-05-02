-- Migration: 0022_metabase_views
-- T-4-007 — Metabase analytics views
-- Creates regular (non-materialized) views for the Metabase performance dashboard.
-- Metabase connects directly to Postgres and reads these views as tables.
--
-- Views created:
--   daily_funnel_rollup      — event counts per day / workspace / launch / event_name
--   ad_performance_rollup    — ad spend joined with Purchase conversion metrics and ROAS
--   dispatch_health_view     — dispatch job health per workspace / destination / status
--
-- Depends on:
--   0010_ad_spend_daily_table.sql   (ad_spend_daily table)
--   0018_event_tables.sql           (events table)
--   0019_dispatch_tables.sql        (dispatch_jobs table)
--
-- NOTE: These are CREATE OR REPLACE VIEW (regular views, not materialized).
--   No additional indexes or RLS policies are needed — views inherit the underlying
--   tables' RLS when queried in a session with app.current_workspace_id set.
--   Metabase service account must have SELECT granted on these views.

-- ============================================================
-- View: daily_funnel_rollup
-- Aggregates event counts per calendar day, workspace, launch, and event_name.
-- Used by Metabase funnel and trend charts.
-- References: events.received_at (partition key), events.workspace_id,
--             events.launch_id, events.event_name, events.lead_id
-- ============================================================
CREATE OR REPLACE VIEW daily_funnel_rollup AS
SELECT
  date_trunc('day', e.received_at)        AS day,
  e.workspace_id,
  e.launch_id,
  e.event_name,
  COUNT(*)                                AS event_count,
  COUNT(DISTINCT e.lead_id)               AS unique_leads
FROM events e
GROUP BY 1, 2, 3, 4;

-- ============================================================
-- View: ad_performance_rollup
-- Joins ad_spend_daily with Purchase event aggregates for the same
-- day / workspace / launch combination.
-- Computes cost_per_lead_cents and ROAS when data is available.
--
-- cost_per_lead_cents: spend_cents_normalized / unique Purchase leads
--   NULL when there are no unique converters (avoids division by zero).
-- roas: revenue_cents / spend_cents_normalized
--   NULL when spend is zero or no revenue recorded.
--
-- revenue_cents is derived from events.custom_data->>'value' (numeric, assumed
--   to be in the same currency unit; multiplied by 100 to convert to cents).
--   NULL custom_data->>'value' rows are excluded from the SUM via FILTER.
--
-- BR-COST-001: spend_cents_normalized may be NULL until FX cron runs; those
--   rows appear in the view with NULL cost_per_lead_cents and NULL roas.
-- ============================================================
CREATE OR REPLACE VIEW ad_performance_rollup AS
SELECT
  a.date,
  a.workspace_id,
  a.launch_id,
  a.platform,
  a.account_id,
  a.campaign_id,
  a.granularity,
  a.spend_cents_normalized,
  a.currency                                              AS original_currency,
  a.fx_rate,
  a.impressions,
  a.clicks,
  COALESCE(f.event_count, 0)                             AS conversions,
  COALESCE(f.unique_leads, 0)                            AS unique_converters,
  CASE
    WHEN COALESCE(f.unique_leads, 0) > 0
    THEN a.spend_cents_normalized::numeric / f.unique_leads
    ELSE NULL
  END                                                    AS cost_per_lead_cents,
  CASE
    WHEN a.spend_cents_normalized > 0 AND f.revenue_cents > 0
    THEN f.revenue_cents::numeric / a.spend_cents_normalized
    ELSE NULL
  END                                                    AS roas
FROM ad_spend_daily a
LEFT JOIN (
  SELECT
    date_trunc('day', e.received_at)::date                               AS day,
    e.workspace_id,
    e.launch_id,
    COUNT(*)           FILTER (WHERE e.event_name = 'Purchase')          AS event_count,
    COUNT(DISTINCT e.lead_id)
                       FILTER (WHERE e.event_name = 'Purchase')          AS unique_leads,
    SUM((e.custom_data->>'value')::numeric * 100)
                       FILTER (WHERE e.event_name = 'Purchase'
                                 AND e.custom_data->>'value' IS NOT NULL) AS revenue_cents
  FROM events e
  GROUP BY 1, 2, 3
) f ON  f.day           = a.date
    AND f.workspace_id  = a.workspace_id
    AND f.launch_id     = a.launch_id;

-- ============================================================
-- View: dispatch_health_view
-- Summarises dispatch job status per workspace and destination.
-- Used by Metabase integration health / alerting dashboards.
-- avg_attempts is the mean attempt_count across all jobs in the group.
-- last_updated is the most recent updated_at in the group.
-- ============================================================
CREATE OR REPLACE VIEW dispatch_health_view AS
SELECT
  workspace_id,
  destination,
  status,
  COUNT(*)               AS job_count,
  AVG(attempt_count)     AS avg_attempts,
  MAX(updated_at)        AS last_updated
FROM dispatch_jobs
GROUP BY 1, 2, 3;

-- Down:
-- DROP VIEW IF EXISTS dispatch_health_view;
-- DROP VIEW IF EXISTS ad_performance_rollup;
-- DROP VIEW IF EXISTS daily_funnel_rollup;
