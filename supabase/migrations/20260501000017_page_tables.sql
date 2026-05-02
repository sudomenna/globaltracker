-- Migration: 0013_page_tables
-- Sprint 1 / T-1-003 — Page schema
-- Tables: pages, page_tokens
-- Constraints, indexes, RLS policies, updated_at trigger
--
-- Depends on:
--   0001_workspace_tables.sql (workspaces table, set_updated_at function)
--   0002_launch_table.sql     (launches table)

-- ============================================================
-- Table: pages
-- INV-PAGE-001: (launch_id, public_id) unique per launch — uq_pages_launch_public_id
-- INV-PAGE-002: allowed_domains not empty when integration_mode='b_snippet' — Edge enforced
-- INV-PAGE-004: active page has at least one active page_token — Edge enforced
-- INV-PAGE-006: event_config is Zod-valid per EventConfigSchema — Edge enforced
-- INV-PAGE-007: origin validated against allowed_domains in 'b_snippet' mode — Edge enforced
-- ADR-003: public_id is slug/random string for snippets/URLs; id is internal UUID
-- ADR-011: event_config carries pixel_policy per page
-- BR-RBAC-002: workspace_id is multi-tenant anchor; RLS enforces app.current_workspace_id
-- ============================================================
CREATE TABLE pages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to launches; page cannot exist without a launch
  launch_id       uuid        NOT NULL REFERENCES launches(id) ON DELETE RESTRICT,

  -- ADR-003: public_id for snippets/URLs — unique per launch (INV-PAGE-001)
  -- chk_pages_public_id_length: length between 1 and 64 characters
  public_id       text        NOT NULL,

  -- PageRole: canonical values from 01-enums.md
  role            text        NOT NULL,

  -- IntegrationMode: canonical values from 01-enums.md
  -- INV-PAGE-002: when 'b_snippet', allowed_domains must not be empty (Edge validates)
  integration_mode text       NOT NULL DEFAULT 'b_snippet',

  -- Informative URL — optional, NULL when not applicable
  url             text,

  -- Array of domain strings for origin validation (INV-PAGE-002 / INV-PAGE-007)
  -- Edge performs suffix match to allow subdomains
  allowed_domains text[]      NOT NULL DEFAULT '{}',

  -- Declarative event config blob (pixel_policy, event list, etc.)
  -- INV-PAGE-006: Zod-validated at Edge before save
  -- ADR-011: pixel_policy controls browser Pixel + CAPI deduplication strategy
  event_config    jsonb       NOT NULL DEFAULT '{}',

  -- A/B testing variant label — NULL when page is single variant
  variant         text,

  -- PageStatus: 'draft' | 'active' | 'paused' | 'archived'
  -- INV-PAGE-004: active page must have at least one active token (service layer)
  status          text        NOT NULL DEFAULT 'draft',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- INV-PAGE-001: public_id unique per launch
  CONSTRAINT uq_pages_launch_public_id UNIQUE (launch_id, public_id),

  -- public_id must be between 1 and 64 characters
  CONSTRAINT chk_pages_public_id_length CHECK (length(public_id) BETWEEN 1 AND 64),

  -- PageRole allowed values — from docs/30-contracts/01-enums.md
  CONSTRAINT chk_pages_role CHECK (
    role IN ('capture', 'sales', 'thankyou', 'webinar', 'checkout', 'survey')
  ),

  -- IntegrationMode allowed values — from docs/30-contracts/01-enums.md
  CONSTRAINT chk_pages_integration_mode CHECK (
    integration_mode IN ('a_system', 'b_snippet', 'c_webhook')
  ),

  -- PageStatus allowed values — from docs/30-contracts/01-enums.md
  CONSTRAINT chk_pages_status CHECK (
    status IN ('draft', 'active', 'paused', 'archived')
  )
);

