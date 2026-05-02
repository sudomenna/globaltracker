-- Migration: 0026_test_mode_replay
-- T-8-001: Sprint 8 — test mode flag + replay lineage
--
-- BR-PRIVACY-001: is_test is not PII; no special access restriction required.
-- ADR-025: replayed_from_dispatch_job_id — no referential FK to avoid cycles; integrity at app layer.
-- INV-DISPATCH-001: idempotency_key uniqueness is unaffected.

-- -------------------------------------------------------------------------
-- events.is_test: flag for events ingested in test mode
-- When true, dispatchers use test credentials (test_event_code, debug_mode).
-- Events with is_test=true do NOT count toward product dashboards or audiences.
-- -------------------------------------------------------------------------

ALTER TABLE events ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

-- Partial index for filtering test events in the live event console (T-8-007)
CREATE INDEX IF NOT EXISTS idx_events_is_test_workspace
  ON events (workspace_id, is_test, received_at DESC)
  WHERE is_test = true;

-- -------------------------------------------------------------------------
-- dispatch_jobs.replayed_from_dispatch_job_id: logical reference to the original job (ADR-025)
-- NULL for jobs created originally by the ingestion processor.
-- Non-null when job is created via POST /v1/dispatch-jobs/:id/replay.
-- No referential FK to avoid cycles in the same table.
-- -------------------------------------------------------------------------

ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS replayed_from_dispatch_job_id uuid;

-- Partial index for audit lookup of replays by original job
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_replayed_from
  ON dispatch_jobs (replayed_from_dispatch_job_id)
  WHERE replayed_from_dispatch_job_id IS NOT NULL;

-- Down:
-- DROP INDEX IF EXISTS idx_dispatch_jobs_replayed_from;
-- ALTER TABLE dispatch_jobs DROP COLUMN IF EXISTS replayed_from_dispatch_job_id;
-- DROP INDEX IF EXISTS idx_events_is_test_workspace;
-- ALTER TABLE events DROP COLUMN IF EXISTS is_test;
