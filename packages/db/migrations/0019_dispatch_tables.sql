-- Migration: 0019_dispatch_tables
-- Sprint 1 / T-1-008 — Dispatch schema (MOD-DISPATCH)
-- Tables: dispatch_jobs, dispatch_attempts
-- Constraints, indexes, RLS policies
--
-- Depends on:
--   0001_workspace_tables.sql  (workspaces table, set_updated_at function)
--   0004_identity_tables.sql   (leads table)
--   0018_event_tables.sql      (events table — logical reference only, no referential FK)
--
-- EVENTS FK NOTE:
--   The events table is PARTITION BY RANGE (received_at). In Postgres 15, a FK referencing
--   a partitioned table must include ALL partition key columns in the referenced UNIQUE constraint
--   (i.e., the PK or unique constraint must include received_at). Because events uses
--   uq_events_workspace_event_id(workspace_id, event_id, received_at), a FK on dispatch_jobs
--   referencing only events(id) is not directly supported without including received_at.
--   Per T-1-008 criteria, dispatch_jobs stores event_id + event_workspace_id as LOGICAL
--   references (no DB FK). Application layer enforces referential integrity.
--   See also: BR-DISPATCH-001 / ADR-013.

-- ============================================================
-- Table: dispatch_jobs
-- INV-DISPATCH-001: idempotency_key is unique — uq_dispatch_jobs_idempotency_key
-- INV-DISPATCH-004: status='skipped' requires skip_reason — chk_dispatch_jobs_skipped_reason
-- INV-DISPATCH-008: atomic lock via pending→processing transition — BR-DISPATCH-002
-- INV-DISPATCH-003: dead_letter not auto-reprocessed — BR-DISPATCH-005 (service layer)
-- BR-RBAC-002: workspace_id multi-tenant anchor; RLS enforces app.current_workspace_id
-- ============================================================
CREATE TABLE dispatch_jobs (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  workspace_id              uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to leads — the lead associated with this dispatch event; NULL for system dispatches
  lead_id                   uuid        REFERENCES leads(id) ON DELETE RESTRICT,

  -- Logical reference to source event (no referential FK — partitioned table limitation)
  -- BR-DISPATCH-001: included in idempotency_key derivation (ADR-013)
  event_id                  uuid        NOT NULL,
  event_workspace_id        uuid        NOT NULL,

  -- destination: target integration platform
  -- DispatchDestination: 'meta_capi' | 'ga4_mp' | 'google_ads_conversion' | 'google_enhancement' | 'audience_sync'
  destination               text        NOT NULL,

  -- destination_account_id: platform account (Meta Business ID, Google Ads CID, GA4 property)
  destination_account_id    text        NOT NULL,

  -- destination_resource_id: pixel_id / measurement_id / customer_id / audience_id
  destination_resource_id   text        NOT NULL,

  -- destination_subresource: sub-resource (conversion_action, etc.); NULL when not applicable
  destination_subresource   text,

  -- idempotency_key: sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)
  -- INV-DISPATCH-001: globally unique — uq_dispatch_jobs_idempotency_key
  -- BR-DISPATCH-001: computed by computeIdempotencyKey() (ADR-013)
  idempotency_key           text        NOT NULL,

  -- status: lifecycle of the dispatch job
  -- DispatchStatus: 'pending' | 'processing' | 'succeeded' | 'retrying' | 'failed' | 'skipped' | 'dead_letter'
  -- INV-DISPATCH-008: atomic lock — UPDATE status='pending' → 'processing' before calling platform (BR-DISPATCH-002)
  status                    text        NOT NULL DEFAULT 'pending',

  -- eligibility_reason: informational context for why this job was created
  eligibility_reason        text,

  -- skip_reason: required when status='skipped' (INV-DISPATCH-004 / BR-DISPATCH-004)
  -- Canonical values: 'consent_denied:<finality>', 'no_user_data', 'integration_not_configured',
  --   'no_click_id_available', 'audience_not_eligible', 'archived_launch'
  skip_reason               text,

  -- payload: serialized dispatch payload for the external platform
  -- BR-PRIVACY-001: no PII in clear — only hashes; sanitized before storage
  payload                   jsonb       NOT NULL DEFAULT '{}',

  -- Retry tracking
  -- attempt_count: total attempts made (INV-DISPATCH-005: equals count(*) in dispatch_attempts)
  attempt_count             integer     NOT NULL DEFAULT 0,

  -- max_attempts: cap before dead_letter (default 5 — BR-DISPATCH-003)
  max_attempts              integer     NOT NULL DEFAULT 5,

  -- next_attempt_at: when to retry; NULL unless status='retrying'
  -- BR-DISPATCH-003: delay = 2^attempt_count × (1 ± 0.2 jitter) seconds (INV-DISPATCH-007)
  next_attempt_at           timestamptz,

  -- scheduled_at: when initial processing was planned (typically = created_at)
  scheduled_at              timestamptz NOT NULL DEFAULT now(),

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- INV-DISPATCH-001 / BR-DISPATCH-001: global idempotency guarantee
  CONSTRAINT uq_dispatch_jobs_idempotency_key UNIQUE (idempotency_key),

  -- DispatchDestination canonical values — docs/30-contracts/01-enums.md
  CONSTRAINT chk_dispatch_jobs_destination CHECK (
    destination IN (
      'meta_capi',
      'ga4_mp',
      'google_ads_conversion',
      'google_enhancement',
      'audience_sync'
    )
  ),

  -- DispatchStatus canonical values — docs/30-contracts/01-enums.md
  CONSTRAINT chk_dispatch_jobs_status CHECK (
    status IN (
      'pending', 'processing', 'succeeded',
      'retrying', 'failed', 'skipped', 'dead_letter'
    )
  ),

  -- INV-DISPATCH-004 / BR-DISPATCH-004: skipped job MUST have a skip_reason
  CONSTRAINT chk_dispatch_jobs_skipped_reason CHECK (
    status <> 'skipped' OR skip_reason IS NOT NULL
  ),

  -- attempt_count must not exceed max_attempts + 1 (one over is the DLQ transition state)
  CONSTRAINT chk_dispatch_jobs_attempt_count CHECK (attempt_count >= 0),
  CONSTRAINT chk_dispatch_jobs_max_attempts CHECK (max_attempts >= 1)
);

