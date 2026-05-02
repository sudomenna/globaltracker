-- Migration: 0018_event_tables
-- Sprint 1 / T-1-005 — Event schema (MOD-EVENT)
-- Tables: events (partitioned), raw_events
-- Constraints, indexes, RLS policies
--
-- Depends on:
--   0001_workspace_tables.sql (workspaces table, set_updated_at function)
--   0002_launch_table.sql     (launches table)
--   0004_identity_tables.sql  (leads table)
--   0017_page_tables.sql      (pages table)
--
-- PARTITIONING NOTE:
--   events is declared PARTITION BY RANGE (received_at).
--   Drizzle ORM ≥ 0.30 does not emit PARTITION BY from pgTable() definitions.
--   The parent table and initial partition are declared manually below.
--   The TypeScript schema file (packages/db/src/schema/event.ts) defines
--   the column layout; each partition inherits it automatically.
--   A monthly cron job must CREATE each future partition before data arrives.
--   Partitions older than 13 months are dropped by the retention job.

-- ============================================================
-- Table: events (parent — partitioned by received_at)
-- INV-EVENT-001: (workspace_id, event_id) unique — uq_events_workspace_event_id
-- INV-EVENT-002: event_time may be clamped to received_at by Edge (BR-EVENT-003)
-- INV-EVENT-004: user_data jsonb accepts only canonical keys — Zod enforced at Edge
-- INV-EVENT-006: consent_snapshot is always present — Edge enforced
-- INV-EVENT-007: lead_id resolved by processor when lead_token valid — processor enforced
-- BR-EVENT-002: idempotência por (workspace_id, event_id)
-- BR-RBAC-002: workspace_id multi-tenant anchor; RLS enforces app.current_workspace_id
-- ADR-004: events are derived from raw_events by ingestion processor (fast-accept model)
-- ============================================================
CREATE TABLE events (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to launches — optional; NULL when event has no launch context
  launch_id           uuid        REFERENCES launches(id) ON DELETE RESTRICT,

  -- FK to pages — optional; NULL for events without a page context
  page_id             uuid        REFERENCES pages(id) ON DELETE RESTRICT,

  -- FK to leads — optional; anonymous events have lead_id IS NULL
  -- INV-EVENT-007: populated by processor when lead_token is valid (BR-EVENT-006)
  lead_id             uuid        REFERENCES leads(id) ON DELETE RESTRICT,

  -- visitor_id: reserved for Fases 1-2; populated in Fase 3
  visitor_id          text,

  -- event_id: client-supplied idempotency key (text, not uuid — client may use any format)
  -- INV-EVENT-001: unique per workspace — uq_events_workspace_event_id
  -- BR-EVENT-002: idempotência por (workspace_id, event_id)
  -- chk_events_event_id_length: 1..256 characters
  event_id            text        NOT NULL,

  -- event_name: canonical (PageView, Lead, Purchase, …) or 'custom:<name>'
  -- chk_events_event_name_length: 1..128 characters
  event_name          text        NOT NULL,

  -- event_source: origin of the event
  -- EventSource canonical values — chk_events_event_source
  event_source        text        NOT NULL,

  -- schema_version: bumped when event payload contract changes
  schema_version      integer     NOT NULL DEFAULT 1,

  -- event_time: client-reported timestamp (may have been clamped — INV-EVENT-002)
  -- BR-EVENT-003: clamp when abs(event_time - received_at) > EVENT_TIME_CLAMP_WINDOW_SEC (300s)
  event_time          timestamptz NOT NULL,

  -- received_at: server-side timestamp; also the PARTITION KEY
  -- Must be NOT NULL so partition range pruning is effective
  received_at         timestamptz NOT NULL DEFAULT now(),

  -- attribution: touch attribution snapshot at ingestion time (jsonb)
  attribution         jsonb       NOT NULL DEFAULT '{}',

  -- user_data: hashed/pseudonymous identifiers for ad platform matching
  -- INV-EVENT-004: only canonical keys — {em, ph, external_id_hash, fbc, fbp, _gcl_au, client_id_ga4, session_id_ga4}
  -- BR-EVENT-005: user_data canonical only; Zod rejects PII keys (email, phone, name, ip)
  user_data           jsonb       NOT NULL DEFAULT '{}',

  -- custom_data: arbitrary event-specific data (product value, order_id, etc.)
  custom_data         jsonb       NOT NULL DEFAULT '{}',

  -- consent_snapshot: 5-finality consent state at ingestion time
  -- INV-EVENT-006: present on every event, even if all values are 'unknown'
  -- Keys: analytics, marketing, ad_user_data, ad_personalization, customer_match
  -- Values per key: 'granted' | 'denied' | 'unknown'
  consent_snapshot    jsonb       NOT NULL DEFAULT '{}',

  -- request_context: sanitised HTTP context (ip_hash, ua_hash, referrer, origin, etc.)
  -- No PII in clear — ip and ua are hashed before storage (BR-PRIVACY-001)
  request_context     jsonb       NOT NULL DEFAULT '{}',

  -- processing_status: ingestion pipeline lifecycle
  -- EventProcessingStatus: 'accepted' | 'enriched' | 'rejected_archived_launch' | 'rejected_consent' | 'rejected_validation'
  processing_status   text        NOT NULL DEFAULT 'accepted',

  created_at          timestamptz NOT NULL DEFAULT now(),

  -- INV-EVENT-001 / BR-EVENT-002: idempotency constraint
  -- NOTE: on a partitioned table, unique constraints must include the partition key (received_at).
  -- We keep (workspace_id, event_id) as the logical unique constraint; the processor must
  -- handle unique violations from any partition (INSERT ... ON CONFLICT DO NOTHING at app layer).
  -- A non-unique index on (workspace_id, event_id) provides fast lookups across partitions.
  -- If PG 15+ supports global unique index on partitioned table, this may be revisited via ADR.
  -- For now: uq_events_workspace_event_id is declared per partition; global uniqueness is enforced
  -- by the processor catching unique violations + KV replay protection (BR-EVENT-004 / BR-EVENT-002).
  CONSTRAINT uq_events_workspace_event_id UNIQUE (workspace_id, event_id, received_at),

  -- event_id must be between 1 and 256 characters
  CONSTRAINT chk_events_event_id_length CHECK (length(event_id) BETWEEN 1 AND 256),

  -- event_name must be between 1 and 128 characters
  CONSTRAINT chk_events_event_name_length CHECK (length(event_name) BETWEEN 1 AND 128),

  -- EventSource canonical values — from docs/30-contracts/01-enums.md
  CONSTRAINT chk_events_event_source CHECK (
    event_source IN (
      'tracker',
      'webhook:hotmart', 'webhook:kiwify', 'webhook:stripe',
      'webhook:webinarjam', 'webhook:typeform', 'webhook:tally',
      'redirector', 'system', 'admin'
    )
  ),

  -- EventProcessingStatus canonical values — from docs/30-contracts/01-enums.md
  CONSTRAINT chk_events_processing_status CHECK (
    processing_status IN (
      'accepted', 'enriched',
      'rejected_archived_launch', 'rejected_consent', 'rejected_validation'
    )
  ),

  -- schema_version must be positive
  CONSTRAINT chk_events_schema_version CHECK (schema_version >= 1)

) PARTITION BY RANGE (received_at);

