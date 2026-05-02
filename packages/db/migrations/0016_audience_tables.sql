-- Migration: 0014_audience_tables
-- Sprint 1 / T-1-009 — Audience module: audiences, audience_snapshots,
--   audience_snapshot_members, audience_sync_jobs
-- Tables: audiences, audience_snapshots, audience_snapshot_members, audience_sync_jobs
-- RLS policies, indexes, check constraints
--
-- Depends on:
--   0001_workspace_tables.sql (workspaces, set_updated_at function)
--   0004_identity_tables.sql (leads)
--
-- INV-AUDIENCE-001: (workspace_id, public_id) unique in audiences
-- INV-AUDIENCE-002: at most 1 sync job processing per (audience_id, platform_resource_id)
--   (advisory lock enforced at service layer — not DB constraint)
-- INV-AUDIENCE-005: consent filter applied before snapshot member insert (service layer)
-- INV-AUDIENCE-006: max 2 active snapshots per audience (cron archive enforced)
-- BR-AUDIENCE-001: destination_strategy ∈ AudienceDestinationStrategy
-- BR-AUDIENCE-002: sync lock prevents concurrent processing (service layer)
-- BR-AUDIENCE-003: diff between snapshot T and T-1 (service layer)
-- BR-AUDIENCE-004: consent_policy applied before member insert (service layer)

-- ============================================================
-- Table: audiences
-- INV-AUDIENCE-001: uq_audiences_workspace_public_id
-- BR-AUDIENCE-001: chk_audiences_destination_strategy
-- AudienceStatus: 'draft' | 'active' | 'paused' | 'archived' — chk_audiences_status
-- Platform: 'meta' | 'google' — chk_audiences_platform
-- ============================================================
CREATE TABLE audiences (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; on delete restrict prevents accidental workspace removal
  workspace_id         uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- INV-AUDIENCE-001: public_id unique per workspace (uq_audiences_workspace_public_id below)
  -- Public-facing identifier; max 64 chars
  public_id            text        NOT NULL,

  -- Human-readable name for this audience definition
  name                 text        NOT NULL,

  -- Platform enum: 'meta' | 'google'
  platform             text        NOT NULL,

  -- BR-AUDIENCE-001: AudienceDestinationStrategy
  -- 'meta_custom_audience' | 'google_data_manager' |
  -- 'google_ads_api_allowlisted' | 'disabled_not_eligible'
  destination_strategy text        NOT NULL,

  -- INV-AUDIENCE-007: DSL-validated query definition (Zod validated at service layer)
  -- Schema: { type: 'builder', all: [...] }
  query_definition     jsonb       NOT NULL,

  -- BR-AUDIENCE-004: consent finalidades required before snapshot generation
  -- Schema: { require_customer_match?: boolean, ... }
  consent_policy       jsonb       NOT NULL DEFAULT '{}',

  -- AudienceStatus: 'draft' | 'active' | 'paused' | 'archived'
  -- Soft-delete via status='archived'; no physical delete
  status               text        NOT NULL DEFAULT 'draft',

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Platform must be a canonical Platform value
  CONSTRAINT chk_audiences_platform CHECK (
    platform IN ('meta', 'google')
  ),

  -- BR-AUDIENCE-001: destination_strategy must be a canonical AudienceDestinationStrategy value
  CONSTRAINT chk_audiences_destination_strategy CHECK (
    destination_strategy IN (
      'meta_custom_audience',
      'google_data_manager',
      'google_ads_api_allowlisted',
      'disabled_not_eligible'
    )
  ),

  -- AudienceStatus must be canonical
  CONSTRAINT chk_audiences_status CHECK (
    status IN ('draft', 'active', 'paused', 'archived')
  ),

  -- public_id length constraint
  CONSTRAINT chk_audiences_public_id_length CHECK (
    length(public_id) BETWEEN 1 AND 64
  )
);

-- Trigger: auto-update updated_at (reuses set_updated_at() from 0001)
CREATE TRIGGER trg_audiences_before_update_set_updated_at
  BEFORE UPDATE ON audiences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- INV-AUDIENCE-001: public_id is unique per workspace
CREATE UNIQUE INDEX uq_audiences_workspace_public_id
  ON audiences (workspace_id, public_id);

-- idx_audiences_workspace_id: supports RLS filter + list queries
CREATE INDEX idx_audiences_workspace_id
  ON audiences (workspace_id);

