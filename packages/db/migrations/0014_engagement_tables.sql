-- Migration: 0013_engagement_tables
-- Sprint 1 / T-1-011 — Engagement module: lead_survey_responses, lead_icp_scores, webinar_attendances
--
-- INV-ENGAGEMENT-001: webinar_attendances unique per (workspace_id, lead_id, session_id)
-- INV-ENGAGEMENT-002: score_version non-empty in lead_icp_scores
-- INV-ENGAGEMENT-003: score_value is finite numeric (numeric type avoids NaN/Infinity from DB side)
-- INV-ENGAGEMENT-004: survey_id non-empty in lead_survey_responses
-- INV-ENGAGEMENT-005: watched_seconds >= 0 in webinar_attendances
-- BR-ENGAGEMENT-001: ICP score is versioned; rule changes produce new rows, never updates
--
-- Depends on:
--   0001_workspace_tables.sql (workspaces, set_updated_at)
--   0002_launch_table.sql (launches)
--   0004_identity_tables.sql (leads)

-- ============================================================
-- Table: lead_survey_responses
-- INV-ENGAGEMENT-004: survey_id must be non-empty
-- Append-only: no updated_at column (survey responses are immutable once inserted)
-- ============================================================
CREATE TABLE lead_survey_responses (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; BR-RBAC-002: RLS filters by app.current_workspace_id
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- The lead who submitted the survey
  lead_id          uuid        NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- Optional: associate survey response to a specific launch
  launch_id        uuid        REFERENCES launches(id) ON DELETE RESTRICT,

  -- INV-ENGAGEMENT-004: operator-defined survey identifier — must be non-empty
  -- chk_lead_survey_responses_survey_id enforces this
  survey_id        text        NOT NULL,

  -- Operator-defined version of the survey form at time of submission
  survey_version   text        NOT NULL,

  -- Arbitrary question/answer pairs from the survey form (jsonb, no PII in clear — ADR-009)
  response         jsonb       NOT NULL DEFAULT '{}',

  -- Event timestamp (when the response was recorded, not necessarily insert time)
  ts               timestamptz NOT NULL DEFAULT now(),

  -- Append-only; no updated_at
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- INV-ENGAGEMENT-004: survey_id must not be empty string
  CONSTRAINT chk_lead_survey_responses_survey_id CHECK (length(trim(survey_id)) > 0)
);

-- idx_lead_survey_responses_workspace_lead: primary access pattern (lead timeline)
CREATE INDEX idx_lead_survey_responses_workspace_lead
  ON lead_survey_responses (workspace_id, lead_id);

-- idx_lead_survey_responses_workspace_survey: cross-lead analytics by survey_id
CREATE INDEX idx_lead_survey_responses_workspace_survey
  ON lead_survey_responses (workspace_id, survey_id);

-- ============================================================
-- RLS: lead_survey_responses_workspace_isolation
-- BR-RBAC-002: cross-workspace queries prohibited
-- ============================================================
ALTER TABLE lead_survey_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_survey_responses_workspace_isolation ON lead_survey_responses
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- ============================================================
-- Table: lead_icp_scores
-- BR-ENGAGEMENT-001: versioned — rule changes produce new rows, not updates
-- INV-ENGAGEMENT-002: score_version must be non-empty
-- INV-ENGAGEMENT-003: score_value is finite numeric (DB type guarantees no Infinity;
--   application layer validates no NaN via Zod before insert)
-- Append-only: no updated_at column
-- ============================================================
CREATE TABLE lead_icp_scores (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; BR-RBAC-002: RLS filters by app.current_workspace_id
  workspace_id     uuid         NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- The lead being scored
  lead_id          uuid         NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- Optional: associate score to a specific launch
  launch_id        uuid         REFERENCES launches(id) ON DELETE RESTRICT,

  -- INV-ENGAGEMENT-002: must be non-empty — identifies the scoring rule set version
  -- BR-ENGAGEMENT-001: immutable after insert; mutation = new row with new score_version
  score_version    text         NOT NULL,

  -- INV-ENGAGEMENT-003: finite numeric; numeric(10,4) avoids float precision issues
  -- Typical operator range: 0.0000 to 100.0000
  score_value      numeric(10,4) NOT NULL,

  -- True when score_value meets the ICP threshold for this score_version
  is_icp           boolean      NOT NULL DEFAULT false,

  -- Snapshot of evaluated input fields (for audit/debugging; no PII in clear — ADR-009)
  inputs           jsonb        NOT NULL DEFAULT '{}',

  -- When the scoring evaluation was performed
  evaluated_at     timestamptz  NOT NULL DEFAULT now(),

  -- Append-only; no updated_at
  created_at       timestamptz  NOT NULL DEFAULT now(),

  -- INV-ENGAGEMENT-002: score_version must not be empty string
  CONSTRAINT chk_lead_icp_scores_score_version CHECK (length(trim(score_version)) > 0)
);

