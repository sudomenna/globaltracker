-- Migration: 0010_ad_spend_daily_table
-- Sprint 1 / T-1-010 — Cost module: ad_spend_daily schema foundation
-- Tables: ad_spend_daily
-- Constraints, expression unique index (INV-COST-001), RLS policy
--
-- NOTE: launch_id column is declared WITHOUT a FK reference to launches(id)
-- because T-1-002 (launches table) may not yet be present in all envs.
-- The FK constraint will be added in a subsequent migration once launches is
-- confirmed stable across all branches.
-- TODO: add FK constraint: ALTER TABLE ad_spend_daily ADD CONSTRAINT
--   fk_ad_spend_daily_launch FOREIGN KEY (launch_id) REFERENCES launches(id)
--   ON DELETE RESTRICT NOT VALID; (+ VALIDATE CONSTRAINT in second phase)

-- ============================================================
-- Table: ad_spend_daily
-- INV-COST-001: natural key uniqueness via COALESCE expression index
-- INV-COST-002: granularity ∈ ('account','campaign','adset','ad')
-- INV-COST-005: currency must be 3-char ISO 4217 code
-- BR-COST-001: spend_cents >= 0
-- RLS: workspace_id = current_setting('app.current_workspace_id', true)::uuid
-- ============================================================
CREATE TABLE ad_spend_daily (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  workspace_id           uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- Optional FK to launches — declared as plain uuid (no FK); see header note
  launch_id              uuid,

  -- Platform enum: 'meta' | 'google'
  platform               text        NOT NULL,

  -- Platform ad account identifier
  account_id             text        NOT NULL,

  -- Hierarchical ad entity identifiers — NULL at coarser granularity levels
  campaign_id            text,
  adset_id               text,
  ad_id                  text,

  -- INV-COST-002: granularity level for this row
  granularity            text        NOT NULL,

  -- Spend date (one row per natural key per day)
  date                   date        NOT NULL,

  -- Informativo only — does NOT participate in the unique key (INV-COST-001)
  timezone               text        NOT NULL,

  -- INV-COST-005: ISO 4217 3-char currency code
  currency               text        NOT NULL,

  -- BR-COST-001: spend in original currency, in cents — non-negative
  spend_cents            integer     NOT NULL,

  -- INV-COST-003: populated after FX lookup (NULL until cron runs)
  spend_cents_normalized integer,

  -- FX normalisation fields (populated together)
  fx_rate                numeric(18, 8),
  -- FxSource: 'ecb' | 'wise' | 'manual'
  fx_source              text,
  -- 3-char ISO 4217 target currency of normalisation
  fx_currency            text,

  -- Performance metrics
  impressions            integer     NOT NULL DEFAULT 0,
  clicks                 integer     NOT NULL DEFAULT 0,

  -- When this row was fetched from the platform API
  fetched_at             timestamptz NOT NULL DEFAULT now(),

  -- SHA-256 hex of original API payload (dedup/audit)
  source_payload_hash    text,

  created_at             timestamptz NOT NULL DEFAULT now(),

  -- INV-COST-002: granularity must be one of the Granularity enum values
  CONSTRAINT chk_ad_spend_daily_granularity CHECK (
    granularity IN ('account', 'campaign', 'adset', 'ad')
  ),

  -- Platform must be one of the Platform enum values
  CONSTRAINT chk_ad_spend_daily_platform CHECK (
    platform IN ('meta', 'google')
  ),

  -- INV-COST-005: currency must be a valid 3-char ISO 4217 code
  CONSTRAINT chk_ad_spend_daily_currency_length CHECK (
    length(currency) = 3
  ),

  -- BR-COST-001: spend cannot be negative
  CONSTRAINT chk_ad_spend_daily_spend_cents_non_negative CHECK (
    spend_cents >= 0
  ),

  -- FxSource must be one of the FxSource enum values when present
  CONSTRAINT chk_ad_spend_daily_fx_source CHECK (
    fx_source IS NULL OR fx_source IN ('ecb', 'wise', 'manual')
  ),

  -- fx_currency must be 3-char ISO 4217 when present
  CONSTRAINT chk_ad_spend_daily_fx_currency_length CHECK (
    fx_currency IS NULL OR length(fx_currency) = 3
  )
);

-- ============================================================
-- INV-COST-001: Natural key unique index using COALESCE to treat NULL as ''
-- This allows (workspace_id, platform, account_id, NULL, NULL, NULL, 'account', date)
-- to be treated as identical to re-insert of the same row — upsert protection.
-- timezone is intentionally EXCLUDED from this key.
-- ============================================================
CREATE UNIQUE INDEX uq_ad_spend_daily_natural_key
  ON ad_spend_daily (
    workspace_id,
    platform,
    account_id,
    COALESCE(campaign_id, ''),
    COALESCE(adset_id, ''),
    COALESCE(ad_id, ''),
    granularity,
    date
  );

-- idx_ad_spend_daily_workspace_id: supports RLS filter
CREATE INDEX idx_ad_spend_daily_workspace_id
  ON ad_spend_daily (workspace_id);

-- idx_ad_spend_daily_workspace_date: common dashboard query pattern
CREATE INDEX idx_ad_spend_daily_workspace_date
  ON ad_spend_daily (workspace_id, date);

-- idx_ad_spend_daily_launch_id: FK-style lookup when launch_id is provided
CREATE INDEX idx_ad_spend_daily_launch_id
  ON ad_spend_daily (launch_id)
  WHERE launch_id IS NOT NULL;

-- ============================================================
-- RLS: workspace isolation
-- Application sets app.current_workspace_id via SET LOCAL at request start.
-- Queries without workspace_id set return zero rows.
-- ============================================================
ALTER TABLE ad_spend_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY ad_spend_daily_workspace_isolation ON ad_spend_daily
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
