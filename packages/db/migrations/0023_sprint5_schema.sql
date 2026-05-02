-- Migration: 0023_sprint5_schema
-- T-5-001 — Audience auto-demote column + multi-touch attribution views
--
-- Part A: Add auto_demoted_at to audiences table
--   BR-AUDIENCE-001: documents the moment the system downgraded destination_strategy
--   to 'disabled_not_eligible' after Google returned CUSTOMER_NOT_ALLOWLISTED (ADR-012).
--   INV-AUDIENCE-004: auto_demoted_at is non-null IFF destination_strategy = 'disabled_not_eligible'
--   due to a Google auto-demote (service layer enforces invariant).
--
-- Part B: View v_lead_attribution_summary
--   Multi-touch attribution summary per (workspace_id, launch_id, lead_id).
--   Aggregates first-touch, last-touch and all-touch rows from lead_attributions.
--
-- Part C: View v_audience_sync_health
--   Audience sync job health summary per (workspace_id, audience_id).
--   Joins audience_sync_jobs with audiences to expose strategy and auto-demote state.
--
-- Depends on:
--   0018_event_tables.sql   (lead_attributions table)
--   0021_workspace_integrations.sql (audiences table, audience_sync_jobs table)

-- ============================================================
-- Part A — audiences.auto_demoted_at
-- ============================================================

-- BR-AUDIENCE-001: auto_demoted_at is nullable; set by the auto-demote handler
-- when Google returns CUSTOMER_NOT_ALLOWLISTED and destination_strategy is
-- downgraded to 'disabled_not_eligible'.
ALTER TABLE audiences ADD COLUMN IF NOT EXISTS auto_demoted_at TIMESTAMPTZ;

-- ============================================================
-- Part B — View: v_lead_attribution_summary
-- Aggregates first-touch, last-touch and all-touch rows from lead_attributions
-- into a single summary row per (workspace_id, launch_id, lead_id).
--
-- first_touch_* / last_touch_*: UTM dimensions from the respective touch rows.
--   MAX() with FILTER is used because each (workspace_id, launch_id, lead_id)
--   has at most one 'first' and one 'last' row (enforced by partial unique indexes).
-- all_touch_count: number of 'all' rows — represents every raw touch recorded.
-- has_google_click / has_meta_click: boolean shortcuts for audience segment queries.
-- ============================================================
CREATE OR REPLACE VIEW v_lead_attribution_summary AS
SELECT
  la.workspace_id,
  la.launch_id,
  la.lead_id,
  MAX(la.source)    FILTER (WHERE la.touch_type = 'first') AS first_touch_source,
  MAX(la.medium)    FILTER (WHERE la.touch_type = 'first') AS first_touch_medium,
  MAX(la.campaign)  FILTER (WHERE la.touch_type = 'first') AS first_touch_campaign,
  MAX(la.ts)        FILTER (WHERE la.touch_type = 'first') AS first_touch_at,
  MAX(la.source)    FILTER (WHERE la.touch_type = 'last')  AS last_touch_source,
  MAX(la.medium)    FILTER (WHERE la.touch_type = 'last')  AS last_touch_medium,
  MAX(la.campaign)  FILTER (WHERE la.touch_type = 'last')  AS last_touch_campaign,
  MAX(la.ts)        FILTER (WHERE la.touch_type = 'last')  AS last_touch_at,
  COUNT(*)          FILTER (WHERE la.touch_type = 'all')   AS all_touch_count,
  BOOL_OR(la.gclid IS NOT NULL)  AS has_google_click,
  BOOL_OR(la.fbclid IS NOT NULL) AS has_meta_click
FROM lead_attributions la
GROUP BY la.workspace_id, la.launch_id, la.lead_id;

-- ============================================================
-- Part C — View: v_audience_sync_health
-- Summarises audience_sync_jobs per (workspace_id, audience_id), joined with
-- the audiences table to expose name, platform, destination strategy and
-- auto-demote state.
--
-- succeeded_count / failed_count / pending_count: job status breakdown.
-- last_succeeded_at: most recent successful sync finish time.
-- total_additions / total_removals: cumulative member deltas across all jobs.
-- auto_demoted_at: propagated from audiences — non-null signals demoted state.
-- ============================================================
CREATE OR REPLACE VIEW v_audience_sync_health AS
SELECT
  asj.workspace_id,
  asj.audience_id,
  a.name                AS audience_name,
  a.platform,
  a.destination_strategy,
  a.auto_demoted_at,
  COUNT(*) FILTER (WHERE asj.status = 'succeeded') AS succeeded_count,
  COUNT(*) FILTER (WHERE asj.status = 'failed')    AS failed_count,
  COUNT(*) FILTER (WHERE asj.status = 'pending')   AS pending_count,
  MAX(asj.finished_at)  FILTER (WHERE asj.status = 'succeeded') AS last_succeeded_at,
  SUM(asj.sent_additions)  AS total_additions,
  SUM(asj.sent_removals)   AS total_removals
FROM audience_sync_jobs asj
JOIN audiences a ON a.id = asj.audience_id
GROUP BY asj.workspace_id, asj.audience_id, a.name, a.platform,
         a.destination_strategy, a.auto_demoted_at;

-- Down:
-- DROP VIEW IF EXISTS v_audience_sync_health;
-- DROP VIEW IF EXISTS v_lead_attribution_summary;
-- ALTER TABLE audiences DROP COLUMN IF EXISTS auto_demoted_at;