-- idx_audiences_workspace_status: filter by active/paused audiences
CREATE INDEX idx_audiences_workspace_status
  ON audiences (workspace_id, status);

-- ============================================================
-- RLS: workspace isolation for audiences
-- Application sets app.current_workspace_id via SET LOCAL at request start.
-- ============================================================
ALTER TABLE audiences ENABLE ROW LEVEL SECURITY;

CREATE POLICY audiences_workspace_isolation ON audiences
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Table: audience_snapshots
-- INV-AUDIENCE-006: max 2 retention_status='active' per audience (cron/archive enforced)
-- BR-AUDIENCE-003: snapshot_hash is deterministic hash of member set — no-op detection
-- AudienceSnapshotRetention: 'active' | 'archived' | 'purged'
-- ============================================================
CREATE TABLE audience_snapshots (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to the audience this snapshot materialises
  audience_id       uuid        NOT NULL REFERENCES audiences(id) ON DELETE RESTRICT,

  -- BR-AUDIENCE-003: deterministic hash of the full member set at generation time
  -- If equal to previous snapshot hash, no sync job is created (no-op guard)
  snapshot_hash     text        NOT NULL,

  -- Timestamp when this snapshot was generated (NOT when the row was created)
  generated_at      timestamptz NOT NULL DEFAULT now(),

  -- Number of members in this snapshot at generation time
  member_count      integer     NOT NULL DEFAULT 0,

  -- INV-AUDIENCE-006: AudienceSnapshotRetention
  -- 'active'   — current or second-to-latest; members retained
  -- 'archived' — older; members retained up to 30 days
  -- 'purged'   — members deleted by retention job; row kept as audit record
  retention_status  text        NOT NULL DEFAULT 'active',

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- AudienceSnapshotRetention must be canonical
  CONSTRAINT chk_audience_snapshots_retention_status CHECK (
    retention_status IN ('active', 'archived', 'purged')
  ),

  -- member_count must be non-negative
  CONSTRAINT chk_audience_snapshots_member_count CHECK (
    member_count >= 0
  )
);

-- idx_audience_snapshots_audience_id: list snapshots for an audience in order
CREATE INDEX idx_audience_snapshots_audience_id
  ON audience_snapshots (workspace_id, audience_id, generated_at DESC);

-- idx_audience_snapshots_workspace_id: supports RLS filter
CREATE INDEX idx_audience_snapshots_workspace_id
  ON audience_snapshots (workspace_id);

-- idx_audience_snapshots_active: find active snapshots for retention check (INV-AUDIENCE-006)
CREATE INDEX idx_audience_snapshots_active
  ON audience_snapshots (audience_id, generated_at DESC)
  WHERE retention_status = 'active';

-- ============================================================
-- RLS: workspace isolation for audience_snapshots
-- ============================================================
ALTER TABLE audience_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY audience_snapshots_workspace_isolation ON audience_snapshots
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);


-- ============================================================
-- Table: audience_snapshot_members
-- Composite PK: (snapshot_id, lead_id) — junction table
-- on delete cascade from snapshot: purging a snapshot deletes its members
-- on delete restrict from lead: cannot delete a lead in an active snapshot
--
-- INV-AUDIENCE-005 / BR-AUDIENCE-004: consent filter applied BEFORE insert
--   (evaluateAudience() service layer excludes leads without required consent)
--
-- NOTE: workspace_id is omitted from this junction table.
--   RLS isolation is achieved transitively: queries always JOIN through
--   audience_snapshots which is protected by its own RLS policy.
-- ============================================================
CREATE TABLE audience_snapshot_members (
  -- FK to snapshot — on delete cascade: deleting snapshot removes members (purge path)
  snapshot_id  uuid  NOT NULL REFERENCES audience_snapshots(id) ON DELETE CASCADE,

  -- FK to lead — on delete restrict: lead cannot be deleted while in an active snapshot
  lead_id      uuid  NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  PRIMARY KEY (snapshot_id, lead_id)
);

-- idx_audience_snapshot_members_lead_id: reverse lookup — which snapshots include a lead
CREATE INDEX idx_audience_snapshot_members_lead_id
  ON audience_snapshot_members (lead_id);

-- No separate RLS on this junction table — access is gated transitively through
-- audience_snapshots RLS. See comment above.


