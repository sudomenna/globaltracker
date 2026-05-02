-- Migration: 0002_launch_table
-- Sprint 1 / T-1-002 — Launch schema
-- Table: launches
-- Constraints, indexes, RLS policy, updated_at trigger
--
-- Depends on: 0001_workspace_tables.sql (workspaces table, set_updated_at function)

-- ============================================================
-- Table: launches
-- INV-LAUNCH-001: (workspace_id, public_id) unique per workspace — uq_launches_workspace_public_id
-- INV-LAUNCH-002: status='archived' rejects ingest — enforced at Edge (requireActiveLaunch)
-- INV-LAUNCH-003: launch only goes live with Pixel policy declared — service layer validates
-- INV-LAUNCH-004: timezone is IANA tz — validated by Zod at Edge; DB accepts text not null
-- INV-LAUNCH-005: config.tracking.google.customer_match_strategy — Zod validates enum; DB accepts jsonb
-- BR-DISPATCH-001: pixel_policy='browser_and_server_managed' requires shared event_id (Edge enforced)
-- BR-AUDIENCE-001: customer_match_strategy is conditional on audience eligibility (Edge enforced)
-- ============================================================
CREATE TABLE launches (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- INV-LAUNCH-001: unique per workspace — see constraint uq_launches_workspace_public_id below
  -- chk_launches_public_id_length: length between 3 and 64
  public_id    text        NOT NULL,

  name         text        NOT NULL,

  -- LaunchStatus: 'draft' | 'configuring' | 'live' | 'ended' | 'archived'
  -- INV-LAUNCH-002: 'archived' value is valid here; ingest rejection enforced at Edge layer
  status       text        NOT NULL DEFAULT 'draft',

  -- INV-LAUNCH-004: IANA tz string; Zod validates at Edge (z.string().refine(isValidIanaTimezone))
  timezone     text        NOT NULL DEFAULT 'America/Sao_Paulo',

  -- Tracking config jsonb: meta (pixel_id, pixel_policy), google (customer_id, conversion_actions,
  -- customer_match_strategy), lead_token (ttl_seconds), fx (override_rate).
  -- BR-DISPATCH-001: pixel_policy='browser_and_server_managed' requires event_id shared between
  --   browser and server to enable deduplication.
  -- BR-AUDIENCE-001: customer_match_strategy is conditional — only set when audience is eligible.
  -- INV-LAUNCH-003: config.tracking.meta.pixel_policy must be present before transition to 'live'.
  -- INV-LAUNCH-005: config.tracking.google.customer_match_strategy must be in CustomerMatchStrategy enum.
  config       jsonb       NOT NULL DEFAULT '{}',

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- INV-LAUNCH-001: public_id is unique per workspace
  CONSTRAINT uq_launches_workspace_public_id UNIQUE (workspace_id, public_id),

  -- public_id must be between 3 and 64 characters
  CONSTRAINT chk_launches_public_id_length CHECK (length(public_id) BETWEEN 3 AND 64),

  -- LaunchStatus allowed values
  CONSTRAINT chk_launches_status CHECK (
    status IN ('draft', 'configuring', 'live', 'ended', 'archived')
  )
);

-- Trigger: auto-update updated_at (reuses set_updated_at() from 0001)
CREATE TRIGGER trg_launches_before_update_set_updated_at
  BEFORE UPDATE ON launches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- idx_launches_workspace_id: supports RLS filter + list queries
CREATE INDEX idx_launches_workspace_id
  ON launches (workspace_id);

-- idx_launches_workspace_status: dashboard / list-by-status queries
CREATE INDEX idx_launches_workspace_status
  ON launches (workspace_id, status);

-- RLS: workspace isolation — app.current_workspace_id must be set per request
ALTER TABLE launches ENABLE ROW LEVEL SECURITY;

CREATE POLICY launches_workspace_isolation ON launches
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
