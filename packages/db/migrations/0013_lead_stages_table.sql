-- Migration: 0013_lead_stages_table
-- Sprint 1 / T-1-006 — Funnel module: lead_stages
-- Tables: lead_stages
-- Constraints: chk_lead_stages_stage_length (INV-FUNNEL-003)
-- Indexes: idx_lead_stages_workspace_lead, idx_lead_stages_workspace_launch, idx_lead_stages_source_event
-- Unique partial index: uq_lead_stages_non_recurring (INV-FUNNEL-001)
-- RLS: lead_stages_workspace_isolation
--
-- INV-FUNNEL-001: unique (workspace_id, launch_id, lead_id, stage) WHERE is_recurring = false
-- INV-FUNNEL-002: source_event_id references event in same workspace/lead (app layer + FK in T-1-005)
-- INV-FUNNEL-003: stage is non-empty and length <= 64 (chk_lead_stages_stage_length)
-- INV-FUNNEL-004: stages per lead are scoped by launch_id; cross-launch isolation is implicit
-- BR-FUNNEL-001: purchased stage is unique per lead/launch (is_recurring=false ensures this)
--
-- Depends on: 0001_workspace_tables.sql (workspaces), 0002_launch_table.sql (launches),
--             0004_identity_tables.sql (leads)

-- ============================================================
-- Table: lead_stages
-- INV-FUNNEL-001: non-recurring stages are unique per (workspace_id, launch_id, lead_id, stage)
-- INV-FUNNEL-003: stage is non-empty, length <= 64
-- BR-FUNNEL-001: stage='purchased' with is_recurring=false enforces purchase uniqueness per launch
-- ============================================================
CREATE TABLE lead_stages (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  -- BR-RBAC-002: RLS policy filters by app.current_workspace_id
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to leads; on delete restrict preserves stage history integrity
  -- INV-FUNNEL-002: lead must belong to same workspace (RLS + app layer)
  lead_id          uuid        NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- FK to launches; on delete restrict preserves stage history integrity
  -- INV-FUNNEL-004: stages for the same lead in different launches do not conflict
  launch_id        uuid        NOT NULL REFERENCES launches(id) ON DELETE RESTRICT,

  -- Stage name — operator-defined; not a closed enum (see 30-contracts/01-enums.md Stage note)
  -- INV-FUNNEL-003: non-empty and length <= 64 enforced by chk_lead_stages_stage_length
  stage            text        NOT NULL,

  -- INV-FUNNEL-001: false => participates in uq_lead_stages_non_recurring partial unique index
  --   true  => recurrent stage (e.g., watched_class_1); multiple rows allowed per (lead, launch, stage)
  is_recurring     boolean     NOT NULL DEFAULT false,

  -- source_event_id: optional reference to the triggering event
  -- INV-FUNNEL-002: when present, must reference an event in the same workspace/lead (app layer enforced)
  -- NOTE: FK to events.id is intentionally omitted here; events table is created in T-1-005 migration.
  --   The FK is safe to add in a subsequent migration once the events table exists.
  source_event_id  uuid,

  -- ts: wall-clock timestamp of stage recording
  ts               timestamptz NOT NULL DEFAULT now(),

  -- INV-FUNNEL-003: stage must be non-empty and at most 64 characters
  CONSTRAINT chk_lead_stages_stage_length CHECK (
    length(stage) >= 1 AND length(stage) <= 64
  )
);

-- ============================================================
-- Partial unique index: uq_lead_stages_non_recurring
-- INV-FUNNEL-001: at most one non-recurring record per (workspace_id, launch_id, lead_id, stage)
-- This is the canonical DB-level guard for stage idempotency on non-recurring stages.
-- ============================================================
CREATE UNIQUE INDEX uq_lead_stages_non_recurring
  ON lead_stages (workspace_id, launch_id, lead_id, stage)
  WHERE is_recurring = false;

-- idx_lead_stages_workspace_lead: primary access pattern — fetch all stages for a lead in a workspace
CREATE INDEX idx_lead_stages_workspace_lead
  ON lead_stages (workspace_id, lead_id, ts DESC);

-- idx_lead_stages_workspace_launch: funnel snapshot queries — count by stage within a launch
CREATE INDEX idx_lead_stages_workspace_launch
  ON lead_stages (workspace_id, launch_id, stage);

-- idx_lead_stages_source_event: back-lookup from event to stage record
CREATE INDEX idx_lead_stages_source_event
  ON lead_stages (source_event_id)
  WHERE source_event_id IS NOT NULL;

-- ============================================================
-- RLS: lead_stages_workspace_isolation
-- BR-RBAC-002: cross-workspace queries are forbidden
-- Application sets app.current_workspace_id per request transaction via SET LOCAL
-- ============================================================
ALTER TABLE lead_stages ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_stages_workspace_isolation ON lead_stages
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