-- Trigger: auto-update updated_at (reuses set_updated_at() from 0001)
CREATE TRIGGER trg_pages_before_update_set_updated_at
  BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- idx_pages_workspace_id: supports RLS filter + list queries
CREATE INDEX idx_pages_workspace_id
  ON pages (workspace_id);

-- idx_pages_launch_id: supports lookup of all pages for a launch
CREATE INDEX idx_pages_launch_id
  ON pages (launch_id);

-- idx_pages_workspace_status: dashboard / list-by-status queries
CREATE INDEX idx_pages_workspace_status
  ON pages (workspace_id, status);

-- RLS: workspace isolation — app.current_workspace_id must be set per request
ALTER TABLE pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY pages_workspace_isolation ON pages
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Table: page_tokens
-- ADR-023: status ∈ {active, rotating, revoked}; overlap window of 14 days
-- INV-PAGE-003: token_hash globally unique — uq_page_tokens_token_hash
-- INV-PAGE-004: each active page has at least one active token — Edge enforced
-- INV-PAGE-005: revoked tokens return 401 — Edge enforced (getPageByToken)
-- BR-RBAC-002: workspace_id is multi-tenant anchor; RLS enforces app.current_workspace_id
-- ============================================================
CREATE TABLE page_tokens (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to pages; token cannot exist without a page
  page_id         uuid        NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,

  -- SHA-256 hex of the clear token embedded in page snippets
  -- INV-PAGE-003: globally unique — uq_page_tokens_token_hash
  -- chk_page_tokens_token_hash_length: must be exactly 64 hex chars (SHA-256)
  token_hash      text        NOT NULL,

  -- Human-readable label for operator reference
  label           text        NOT NULL DEFAULT '',

  -- ADR-023: PageTokenStatus: 'active' | 'rotating' | 'revoked'
  --   active   — valid; accepted by Edge without warning
  --   rotating — in overlap window; accepted by Edge + legacy_token_in_use metric fired
  --   revoked  — invalid; Edge returns 401 (INV-PAGE-005)
  status          text        NOT NULL DEFAULT 'active',

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- ADR-023: set when rotation is initiated (status transitions to 'rotating')
  -- NULL while status='active'
  rotated_at      timestamptz,

  -- Set when status transitions to 'revoked' (after overlap window or emergency revocation)
  revoked_at      timestamptz,

  -- INV-PAGE-003: token_hash globally unique
  CONSTRAINT uq_page_tokens_token_hash UNIQUE (token_hash),

  -- token_hash must be exactly 64 hex characters (SHA-256)
  CONSTRAINT chk_page_tokens_token_hash_length CHECK (length(token_hash) = 64),

  -- PageTokenStatus allowed values — ADR-023 + docs/30-contracts/01-enums.md
  CONSTRAINT chk_page_tokens_status CHECK (
    status IN ('active', 'rotating', 'revoked')
  )
);

-- idx_page_tokens_workspace_id: supports RLS filter + list queries
CREATE INDEX idx_page_tokens_workspace_id
  ON page_tokens (workspace_id);

-- idx_page_tokens_page_id: lookup all tokens for a page
CREATE INDEX idx_page_tokens_page_id
  ON page_tokens (page_id);

-- idx_page_tokens_token_hash: auth lookup by hash (also covered by unique constraint)
CREATE INDEX idx_page_tokens_token_hash
  ON page_tokens (token_hash);

-- idx_page_tokens_page_status: find active/rotating tokens per page efficiently
-- INV-PAGE-004: service queries this index to verify at least one 'active' token exists
CREATE INDEX idx_page_tokens_page_status
  ON page_tokens (page_id, status);

-- RLS: workspace isolation — app.current_workspace_id must be set per request
ALTER TABLE page_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY page_tokens_workspace_isolation ON page_tokens
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Down migration (rollback)
-- Execute in reverse dependency order: page_tokens before pages
-- ============================================================
-- DROP TABLE IF EXISTS page_tokens;
-- DROP TABLE IF EXISTS pages;
