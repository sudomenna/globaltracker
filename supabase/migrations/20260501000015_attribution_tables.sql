-- Migration: 0014_attribution_tables
-- Sprint 1 / T-1-007 — Attribution module: links, link_clicks, lead_attributions
-- Tables: links, link_clicks, lead_attributions
-- Constraints:
--   uq_links_slug (global unique — BR-ATTRIBUTION-003, INV-ATTRIBUTION-002)
--   chk_links_slug_length, chk_links_status
--   chk_link_clicks_touch_type (via lead_attributions)
--   chk_lead_attributions_touch_type (INV-ATTRIBUTION-001)
-- Partial unique indexes:
--   uq_lead_attributions_first_per_launch (touch_type='first', INV-ATTRIBUTION-001)
--   uq_lead_attributions_last_per_launch  (touch_type='last',  INV-ATTRIBUTION-001)
-- Indexes: idx_links_workspace_launch, idx_links_workspace_status,
--          idx_link_clicks_workspace_link, idx_link_clicks_workspace_lead,
--          idx_link_clicks_workspace_ts,
--          idx_lead_attributions_workspace_lead, idx_lead_attributions_workspace_launch,
--          idx_lead_attributions_workspace_link
-- Triggers: trg_links_before_update_set_updated_at,
--           trg_lead_attributions_before_update_set_updated_at
-- RLS: links_workspace_isolation, link_clicks_workspace_isolation,
--      lead_attributions_workspace_isolation
--
-- BR-ATTRIBUTION-001: first-touch unique per (workspace_id, lead_id, launch_id); INSERT ON CONFLICT DO NOTHING at app layer
-- BR-ATTRIBUTION-002: last-touch upserted per (workspace_id, lead_id, launch_id); INSERT ON CONFLICT DO UPDATE at app layer
-- BR-ATTRIBUTION-003: links.slug globally unique — not per workspace
-- BR-ATTRIBUTION-004: link_clicks recorded async; latency < 50ms p95 (app layer fire-and-forget)
-- INV-ATTRIBUTION-001: (workspace_id, launch_id, lead_id, touch_type) unique when touch_type IN ('first','last')
-- INV-ATTRIBUTION-002: links.slug unique globally
-- INV-ATTRIBUTION-004: ip_hash and ua_hash are SHA-256 — enforced at app layer (lib/pii.ts)
-- INV-ATTRIBUTION-006: lead in another launch receives new first-touch for that launch (ADR-015)
--
-- Depends on: 0001_workspace_tables.sql (workspaces, set_updated_at),
--             0002_launch_table.sql (launches),
--             0004_identity_tables.sql (leads)

-- ============================================================
-- Table: links
-- BR-ATTRIBUTION-003: slug is globally unique (uq_links_slug)
-- INV-ATTRIBUTION-002: DB-level unique constraint on slug column
-- ============================================================
CREATE TABLE links (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  -- BR-RBAC-002: RLS policy filters by app.current_workspace_id
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to launches; link always belongs to a launch
  launch_id        uuid        NOT NULL REFERENCES launches(id) ON DELETE RESTRICT,

  -- BR-ATTRIBUTION-003: slug globally unique — NOT scoped to workspace
  -- INV-ATTRIBUTION-002: uq_links_slug enforces this at DB level
  -- chk_links_slug_length: 3 to 64 characters
  slug             text        NOT NULL,

  -- Full destination URL for the redirect
  destination_url  text        NOT NULL,

  -- UTM parameters — nullable
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  utm_content      text,
  utm_term         text,

  -- Ad platform structural identifiers — nullable
  channel          text,
  campaign         text,
  ad_account_id    text,
  campaign_id      text,
  adset_id         text,
  ad_id            text,
  creative_id      text,
  placement        text,

  -- LinkStatus: 'active' | 'archived'
  -- chk_links_status enforces valid values
  -- Soft-delete: status='archived' (never hard delete — INV-ATTRIBUTION-002 history)
  status           text        NOT NULL DEFAULT 'active',

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- BR-ATTRIBUTION-003: slug is globally unique (not per workspace)
  CONSTRAINT uq_links_slug UNIQUE (slug),

  -- INV-ATTRIBUTION-002: slug length must be between 3 and 64
  CONSTRAINT chk_links_slug_length CHECK (
    length(slug) BETWEEN 3 AND 64
  ),

  -- LinkStatus enum guard
  CONSTRAINT chk_links_status CHECK (
    status IN ('active', 'archived')
  )
);

