import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// BR-AUDIT-001: audit_log is append-only — no UPDATE or DELETE allowed.
// DB triggers trg_audit_log_before_update_block and trg_audit_log_before_delete_block
// enforce this at the database level (INV-AUDIT-001).
//
// AUTHZ-012: recordAuditEntry() is the ONLY permitted insert path.
// No application code should INSERT directly into this table.
//
// AUTHZ-001: action='read_pii_decrypted' is the canonical marker for
// auditable access to decrypted PII fields.

export const auditLog = pgTable('audit_log', {
  // Standard PK
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — every row is scoped to a workspace
  // BR-RBAC-002: RLS filters by app.current_workspace_id
  workspaceId: uuid('workspace_id').notNull(),

  // actor_id is text to support UUID strings (user/api_key) and the literal 'system'
  actorId: text('actor_id').notNull(),

  // INV-AUDIT-002: actor_type ∈ AuditActorType = ['user', 'system', 'api_key']
  // chk_audit_log_actor_type enforces valid values
  actorType: text('actor_type').notNull(),

  // AUTHZ-001: action='read_pii_decrypted' marks decrypted PII access.
  // Other canonical values: 'create', 'update', 'delete', 'rotate', 'revoke',
  // 'erase_sar', 'merge_leads', 'sync_audience', 'reprocess_dlq'
  // (see AuditAction in docs/30-contracts/01-enums.md)
  action: text('action').notNull(),

  // entity_type examples: 'page', 'page_token', 'lead', 'audience', 'launch'
  entityType: text('entity_type').notNull(),

  // entity_id is text for cross-entity flexibility (uuid strings, slugs, etc.)
  entityId: text('entity_id').notNull(),

  // Snapshot of state before the action; NULL for 'create' actions
  before: jsonb('before'),

  // Snapshot of state after the action; NULL for 'delete' actions
  after: jsonb('after'),

  // Append-only event timestamp — no updated_at (INV-AUDIT-001)
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),

  // INV-AUDIT-003: request_context is sanitized — no PII in clear text.
  // Must contain only: ip_hash, ua_hash, request_id.
  // Validation is enforced by the recordAuditEntry() helper (app layer).
  requestContext: jsonb('request_context'),
});

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
