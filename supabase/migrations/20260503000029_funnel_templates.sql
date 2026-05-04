-- Migration: 0029_funnel_templates
-- T-FUNIL-010: funnel_templates table + launches extensions
-- Sprint 10 — Funil Configurável Fase 2
--
-- Depends on: 0002_launch_table.sql (launches), 0001_workspace_tables.sql (workspaces)
--
-- funnel_templates holds both system-wide presets (workspace_id IS NULL)
-- and workspace-scoped custom templates.
-- Uniqueness: (COALESCE(workspace_id::text, '_global'), slug) — INV-FUNNEL-001
-- RLS: authenticated users see system presets + their workspace templates.
-- INSERT/UPDATE/DELETE restricted to workspace members (app.current_workspace_id must match).

-- ============================================================
-- Table: funnel_templates
-- INV-FUNNEL-001: slug unique within (workspace_id or system scope)
--   — enforced by uq_funnel_templates_workspace_slug
-- INV-FUNNEL-002: system templates (is_system=true) have workspace_id IS NULL
--   — enforced by chk_funnel_templates_system_no_workspace
-- ============================================================
CREATE TABLE IF NOT EXISTS funnel_templates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL = system/global preset; NOT NULL = workspace-scoped template
  -- INV-FUNNEL-002: system templates must have workspace_id IS NULL
  workspace_id uuid        NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Unique identifier within scope (system or workspace) — INV-FUNNEL-001
  slug         text        NOT NULL,

  name         text        NOT NULL,
  description  text,

  -- Full funnel blueprint (stages, pages, audiences, type, etc.)
  -- Shape validated by FunnelBlueprintSchema (Zod) at Edge layer before persistence
  blueprint    jsonb       NOT NULL,

  -- true = managed by GlobalTracker system; false = user-created within workspace
  -- INV-FUNNEL-002: is_system=true requires workspace_id IS NULL
  is_system    boolean     NOT NULL DEFAULT false,

  -- FunnelTemplateStatus: 'active' | 'archived'
  -- chk_funnel_templates_status enforces allowed values
  status       text        NOT NULL DEFAULT 'active',

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- INV-FUNNEL-002: system templates must not belong to a workspace
  CONSTRAINT chk_funnel_templates_system_no_workspace CHECK (
    NOT (is_system = true AND workspace_id IS NOT NULL)
  ),

  -- Status allowed values
  CONSTRAINT chk_funnel_templates_status CHECK (
    status IN ('active', 'archived')
  )
);

-- INV-FUNNEL-001: slug unique per (workspace_id or '_global' for system presets)
CREATE UNIQUE INDEX uq_funnel_templates_workspace_slug
  ON funnel_templates (COALESCE(workspace_id::text, '_global'), slug);

-- idx_funnel_templates_workspace_id: supports RLS filter + list queries
CREATE INDEX idx_funnel_templates_workspace_id
  ON funnel_templates (workspace_id);

-- idx_funnel_templates_is_system: fast lookup of system presets
CREATE INDEX idx_funnel_templates_is_system
  ON funnel_templates (is_system)
  WHERE is_system = true;

-- Trigger: auto-update updated_at (reuses set_updated_at() from 0001)
CREATE TRIGGER trg_funnel_templates_before_update_set_updated_at
  BEFORE UPDATE ON funnel_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS: funnel_templates
-- SELECT: system presets visible to all authenticated; workspace templates isolated.
-- INSERT/UPDATE/DELETE: only workspace members.
-- Dual-mode (migration 0028): GUC app.current_workspace_id (Edge Worker)
--   OR public.auth_workspace_id() (Supabase JWT via supabase-js).
-- ============================================================
ALTER TABLE funnel_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY funnel_templates_select ON funnel_templates
  FOR SELECT
  USING (
    workspace_id IS NULL
    OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

CREATE POLICY funnel_templates_insert ON funnel_templates
  FOR INSERT
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

CREATE POLICY funnel_templates_update ON funnel_templates
  FOR UPDATE
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

CREATE POLICY funnel_templates_delete ON funnel_templates
  FOR DELETE
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

-- ============================================================
-- Extend launches: funnel_template_id + funnel_blueprint
-- ============================================================
ALTER TABLE launches
  ADD COLUMN IF NOT EXISTS funnel_template_id uuid NULL
    REFERENCES funnel_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS funnel_blueprint    jsonb NULL;

-- idx_launches_funnel_template_id: supports lookups of all launches using a template
CREATE INDEX idx_launches_funnel_template_id
  ON launches (funnel_template_id)
  WHERE funnel_template_id IS NOT NULL;

-- Down (manual rollback):
-- ALTER TABLE launches DROP COLUMN IF EXISTS funnel_blueprint;
-- ALTER TABLE launches DROP COLUMN IF EXISTS funnel_template_id;
-- DROP TABLE IF EXISTS funnel_templates;