-- idx_links_workspace_launch: primary listing — all links for a launch
CREATE INDEX idx_links_workspace_launch
  ON links (workspace_id, launch_id);

-- idx_links_workspace_status: filtered listing — active/archived links per workspace
CREATE INDEX idx_links_workspace_status
  ON links (workspace_id, status);

-- ============================================================
-- Trigger: trg_links_before_update_set_updated_at
-- Reuses set_updated_at() defined in 0001_workspace_tables.sql
-- ============================================================
CREATE TRIGGER trg_links_before_update_set_updated_at
  BEFORE UPDATE ON links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS: links_workspace_isolation
-- BR-RBAC-002: cross-workspace queries are forbidden
-- Application sets app.current_workspace_id per request via SET LOCAL
-- ============================================================
ALTER TABLE links ENABLE ROW LEVEL SECURITY;

CREATE POLICY links_workspace_isolation ON links
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Table: link_clicks
-- BR-ATTRIBUTION-004: append-only; recorded async (no UPDATE in normal flow)
-- INV-ATTRIBUTION-003: recording is fire-and-forget; does not block redirect
-- INV-ATTRIBUTION-004: ip_hash and ua_hash are SHA-256 hex (enforced at app layer)
-- ============================================================
CREATE TABLE link_clicks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  -- BR-RBAC-002: RLS policy filters by app.current_workspace_id
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to launches — click scoped to a launch context
  launch_id         uuid        NOT NULL REFERENCES launches(id) ON DELETE RESTRICT,

  -- FK to links — nullable: click can arrive via direct UTM without a short link
  -- on delete restrict: prevents accidental link removal with click history
  link_id           uuid        REFERENCES links(id) ON DELETE RESTRICT,

  -- lead_id: nullable — click may occur before lead identification
  -- on delete restrict: preserves click attribution history
  lead_id           uuid        REFERENCES leads(id) ON DELETE RESTRICT,

  -- Slug denormalized for append-only queries (nullable if direct UTM without link)
  slug              text,

  -- Exact timestamp of the click event
  ts                timestamptz NOT NULL DEFAULT now(),

  -- INV-ATTRIBUTION-004: SHA-256 hex hashes — never stored in clear
  -- Enforced at app layer in lib/pii.ts
  ip_hash           text,
  ua_hash           text,

  -- Referrer domain only (full URL stripped to avoid PII leakage)
  referrer_domain   text,

  -- Click identifiers from ad platforms
  fbclid            text,
  gclid             text,
  gbraid            text,
  wbraid            text,
  fbc               text,
  fbp               text,

  -- Consolidated attribution blob (UTM + click IDs)
  -- Zod schema registered in packages/shared/src/contracts/ (02-db-schema-conventions.md §jsonb)
  attribution       jsonb,

  -- Append-only: no updated_at column
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- idx_link_clicks_workspace_link: per-link click history
CREATE INDEX idx_link_clicks_workspace_link
  ON link_clicks (workspace_id, link_id, ts DESC)
  WHERE link_id IS NOT NULL;

-- idx_link_clicks_workspace_lead: per-lead click history (post-identification)
CREATE INDEX idx_link_clicks_workspace_lead
  ON link_clicks (workspace_id, lead_id, ts DESC)
  WHERE lead_id IS NOT NULL;

-- idx_link_clicks_workspace_ts: time-series queries within a workspace
CREATE INDEX idx_link_clicks_workspace_ts
  ON link_clicks (workspace_id, ts DESC);

-- ============================================================
-- RLS: link_clicks_workspace_isolation
-- BR-RBAC-002: cross-workspace queries are forbidden
-- ============================================================
ALTER TABLE link_clicks ENABLE ROW LEVEL SECURITY;

