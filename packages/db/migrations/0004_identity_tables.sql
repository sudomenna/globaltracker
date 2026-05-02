-- Migration: 0004_identity_tables
-- Sprint 1 / T-1-004 — Identity module: leads, lead_aliases, lead_merges, lead_consents, lead_tokens
-- ADR-005: NO unique constraints on leads.email_hash or leads.phone_hash
--   Uniqueness of PII identifiers is managed exclusively via lead_aliases partial unique index.
-- ADR-006: lead_tokens are stateful (stored in DB) to support SAR revocation.
-- ADR-009: PII encryption with pii_key_version for key rotation.
-- BR-PRIVACY-002: All PII stored as SHA-256 hashes in *_hash columns.
-- BR-PRIVACY-003: Sensitive PII encrypted as AES-256-GCM base64 in *_enc columns.
--
-- Depends on: 0001_workspace_tables.sql (workspaces table, set_updated_at function)

-- ============================================================
-- Table: leads
-- ADR-005: NO unique constraint on email_hash or phone_hash
-- INV-IDENTITY-002: erased lead has all PII fields NULL (SAR service enforced)
-- INV-IDENTITY-003: merged lead does not receive new aliases (Edge enforced)
-- BR-PRIVACY-002: *_hash columns hold SHA-256 hex of normalized PII
-- BR-PRIVACY-003: *_enc columns hold AES-256-GCM base64 encrypted PII
-- ============================================================
CREATE TABLE leads (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  workspace_id         uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- BR-PRIVACY-002: SHA-256 hex of external identifier (nullable — may be absent)
  external_id_hash     text,

  -- BR-PRIVACY-002: SHA-256 hex of normalized email (lowercase + trim)
  -- ADR-005: NO unique constraint — uniqueness lives in lead_aliases (uq_lead_aliases_active_per_identifier)
  -- INV-IDENTITY-007: normalization enforced in lib/pii.ts hash() helper, not DB
  email_hash           text,

  -- BR-PRIVACY-002: SHA-256 hex of E.164-normalized phone
  -- ADR-005: NO unique constraint — uniqueness lives in lead_aliases
  phone_hash           text,

  -- BR-PRIVACY-002: SHA-256 hex of name (lowercase + trim)
  name_hash            text,

  -- BR-PRIVACY-003: AES-256-GCM encrypted email (base64)
  email_enc            text,

  -- BR-PRIVACY-003: AES-256-GCM encrypted phone (base64)
  phone_enc            text,

  -- BR-PRIVACY-003: AES-256-GCM encrypted name (base64)
  name_enc             text,

  -- Encryption key version for AES-256-GCM envelope; used for key rotation (ADR-009)
  pii_key_version      smallint    NOT NULL DEFAULT 1,

  -- LeadStatus: 'active' | 'merged' | 'erased'
  -- INV-IDENTITY-002: 'erased' => all PII fields NULL (SAR service enforced)
  -- INV-IDENTITY-003: 'merged' => no new aliases/events (Edge resolver enforced)
  status               text        NOT NULL DEFAULT 'active',

  -- Self-referential FK: populated when status='merged'; points to canonical lead
  -- INV-IDENTITY-003: resolver follows this chain to canonical lead
  merged_into_lead_id  uuid        REFERENCES leads(id),

  -- first_seen_at: earliest event/alias timestamp associated with this lead
  first_seen_at        timestamptz NOT NULL DEFAULT now(),

  -- last_seen_at: most recent event/alias timestamp associated with this lead
  last_seen_at         timestamptz NOT NULL DEFAULT now(),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- LeadStatus must be a canonical value
  CONSTRAINT chk_leads_status CHECK (
    status IN ('active', 'merged', 'erased')
  )
);

-- Trigger: auto-update updated_at (reuses set_updated_at() from 0001)
CREATE TRIGGER trg_leads_before_update_set_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- idx_leads_workspace_id: supports RLS filter + list queries
CREATE INDEX idx_leads_workspace_id
  ON leads (workspace_id);

-- idx_leads_email_hash: lookup by email (within workspace) — NOT unique (ADR-005)
CREATE INDEX idx_leads_email_hash
  ON leads (workspace_id, email_hash);

-- idx_leads_phone_hash: lookup by phone (within workspace) — NOT unique (ADR-005)
CREATE INDEX idx_leads_phone_hash
  ON leads (workspace_id, phone_hash);