-- idx_lead_icp_scores_workspace_lead: primary access pattern (latest score per lead)
CREATE INDEX idx_lead_icp_scores_workspace_lead
  ON lead_icp_scores (workspace_id, lead_id, evaluated_at DESC);

-- idx_lead_icp_scores_workspace_version: analytics by score_version across workspace
CREATE INDEX idx_lead_icp_scores_workspace_version
  ON lead_icp_scores (workspace_id, score_version);

-- ============================================================
-- RLS: lead_icp_scores_workspace_isolation
-- BR-RBAC-002: cross-workspace queries prohibited
-- ============================================================
ALTER TABLE lead_icp_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_icp_scores_workspace_isolation ON lead_icp_scores
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- ============================================================
-- Table: webinar_attendances
-- INV-ENGAGEMENT-001: unique per (workspace_id, lead_id, session_id)
-- INV-ENGAGEMENT-005: watched_seconds >= 0
-- Mutable: upsert via webhook updates watched_seconds, max_watch_marker, left_at
-- ============================================================
CREATE TABLE webinar_attendances (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor; BR-RBAC-002: RLS filters by app.current_workspace_id
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- The attendee
  lead_id           uuid        NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,

  -- The launch this webinar session belongs to (required for engagement tracking)
  launch_id         uuid        NOT NULL REFERENCES launches(id) ON DELETE RESTRICT,

  -- Operator-defined session identifier (webinarjam room id, zoom meeting id, etc.)
  -- INV-ENGAGEMENT-001: (workspace_id, lead_id, session_id) enforced by uq below
  session_id        text        NOT NULL,

  -- Entry timestamp (required — always known from webhook)
  joined_at         timestamptz NOT NULL,

  -- Exit timestamp — nullable (session may still be in progress or unknown)
  left_at           timestamptz,

  -- INV-ENGAGEMENT-005: must be >= 0 — chk_webinar_attendances_watched_seconds
  watched_seconds   integer     NOT NULL DEFAULT 0,

  -- WatchMarker: '25%' | '50%' | '75%' | '100%' | 'completed'
  -- Nullable until first marker event is received
  -- chk_webinar_attendances_max_watch_marker enforces valid values
  max_watch_marker  text,

  -- WebinarAttendanceSource: 'webhook:webinarjam' | 'webhook:zoom' | 'manual'
  -- chk_webinar_attendances_source enforces valid values
  source            text        NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- INV-ENGAGEMENT-001: unique attendance per (workspace_id, lead_id, session_id)
  CONSTRAINT uq_webinar_attendances_workspace_lead_session
    UNIQUE (workspace_id, lead_id, session_id),

  -- INV-ENGAGEMENT-005: watched_seconds must be non-negative
  CONSTRAINT chk_webinar_attendances_watched_seconds
    CHECK (watched_seconds >= 0),

  -- WatchMarker enum — chk_webinar_attendances_max_watch_marker
  CONSTRAINT chk_webinar_attendances_max_watch_marker
    CHECK (max_watch_marker IS NULL OR max_watch_marker IN ('25%', '50%', '75%', '100%', 'completed')),

  -- WebinarAttendanceSource enum — chk_webinar_attendances_source
  CONSTRAINT chk_webinar_attendances_source
    CHECK (source IN ('webhook:webinarjam', 'webhook:zoom', 'manual'))
);

-- idx_webinar_attendances_workspace_lead: primary access pattern (lead timeline)
CREATE INDEX idx_webinar_attendances_workspace_lead
  ON webinar_attendances (workspace_id, lead_id);

-- idx_webinar_attendances_workspace_launch: launch-level attendance queries
CREATE INDEX idx_webinar_attendances_workspace_launch
  ON webinar_attendances (workspace_id, launch_id);

-- ============================================================
-- Trigger: set_updated_at for webinar_attendances
-- webinar_attendances is mutable (upsert via webhook); updated_at must be maintained
-- Function set_updated_at() is defined in 0001_workspace_tables.sql
-- ============================================================
CREATE TRIGGER trg_webinar_attendances_before_update_set_updated_at
  BEFORE UPDATE ON webinar_attendances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS: webinar_attendances_workspace_isolation
-- BR-RBAC-002: cross-workspace queries prohibited
-- ============================================================
ALTER TABLE webinar_attendances ENABLE ROW LEVEL SECURITY;

CREATE POLICY webinar_attendances_workspace_isolation ON webinar_attendances
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