CREATE POLICY link_clicks_workspace_isolation ON link_clicks
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Table: lead_attributions
-- BR-ATTRIBUTION-001: first-touch unique per (workspace_id, lead_id, launch_id)
-- BR-ATTRIBUTION-002: last-touch upserted per (workspace_id, lead_id, launch_id)
-- INV-ATTRIBUTION-001: unique when touch_type IN ('first','last') — two partial unique indexes
-- INV-ATTRIBUTION-005: first from first event; last from last conversion (ordering by ts at app layer)
-- INV-ATTRIBUTION-006: lead in another launch receives new first-touch for that launch (ADR-015)
-- ============================================================
CREATE TABLE lead_attributions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  -- BR-RBAC-002: RLS policy filters by app.current_workspace_id
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to launches — attribution scoped per launch (ADR-015)
  -- INV-ATTRIBUTION-006: enables per-launch first-touch tracking
  launch_id        uuid        NOT NULL REFERENCES launches(id) ON DELETE RESTRICT,

  -- FK to leads — the attributed lead
  -- on delete restrict: preserves attribution history (SAR uses erasure path, not delete)
  lead_id          uuid        NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- TouchType: 'first' | 'last' | 'all'
  -- INV-ATTRIBUTION-001: when touch_type='first' or 'last', must be unique per (workspace_id, launch_id, lead_id)
  -- BR-ATTRIBUTION-001: 'first' → INSERT ON CONFLICT DO NOTHING (app layer: recordTouches)
  -- BR-ATTRIBUTION-002: 'last'  → INSERT ON CONFLICT DO UPDATE  (app layer: recordTouches)
  -- 'all' → multiple rows allowed (append-only historical record)
  -- chk_lead_attributions_touch_type enforces valid values
  touch_type       text        NOT NULL,

  -- UTM attribution parameters — nullable
  source           text,
  medium           text,
  campaign         text,
  content          text,
  term             text,

  -- FK to links — nullable: attribution can exist without a short link (direct UTM)
  link_id          uuid        REFERENCES links(id) ON DELETE RESTRICT,

  -- Ad platform structural identifiers — nullable
  ad_account_id    text,
  campaign_id      text,
  adset_id         text,
  ad_id            text,
  creative_id      text,

  -- Click identifiers — nullable; captured from inbound event attribution params
  fbclid           text,
  gclid            text,
  gbraid           text,
  wbraid           text,
  fbc              text,
  fbp              text,

  -- Event timestamp (clamped per BR-EVENT-003 at app layer before write)
  -- INV-ATTRIBUTION-005: first-touch ordered by ts ASC; last-touch ordered by ts DESC
  ts               timestamptz NOT NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- TouchType enum guard
  -- INV-ATTRIBUTION-001: touch_type must be a known value
  CONSTRAINT chk_lead_attributions_touch_type CHECK (
    touch_type IN ('first', 'last', 'all')
  )
);

-- ============================================================
-- Partial unique index: uq_lead_attributions_first_per_launch
-- INV-ATTRIBUTION-001: at most one 'first' touch per (workspace_id, launch_id, lead_id)
-- BR-ATTRIBUTION-001: INSERT ON CONFLICT DO NOTHING targets this index
-- ============================================================
CREATE UNIQUE INDEX uq_lead_attributions_first_per_launch
  ON lead_attributions (workspace_id, launch_id, lead_id)
  WHERE touch_type = 'first';

-- ============================================================
-- Partial unique index: uq_lead_attributions_last_per_launch
-- INV-ATTRIBUTION-001: at most one 'last' touch per (workspace_id, launch_id, lead_id)
-- BR-ATTRIBUTION-002: INSERT ON CONFLICT DO UPDATE targets this index
-- ============================================================
CREATE UNIQUE INDEX uq_lead_attributions_last_per_launch
  ON lead_attributions (workspace_id, launch_id, lead_id)
  WHERE touch_type = 'last';

-- idx_lead_attributions_workspace_lead: per-lead attribution history
CREATE INDEX idx_lead_attributions_workspace_lead
  ON lead_attributions (workspace_id, lead_id, ts DESC);

-- idx_lead_attributions_workspace_launch: per-launch attribution reporting
CREATE INDEX idx_lead_attributions_workspace_launch
  ON lead_attributions (workspace_id, launch_id, touch_type);

-- idx_lead_attributions_workspace_link: back-lookup from link to attributions
CREATE INDEX idx_lead_attributions_workspace_link
  ON lead_attributions (workspace_id, link_id)
  WHERE link_id IS NOT NULL;

-- ============================================================
-- Trigger: trg_lead_attributions_before_update_set_updated_at
-- Reuses set_updated_at() defined in 0001_workspace_tables.sql
-- ============================================================
CREATE TRIGGER trg_lead_attributions_before_update_set_updated_at
  BEFORE UPDATE ON lead_attributions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS: lead_attributions_workspace_isolation
-- BR-RBAC-002: cross-workspace queries are forbidden
-- Application sets app.current_workspace_id per request via SET LOCAL
-- ============================================================
ALTER TABLE lead_attributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_attributions_workspace_isolation ON lead_attributions
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