-- Initial partition covering May 2026 data
-- Cron job creates future partitions monthly, one month ahead.
-- Retention job drops partitions older than 13 months.
CREATE TABLE events_2026_05 PARTITION OF events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE events_2026_06 PARTITION OF events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Index: lookup events by workspace (RLS support + list queries)
-- Created on parent; Postgres propagates to all partitions automatically (PG 11+).
CREATE INDEX idx_events_workspace_id
  ON events (workspace_id);

-- Index: lookup events by lead (lead timeline queries)
CREATE INDEX idx_events_lead_id
  ON events (lead_id)
  WHERE lead_id IS NOT NULL;

-- Index: lookup events by page (page analytics)
CREATE INDEX idx_events_page_id
  ON events (page_id)
  WHERE page_id IS NOT NULL;

-- Index: fast event_id replay lookup (workspace-scoped)
-- Supports processor deduplication check — separate from unique constraint above.
CREATE INDEX idx_events_workspace_event_id
  ON events (workspace_id, event_id);

-- Index: time-range queries within a workspace (dashboard, funnel)
CREATE INDEX idx_events_workspace_received_at
  ON events (workspace_id, received_at DESC);

-- Index: processing_status filter (processor retry queue, reprocessing jobs)
CREATE INDEX idx_events_processing_status_received_at
  ON events (processing_status, received_at)
  WHERE processing_status IN ('accepted', 'enriched');

