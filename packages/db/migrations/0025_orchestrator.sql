-- Migration: 0025_orchestrator
-- T-7-001: Creates workflow_runs, lp_deployments, campaign_provisions tables
-- for Sprint 7 Orchestrator module.
--
-- BR-RBAC-002: workspace_id multi-tenant anchor + RLS on all three tables.
-- BR-AUDIT-001: tables are append-only; no DELETE by application code.
-- BR-PRIVACY-001: jsonb payload columns must not contain PII in clear.
-- INV-ORC-001: workflow_runs.status ∈ 6-value set (chk_workflow_runs_status).
-- INV-ORC-002: lp_deployments.slug unique per workspace (uq_lp_deployments_workspace_slug).
-- INV-ORC-003: campaign_provisions.platform ∈ {'meta','google'} (chk_campaign_provisions_platform).

-- -------------------------------------------------------------------------
-- Table: workflow_runs
-- -------------------------------------------------------------------------

CREATE TABLE workflow_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  workflow         text        NOT NULL,
  status           text        NOT NULL DEFAULT 'running',
  trigger_payload  jsonb       NOT NULL DEFAULT '{}',
  result           jsonb,
  trigger_run_id   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_workflow_runs_workflow
    CHECK (workflow IN ('setup-tracking', 'deploy-lp', 'provision-campaigns', 'rollback-provisioning')),

  -- INV-ORC-001: status constrained to 6 canonical values
  CONSTRAINT chk_workflow_runs_status
    CHECK (status IN ('running', 'waiting_approval', 'completed', 'failed', 'rolled_back', 'expired'))
);

-- idx_workflow_runs_workspace_id_status: efficient filtering by workspace + status
CREATE INDEX idx_workflow_runs_workspace_id_status
  ON workflow_runs (workspace_id, status);

-- updated_at trigger
CREATE TRIGGER trg_workflow_runs_before_update_set_updated_at
  BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS — BR-RBAC-002: isolate rows by workspace
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_runs_workspace_isolation ON workflow_runs
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- -------------------------------------------------------------------------
-- Table: lp_deployments
-- -------------------------------------------------------------------------

CREATE TABLE lp_deployments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id        uuid        NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  launch_id     uuid        NOT NULL REFERENCES launches(id) ON DELETE RESTRICT,
  template      text        NOT NULL,
  slug          text        NOT NULL,
  domain        text,
  cf_pages_url  text,
  status        text        NOT NULL DEFAULT 'deploying',
  deployed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- INV-ORC-002: slug is unique per workspace
  CONSTRAINT uq_lp_deployments_workspace_slug
    UNIQUE (workspace_id, slug),

  CONSTRAINT chk_lp_deployments_status
    CHECK (status IN ('deploying', 'deployed', 'failed'))
);

-- idx_lp_deployments_workspace_id: efficient workspace-scoped queries
CREATE INDEX idx_lp_deployments_workspace_id
  ON lp_deployments (workspace_id);

-- updated_at trigger
CREATE TRIGGER trg_lp_deployments_before_update_set_updated_at
  BEFORE UPDATE ON lp_deployments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS — BR-RBAC-002
ALTER TABLE lp_deployments ENABLE ROW LEVEL SECURITY;

CREATE POLICY lp_deployments_workspace_isolation ON lp_deployments
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- -------------------------------------------------------------------------
-- Table: campaign_provisions
-- -------------------------------------------------------------------------

CREATE TABLE campaign_provisions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id            uuid        NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  launch_id         uuid        NOT NULL REFERENCES launches(id) ON DELETE RESTRICT,
  platform          text        NOT NULL,
  external_id       text,
  status            text        NOT NULL DEFAULT 'pending',
  provision_payload jsonb       NOT NULL DEFAULT '{}',
  rollback_payload  jsonb       NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- INV-ORC-003: platform constrained to canonical set
  CONSTRAINT chk_campaign_provisions_platform
    CHECK (platform IN ('meta', 'google')),

  CONSTRAINT chk_campaign_provisions_status
    CHECK (status IN ('pending', 'pending_approval', 'active', 'failed', 'rolled_back'))
);

-- idx_campaign_provisions_run_id: efficient lookup by workflow run
CREATE INDEX idx_campaign_provisions_run_id
  ON campaign_provisions (run_id);

-- idx_campaign_provisions_workspace_id: efficient workspace-scoped queries
CREATE INDEX idx_campaign_provisions_workspace_id
  ON campaign_provisions (workspace_id);

-- updated_at trigger
CREATE TRIGGER trg_campaign_provisions_before_update_set_updated_at
  BEFORE UPDATE ON campaign_provisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS — BR-RBAC-002
ALTER TABLE campaign_provisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY campaign_provisions_workspace_isolation ON campaign_provisions
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- Down (reverse order to respect FK dependencies):
-- DROP TABLE IF EXISTS campaign_provisions;
-- DROP TABLE IF EXISTS lp_deployments;
-- DROP TABLE IF EXISTS workflow_runs;