-- RLS: workspace isolation — app.current_workspace_id must be set per request
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY leads_workspace_isolation ON leads
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- ============================================================
-- Table: lead_aliases
-- INV-IDENTITY-001: No two active aliases share (workspace_id, identifier_type, identifier_hash)
--   Enforced by partial unique index uq_lead_aliases_active_per_identifier WHERE status='active'
-- BR-IDENTITY-001: aliases ativos são únicos por (workspace_id, identifier_type, identifier_hash)
-- ADR-005: This is the canonical locus of PII uniqueness — not leads.*_hash columns
-- ============================================================
CREATE TABLE lead_aliases (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- IdentifierType: 'email_hash' | 'phone_hash' | 'external_id_hash' | 'lead_token_id'
  identifier_type  text        NOT NULL,

  -- BR-PRIVACY-002: SHA-256 hex of the normalized identifier value
  -- INV-IDENTITY-007: normalization is enforced in lib/pii.ts, not DB
  identifier_hash  text        NOT NULL,

  -- FK to the lead this alias resolves to
  lead_id          uuid        NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- Source of alias creation
  -- Values: 'form_submit' | 'webhook:hotmart' | 'webhook:stripe' | 'webhook:kiwify' | 'manual' | 'merge'
  source           text        NOT NULL,

  -- LeadAliasStatus: 'active' | 'superseded' | 'revoked'
  status           text        NOT NULL DEFAULT 'active',

  -- Timestamp when this alias was established
  ts               timestamptz NOT NULL DEFAULT now(),

  -- IdentifierType must be a canonical value
  CONSTRAINT chk_lead_aliases_identifier_type CHECK (
    identifier_type IN ('email_hash', 'phone_hash', 'external_id_hash', 'lead_token_id')
  ),

  -- Source must be a canonical value
  CONSTRAINT chk_lead_aliases_source CHECK (
    source IN ('form_submit', 'webhook:hotmart', 'webhook:stripe', 'webhook:kiwify', 'manual', 'merge')
  ),

  -- LeadAliasStatus must be a canonical value
  CONSTRAINT chk_lead_aliases_status CHECK (
    status IN ('active', 'superseded', 'revoked')
  )
);

-- INV-IDENTITY-001 / BR-IDENTITY-001: at most one active alias per (workspace_id, identifier_type, identifier_hash)
-- Partial unique index: only applies WHERE status = 'active'
-- superseded and revoked aliases do not conflict — historical record is preserved
CREATE UNIQUE INDEX uq_lead_aliases_active_per_identifier
  ON lead_aliases (workspace_id, identifier_type, identifier_hash)
  WHERE status = 'active';

-- idx_lead_aliases_lead_id: reverse lookup from lead to its aliases
CREATE INDEX idx_lead_aliases_lead_id
  ON lead_aliases (lead_id);

-- idx_lead_aliases_workspace_identifier: forward lookup (workspace + type + hash)
CREATE INDEX idx_lead_aliases_workspace_identifier
  ON lead_aliases (workspace_id, identifier_type, identifier_hash);

-- RLS: workspace isolation
ALTER TABLE lead_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_aliases_workspace_isolation ON lead_aliases
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- ============================================================
-- Table: lead_merges
-- BR-IDENTITY-004: Every merge operation is recorded here for audit purposes.
-- INV-IDENTITY-003: After merge, merged_lead does not receive new aliases/events.
-- ============================================================
CREATE TABLE lead_merges (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- The surviving canonical lead
  canonical_lead_id uuid        NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- The lead that was absorbed (set to status='merged' after this operation)
  merged_lead_id    uuid        NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- MergeReason: 'email_phone_convergence' | 'manual' | 'sar'
  reason            text        NOT NULL,

  -- 'system' for auto-resolver; user UUID string for manual merges
  -- BR-IDENTITY-004: performed_by is required for audit trail
  performed_by      text        NOT NULL,

  -- Snapshot of both leads before merge (jsonb — no PII in clear text)
  -- BR-PRIVACY-002: only hashes and non-sensitive structural fields stored here
  before_summary    jsonb,

  -- Snapshot of canonical lead after merge (jsonb — structural fields only)
  after_summary     jsonb,

  -- Timestamp of the merge operation
  merged_at         timestamptz NOT NULL DEFAULT now(),

  -- MergeReason must be a canonical value
  CONSTRAINT chk_lead_merges_reason CHECK (
    reason IN ('email_phone_convergence', 'manual', 'sar')
  )
);

-- idx_lead_merges_canonical: list all merges absorbed into a canonical lead
CREATE INDEX idx_lead_merges_canonical
  ON lead_merges (workspace_id, canonical_lead_id);

-- idx_lead_merges_merged: find which canonical lead absorbed a given merged lead
CREATE INDEX idx_lead_merges_merged
  ON lead_merges (workspace_id, merged_lead_id);