-- RLS: workspace isolation — app.current_workspace_id must be set per request
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

CREATE POLICY events_workspace_isolation ON events
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Table: raw_events
-- Fast-accept durability buffer (ADR-004).
-- BR-EVENT-001: Edge inserts here BEFORE returning 202.
-- INV-EVENT-005: Edge persiste em raw_events antes de retornar 202.
-- Retention: 7 days. Hard delete by background job after processed + TTL.
-- See docs/30-contracts/02-db-schema-conventions.md § Soft-delete vs hard-delete.
-- BR-RBAC-002: workspace_id multi-tenant anchor; RLS enforces app.current_workspace_id.
-- ============================================================
CREATE TABLE raw_events (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to pages — optional; Edge resolves page_id from page_token before insert
  page_id             uuid        REFERENCES pages(id) ON DELETE RESTRICT,

  -- payload: full original event payload as received (jsonb)
  -- Zod validates shape at Edge before insert; processor handles PII hashing
  payload             jsonb       NOT NULL,

  -- headers_sanitized: sanitised request headers (ip_hash, ua_hash, referrer, origin, etc.)
  -- No raw IPs or user agents stored in clear (BR-PRIVACY-001)
  headers_sanitized   jsonb       NOT NULL DEFAULT '{}',

  -- received_at: set by Edge at insert time
  -- INV-EVENT-005: set before 202 is returned to client
  received_at         timestamptz NOT NULL DEFAULT now(),

  -- processed_at: set by ingestion processor when handling completes
  -- NULL while status='pending' or status='failed'
  processed_at        timestamptz,

  -- processing_status: RawEventStatus lifecycle
  -- RawEventStatus: 'pending' | 'processed' | 'failed' | 'discarded'
  processing_status   text        NOT NULL DEFAULT 'pending',

  -- processing_error: sanitised error message when status='failed' or 'discarded'
  -- NULL when status='pending' or 'processed'; no PII in error messages
  processing_error    text,

  -- RawEventStatus canonical values — from docs/30-contracts/01-enums.md
  CONSTRAINT chk_raw_events_processing_status CHECK (
    processing_status IN ('pending', 'processed', 'failed', 'discarded')
  )
);

-- Index: processor picks up pending rows efficiently
-- Partial index on pending/failed only — active processing queue is a small fraction of table
CREATE INDEX idx_raw_events_processing_status_received_at
  ON raw_events (processing_status, received_at)
  WHERE processing_status IN ('pending', 'failed');

-- Index: workspace-scoped lookup (RLS support + operator queries)
CREATE INDEX idx_raw_events_workspace_id
  ON raw_events (workspace_id);

-- Index: page-scoped lookup (debugging, page-level analytics pre-normalisation)
CREATE INDEX idx_raw_events_page_id
  ON raw_events (page_id)
  WHERE page_id IS NOT NULL;

-- Index: retention job deletes processed rows older than 7 days
-- Scans processed+discarded rows by received_at
CREATE INDEX idx_raw_events_received_at
  ON raw_events (received_at);

-- RLS: workspace isolation — app.current_workspace_id must be set per request
ALTER TABLE raw_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY raw_events_workspace_isolation ON raw_events
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Down migration (rollback)
-- Execute in reverse dependency order: raw_events before events partitions before parent
-- ============================================================
-- DROP TABLE IF EXISTS raw_events;
-- DROP TABLE IF EXISTS events_2026_06;
-- DROP TABLE IF EXISTS events_2026_05;
-- DROP TABLE IF EXISTS events;
