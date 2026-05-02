-- Migration: 0001_workspace_tables
-- Sprint 1 / T-1-001 — Workspace schema foundation
-- Tables: workspaces, workspace_members, workspace_api_keys
-- Constraints, indexes, partial unique indexes, RLS policies, updated_at trigger

-- ============================================================
-- Function: set_updated_at
-- Generic trigger function to auto-update updated_at on mutation
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Table: workspaces
-- INV-WORKSPACE-001: slug globally unique (uq_workspaces_slug)
-- INV-WORKSPACE-004: fx_normalization_currency must be valid ISO 4217 (chk_workspaces_fx_currency)
-- BR-PRIVACY-001: id is the HKDF salt for per-workspace crypto key derivation (runtime only)
-- RLS: enabled but policy is on id (workspaces IS the tenant root; no workspace_id FK here)
-- BR-RBAC-002: app.current_workspace_id used by other tables; workspaces itself uses id-based isolation
-- ============================================================
CREATE TABLE workspaces (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                      text NOT NULL,
  name                      text NOT NULL,
  -- WorkspaceStatus: 'draft' | 'active' | 'suspended' | 'archived'
  status                    text NOT NULL DEFAULT 'draft',
  -- INV-WORKSPACE-004: ISO 4217 currencies supported
  fx_normalization_currency text NOT NULL DEFAULT 'BRL',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- INV-WORKSPACE-001: slug is globally unique
  CONSTRAINT uq_workspaces_slug UNIQUE (slug),

  -- slug must be between 3 and 64 characters
  CONSTRAINT chk_workspaces_slug_length CHECK (length(slug) BETWEEN 3 AND 64),

  -- INV-WORKSPACE-002 boundary: status values (archived -> rejects ingest at Edge)
  CONSTRAINT chk_workspaces_status CHECK (
    status IN ('draft', 'active', 'suspended', 'archived')
  ),

  -- INV-WORKSPACE-004: only supported FX currencies
  CONSTRAINT chk_workspaces_fx_currency CHECK (
    fx_normalization_currency IN ('BRL', 'USD', 'EUR', 'GBP', 'ARS', 'MXN', 'COP', 'CLP', 'PEN')
  )
);

-- Trigger: auto-update updated_at
CREATE TRIGGER trg_workspaces_before_update_set_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: enabled on workspaces (admin-level policy — workspaces is the tenant root)
-- Application sets app.current_workspace_id; here we allow SELECT when id matches
-- Row-level enforcement for admin operations; tenant workload uses id directly.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspaces_self_isolation ON workspaces
  USING (id = current_setting('app.current_workspace_id', true)::uuid);

-- ============================================================
-- Table: workspace_members
-- BR-RBAC-001: One active owner per workspace (partial unique index)
-- BR-RBAC-002: RLS policy filters by app.current_workspace_id
-- ============================================================
CREATE TABLE workspace_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  -- External reference to Supabase Auth; no FK constraint (cross-service boundary)
  user_id      uuid NOT NULL,
  -- Role enum: 'owner' | 'admin' | 'marketer' | 'operator' | 'privacy' | 'viewer'
  role         text NOT NULL,
  invited_at   timestamptz NOT NULL DEFAULT now(),
  joined_at    timestamptz,
  removed_at   timestamptz,

  -- Role must be one of the canonical values
  CONSTRAINT chk_workspace_members_role CHECK (
    role IN ('owner', 'admin', 'marketer', 'operator', 'privacy', 'viewer')
  )
);

-- idx_workspace_members_workspace_id: supports RLS filter + joins
CREATE INDEX idx_workspace_members_workspace_id
  ON workspace_members (workspace_id);

-- idx_workspace_members_user_id: reverse membership lookup
CREATE INDEX idx_workspace_members_user_id
  ON workspace_members (user_id);

-- idx_workspace_members_workspace_user: active membership lookup
CREATE INDEX idx_workspace_members_workspace_user
  ON workspace_members (workspace_id, user_id);

-- INV-WORKSPACE-003 / BR-RBAC-001: at most one active owner per workspace
-- Partial unique index: (workspace_id, role) WHERE role = 'owner' AND removed_at IS NULL
CREATE UNIQUE INDEX uq_workspace_members_one_active_owner_per_workspace
  ON workspace_members (workspace_id, role)
  WHERE role = 'owner' AND removed_at IS NULL;

-- Unique active membership per workspace: (workspace_id, user_id) WHERE removed_at IS NULL
-- Prevents duplicate active memberships for the same user in the same workspace
CREATE UNIQUE INDEX uq_workspace_members_active_per_workspace_user
  ON workspace_members (workspace_id, user_id)
  WHERE removed_at IS NULL;

-- RLS: BR-RBAC-002 — cross-workspace queries prohibited
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_members_workspace_isolation ON workspace_members
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- ============================================================
-- Table: workspace_api_keys
-- INV-WORKSPACE-005: revoked_at IS NOT NULL => key is revoked (auth at Edge)
-- BR-RBAC-002: RLS policy filters by app.current_workspace_id
-- ============================================================
CREATE TABLE workspace_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  -- SHA-256 hex of the raw secret — exactly 64 hex characters
  key_hash     text NOT NULL,
  -- Array of scope strings: 'events:write', 'leads:erase', etc.
  scopes       text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  -- INV-WORKSPACE-005: null = active; not null = revoked
  revoked_at   timestamptz,

  -- key_hash must be exactly 64 hex characters (SHA-256)
  CONSTRAINT chk_workspace_api_keys_key_hash_length CHECK (length(key_hash) = 64),

  -- key_hash is globally unique (one secret cannot belong to two workspaces)
  CONSTRAINT uq_workspace_api_keys_key_hash UNIQUE (key_hash)
);

-- idx_workspace_api_keys_workspace_id: supports RLS filter + list queries
CREATE INDEX idx_workspace_api_keys_workspace_id
  ON workspace_api_keys (workspace_id);

-- idx_workspace_api_keys_key_hash: auth lookup by hash (also covered by unique constraint)
CREATE INDEX idx_workspace_api_keys_key_hash
  ON workspace_api_keys (key_hash);

-- RLS: BR-RBAC-002 — cross-workspace queries prohibited
ALTER TABLE workspace_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_api_keys_workspace_isolation ON workspace_api_keys
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
