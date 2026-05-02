-- Migration: 0012_audit_log_table
-- Sprint 1 / T-1-012 — Audit log schema foundation
-- Tables: audit_log
-- Constraints: chk_audit_log_actor_type (INV-AUDIT-002)
-- Indexes: idx_audit_log_workspace_ts, idx_audit_log_entity, idx_audit_log_actor
-- Triggers: trg_audit_log_before_update_block, trg_audit_log_before_delete_block (INV-AUDIT-001)
-- RLS: audit_log_workspace_isolation
-- BR-AUDIT-001: append-only — no UPDATE or DELETE allowed
-- AUTHZ-004: manual UPDATE and DELETE are blocked at the DB trigger layer
-- AUTHZ-012: recordAuditEntry() is the only permitted insert path

-- ============================================================
-- Table: audit_log
-- BR-AUDIT-001: append-only event log; purge only via retention cron (ADR-014)
-- AUTHZ-012: every sensitive mutation must produce an entry via recordAuditEntry()
-- INV-AUDIT-002: actor_type ∈ ('user', 'system', 'api_key')
-- INV-AUDIT-003: request_context must be sanitized (no PII in clear) — enforced by app layer
-- ============================================================
CREATE TABLE audit_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor
  -- BR-RBAC-002: RLS policy filters by app.current_workspace_id
  -- on delete restrict: workspaces with audit entries cannot be hard-deleted
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- actor_id: UUID string for user/api_key actors, or literal 'system' for automated processes
  actor_id        text        NOT NULL,

  -- INV-AUDIT-002: AuditActorType = ('user', 'system', 'api_key')
  -- chk_audit_log_actor_type enforces valid values
  actor_type      text        NOT NULL,

  -- Canonical audit actions (AuditAction in 30-contracts/01-enums.md):
  -- 'create', 'update', 'delete', 'rotate', 'revoke',
  -- 'erase_sar', 'merge_leads', 'read_pii_decrypted', 'sync_audience', 'reprocess_dlq'
  -- AUTHZ-001: action='read_pii_decrypted' is the marker for decrypted PII access
  action          text        NOT NULL,

  -- entity_type examples: 'page', 'page_token', 'lead', 'audience', 'launch'
  entity_type     text        NOT NULL,

  -- entity_id is text for cross-entity flexibility (UUID strings, slugs, etc.)
  entity_id       text        NOT NULL,

  -- State snapshots: NULL is valid (before=NULL for 'create', after=NULL for 'delete')
  before          jsonb,
  after           jsonb,

  -- Append-only timestamp — no updated_at column (INV-AUDIT-001)
  ts              timestamptz NOT NULL DEFAULT now(),

  -- INV-AUDIT-003: sanitized context — only ip_hash, ua_hash, request_id allowed
  -- Validation is enforced by recordAuditEntry() at the application layer
  request_context jsonb,

  -- INV-AUDIT-002: actor_type must be one of the canonical AuditActorType values
  CONSTRAINT chk_audit_log_actor_type CHECK (
    actor_type IN ('user', 'system', 'api_key')
  )
);

-- idx_audit_log_workspace_ts: primary access pattern — workspace timeline queries
CREATE INDEX idx_audit_log_workspace_ts
  ON audit_log (workspace_id, ts DESC);

-- idx_audit_log_entity: entity-scoped audit history queries
CREATE INDEX idx_audit_log_entity
  ON audit_log (workspace_id, entity_type, entity_id);

-- idx_audit_log_actor: actor-scoped audit history queries
CREATE INDEX idx_audit_log_actor
  ON audit_log (workspace_id, actor_id);

-- ============================================================
-- RLS: audit_log_workspace_isolation
-- BR-RBAC-002: cross-workspace queries prohibited
-- Application sets app.current_workspace_id per request transaction
-- ============================================================
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_workspace_isolation ON audit_log
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- ============================================================
-- Function + Triggers: block_audit_log_mutations
-- INV-AUDIT-001: audit_log is append-only; UPDATE and DELETE are forbidden
-- BR-AUDIT-001: enforced at DB level so no application code can bypass
-- AUTHZ-004: manual UPDATE/DELETE on audit_log blocked unconditionally
-- ============================================================
CREATE OR REPLACE FUNCTION block_audit_log_mutations()
RETURNS TRIGGER AS $$
BEGIN
  -- BR-AUDIT-001: audit_log is append-only — UPDATE and DELETE are not allowed.
  -- AUTHZ-004: this trigger enforces immutability at the database level.
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- trg_audit_log_before_update_block: fires BEFORE UPDATE on any row
CREATE TRIGGER trg_audit_log_before_update_block
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION block_audit_log_mutations();

-- trg_audit_log_before_delete_block: fires BEFORE DELETE on any row
CREATE TRIGGER trg_audit_log_before_delete_block
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION block_audit_log_mutations();