-- ============================================================
-- Table: audience_sync_jobs
-- INV-AUDIENCE-002 / BR-AUDIENCE-002: lock at (audience_id, platform_resource_id)
--   enforced at service layer via acquireSyncLock()
-- BR-AUDIENCE-001: dispatcher rejects API call when strategy='disabled_not_eligible'
-- BR-AUDIENCE-003: diff from (snapshot_id) minus (prev_snapshot_id)
-- SyncJobStatus: 'pending' | 'processing' | 'succeeded' | 'failed'
-- ============================================================
CREATE TABLE audience_sync_jobs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  workspace_id         uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- FK to the audience being synced
  audience_id          uuid        NOT NULL REFERENCES audiences(id) ON DELETE RESTRICT,

  -- FK to the current snapshot (members at T)
  snapshot_id          uuid        NOT NULL REFERENCES audience_snapshots(id) ON DELETE RESTRICT,

  -- FK to the previous snapshot (members at T-1) — NULL on first sync
  -- BR-AUDIENCE-003: diff = snapshot_id members \ prev_snapshot_id members
  prev_snapshot_id     uuid        REFERENCES audience_snapshots(id) ON DELETE RESTRICT,

  -- SyncJobStatus: 'pending' | 'processing' | 'succeeded' | 'failed'
  status               text        NOT NULL DEFAULT 'pending',

  -- Planned diff counts (set by job planner based on SET difference)
  -- BR-AUDIENCE-003: calculated before dispatch
  planned_additions    integer     NOT NULL DEFAULT 0,
  planned_removals     integer     NOT NULL DEFAULT 0,

  -- Actual sent counts (set by dispatcher after API calls complete)
  -- BR-AUDIENCE-001: both must be 0 for disabled_not_eligible
  sent_additions       integer     NOT NULL DEFAULT 0,
  sent_removals        integer     NOT NULL DEFAULT 0,

  -- Platform-assigned operation/job ID returned by Meta/Google API response
  platform_job_id      text,

  -- Platform resource ID (e.g. Meta custom audience ID, Google remarketing list ID)
  -- Used as part of lock key for INV-AUDIENCE-002 (audience_id + platform_resource_id)
  platform_resource_id text,

  -- Error tracking — populated when status transitions to 'failed'
  error_code           text,
  error_message        text,

  -- Job lifecycle timestamps
  started_at           timestamptz,
  finished_at          timestamptz,

  -- Retry scheduling — NULL when no retry is planned; populated by dispatcher on failure
  next_attempt_at      timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- SyncJobStatus must be canonical
  CONSTRAINT chk_audience_sync_jobs_status CHECK (
    status IN ('pending', 'processing', 'succeeded', 'failed')
  ),

  -- Diff counts must be non-negative
  CONSTRAINT chk_audience_sync_jobs_planned_additions CHECK (planned_additions >= 0),
  CONSTRAINT chk_audience_sync_jobs_planned_removals  CHECK (planned_removals >= 0),
  CONSTRAINT chk_audience_sync_jobs_sent_additions    CHECK (sent_additions >= 0),
  CONSTRAINT chk_audience_sync_jobs_sent_removals     CHECK (sent_removals >= 0)
);

-- Trigger: auto-update updated_at (reuses set_updated_at() from 0001)
CREATE TRIGGER trg_audience_sync_jobs_before_update_set_updated_at
  BEFORE UPDATE ON audience_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- idx_audience_sync_jobs_workspace_id: supports RLS filter
CREATE INDEX idx_audience_sync_jobs_workspace_id
  ON audience_sync_jobs (workspace_id);

-- idx_audience_sync_jobs_audience_id: list jobs per audience ordered by creation
CREATE INDEX idx_audience_sync_jobs_audience_id
  ON audience_sync_jobs (workspace_id, audience_id, created_at DESC);

-- idx_audience_sync_jobs_status: cron picks up pending/failed jobs
CREATE INDEX idx_audience_sync_jobs_status
  ON audience_sync_jobs (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- idx_audience_sync_jobs_processing_lock: supports INV-AUDIENCE-002 lock check
-- (find jobs in processing state for a given audience + platform_resource_id)
CREATE INDEX idx_audience_sync_jobs_processing_lock
  ON audience_sync_jobs (audience_id, platform_resource_id)
  WHERE status = 'processing';

-- ============================================================
-- RLS: workspace isolation for audience_sync_jobs
-- ============================================================
ALTER TABLE audience_sync_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audience_sync_jobs_workspace_isolation ON audience_sync_jobs
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