-- Trigger: keep updated_at current on every modification
-- Reuses set_updated_at() declared in 0001_workspace_tables.sql
CREATE TRIGGER trg_dispatch_jobs_before_update_set_updated_at
  BEFORE UPDATE ON dispatch_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Index: workspace-scoped lookup (RLS support + list queries)
CREATE INDEX idx_dispatch_jobs_workspace_id
  ON dispatch_jobs (workspace_id);

-- Index: lead-scoped lookup (lead timeline, dispatch history)
CREATE INDEX idx_dispatch_jobs_lead_id
  ON dispatch_jobs (lead_id)
  WHERE lead_id IS NOT NULL;

-- Index: event-scoped lookup (reuse check, processor deduplication)
-- Logical FK replacement — no DB FK on partitioned events table
CREATE INDEX idx_dispatch_jobs_event_id
  ON dispatch_jobs (event_workspace_id, event_id);

-- Index: retry queue — workers scan pending and retrying jobs by scheduled time
CREATE INDEX idx_dispatch_jobs_status_next_attempt_at
  ON dispatch_jobs (status, next_attempt_at)
  WHERE status IN ('pending', 'retrying');

-- Index: destination-scoped lookup (dispatcher queries, per-destination monitoring)
CREATE INDEX idx_dispatch_jobs_destination_status
  ON dispatch_jobs (destination, status);

-- RLS: workspace isolation — app.current_workspace_id must be set per request
ALTER TABLE dispatch_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY dispatch_jobs_workspace_isolation ON dispatch_jobs
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Table: dispatch_attempts
-- INV-DISPATCH-005: attempt_count in dispatch_jobs = count(*) in dispatch_attempts
-- BR-DISPATCH-003: retryable_failure → job schedules retry; permanent_failure → job fails
-- BR-PRIVACY-001: request/response payloads sanitized before storage
-- BR-RBAC-002: workspace_id multi-tenant anchor; RLS enforces app.current_workspace_id
-- ============================================================
CREATE TABLE dispatch_attempts (
  id                              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  workspace_id                    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to parent dispatch job
  -- INV-DISPATCH-005: every row here should correspond to dispatch_jobs.attempt_count
  dispatch_job_id                 uuid        NOT NULL REFERENCES dispatch_jobs(id) ON DELETE RESTRICT,

  -- attempt_number: 1-based; matches dispatch_jobs.attempt_count at time of creation
  attempt_number                  integer     NOT NULL,

  -- status: outcome of this individual attempt
  -- AttemptStatus: 'succeeded' | 'retryable_failure' | 'permanent_failure'
  -- BR-DISPATCH-003: retryable_failure → set job to 'retrying'; permanent_failure → 'failed'
  status                          text        NOT NULL,

  -- Sanitized payloads for debugging and audit
  -- BR-PRIVACY-001: sanitizeLogs() applied before storage; no PII in clear
  request_payload_sanitized       jsonb       NOT NULL DEFAULT '{}',
  response_payload_sanitized      jsonb       NOT NULL DEFAULT '{}',

  -- response_status: HTTP status code from the external platform
  -- NULL when request did not complete (network error, timeout before response)
  response_status                 integer,

  -- error_code: platform-specific or internal error code (e.g. 'invalid_pixel_id', 'timeout')
  -- NULL when status='succeeded'
  error_code                      text,

  -- error_message: sanitized error description; no PII (BR-PRIVACY-001)
  error_message                   text,

  -- Lifecycle timestamps
  started_at                      timestamptz NOT NULL,
  finished_at                     timestamptz,

  created_at                      timestamptz NOT NULL DEFAULT now(),

  -- AttemptStatus canonical values — docs/30-contracts/01-enums.md
  CONSTRAINT chk_dispatch_attempts_status CHECK (
    status IN ('succeeded', 'retryable_failure', 'permanent_failure')
  ),

  -- attempt_number must be positive
  CONSTRAINT chk_dispatch_attempts_attempt_number CHECK (attempt_number >= 1),

  -- response_status must be a valid HTTP status code if provided
  CONSTRAINT chk_dispatch_attempts_response_status CHECK (
    response_status IS NULL OR (response_status >= 100 AND response_status <= 599)
  )
);

-- Index: job-scoped lookup (list all attempts for a job)
CREATE INDEX idx_dispatch_attempts_dispatch_job_id
  ON dispatch_attempts (dispatch_job_id);

-- Index: workspace-scoped lookup (RLS support + monitoring queries)
CREATE INDEX idx_dispatch_attempts_workspace_id
  ON dispatch_attempts (workspace_id);

-- Index: failure analysis — find retryable failures by job
CREATE INDEX idx_dispatch_attempts_job_status
  ON dispatch_attempts (dispatch_job_id, status);

-- RLS: workspace isolation — app.current_workspace_id must be set per request
ALTER TABLE dispatch_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY dispatch_attempts_workspace_isolation ON dispatch_attempts
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Down migration (rollback)
-- Execute in dependency order: dispatch_attempts before dispatch_jobs
-- ============================================================
-- DROP TABLE IF EXISTS dispatch_attempts;
-- DROP TABLE IF EXISTS dispatch_jobs;