-- RLS: workspace isolation
ALTER TABLE lead_merges ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_merges_workspace_isolation ON lead_merges
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- ============================================================
-- Table: lead_consents
-- BR-CONSENT-001: Consent is append-only — each row is an immutable record.
--   Latest row per (lead_id, finality) is the effective consent state.
-- ADR-010: 5 consent finalidades: analytics, marketing, ad_user_data, ad_personalization, customer_match
-- ConsentValue: 'granted' | 'denied' | 'unknown'
-- ============================================================
CREATE TABLE lead_consents (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  workspace_id              uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to the lead whose consent is recorded
  lead_id                   uuid        NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- Optional reference to triggering event (NULL for admin/manual consent records)
  event_id                  text,

  -- ConsentValue per ADR-010 finality: 'granted' | 'denied' | 'unknown'
  consent_analytics         text        NOT NULL DEFAULT 'unknown',
  consent_marketing         text        NOT NULL DEFAULT 'unknown',
  consent_ad_user_data      text        NOT NULL DEFAULT 'unknown',
  consent_ad_personalization text       NOT NULL DEFAULT 'unknown',
  consent_customer_match    text        NOT NULL DEFAULT 'unknown',

  -- Source of this consent record (e.g., 'tracker', 'webhook:hotmart', 'admin')
  source                    text        NOT NULL,

  -- Policy version at time of consent collection (e.g., '2024-01', '2.1')
  policy_version            text        NOT NULL,

  -- Timestamp of this consent record
  ts                        timestamptz NOT NULL DEFAULT now(),

  -- ConsentValue must be canonical for each finality column
  CONSTRAINT chk_lead_consents_consent_analytics CHECK (
    consent_analytics IN ('granted', 'denied', 'unknown')
  ),
  CONSTRAINT chk_lead_consents_consent_marketing CHECK (
    consent_marketing IN ('granted', 'denied', 'unknown')
  ),
  CONSTRAINT chk_lead_consents_consent_ad_user_data CHECK (
    consent_ad_user_data IN ('granted', 'denied', 'unknown')
  ),
  CONSTRAINT chk_lead_consents_consent_ad_personalization CHECK (
    consent_ad_personalization IN ('granted', 'denied', 'unknown')
  ),
  CONSTRAINT chk_lead_consents_consent_customer_match CHECK (
    consent_customer_match IN ('granted', 'denied', 'unknown')
  )
);

-- idx_lead_consents_lead_id: lookup all consents for a lead within workspace
CREATE INDEX idx_lead_consents_lead_id
  ON lead_consents (workspace_id, lead_id);

-- RLS: workspace isolation
ALTER TABLE lead_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_consents_workspace_isolation ON lead_consents
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- ============================================================
-- Table: lead_tokens
-- ADR-006: Stateful lead tokens stored in DB to support SAR revocation.
-- INV-IDENTITY-006: token valid only when page_token_hash matches current/rotating page_token
--   (validated at Edge by validateLeadToken() — prevents token theft across pages)
-- token_hash: SHA-256 of clear token issued to browser — globally unique
-- page_token_hash: SHA-256 of page_token bound at issuance — page binding for INV-IDENTITY-006
-- BR-IDENTITY-013 (rule 13): browser never receives lead_id in clear; uses token_hash only
-- ============================================================
CREATE TABLE lead_tokens (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to the lead this token identifies
  lead_id          uuid        NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- SHA-256 hex of the clear token stored in browser cookie (__ftk) — exactly 64 chars
  token_hash       text        NOT NULL,

  -- SHA-256 hex of the page_token active at issuance — binding for INV-IDENTITY-006
  page_token_hash  text        NOT NULL,

  -- Timestamp when this token was issued to browser
  issued_at        timestamptz NOT NULL DEFAULT now(),

  -- Timestamp after which this token is invalid for authentication
  expires_at       timestamptz NOT NULL,

  -- Timestamp of explicit revocation (SAR, manual, security) — NULL = not revoked
  revoked_at       timestamptz,

  -- Timestamp of most recent use — for analytics and future sliding expiry
  last_used_at     timestamptz,

  -- token_hash must be exactly 64 hex characters (SHA-256)
  CONSTRAINT chk_lead_tokens_token_hash_length CHECK (length(token_hash) = 64),

  -- page_token_hash must be exactly 64 hex characters (SHA-256)
  CONSTRAINT chk_lead_tokens_page_token_hash_length CHECK (length(page_token_hash) = 64),

  -- token_hash is globally unique — same secret cannot map to two leads
  CONSTRAINT uq_lead_tokens_token_hash UNIQUE (token_hash)
);

-- idx_lead_tokens_lead_id: list all tokens for a lead within workspace
CREATE INDEX idx_lead_tokens_lead_id
  ON lead_tokens (workspace_id, lead_id);

-- RLS: workspace isolation
ALTER TABLE lead_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_tokens_workspace_isolation ON lead_tokens
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
