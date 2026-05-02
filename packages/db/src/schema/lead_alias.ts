import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// BR-IDENTITY-001: aliases ativos são únicos por (workspace_id, identifier_type, identifier_hash)
//   Enforced via partial unique index in migration:
//   uq_lead_aliases_active_per_identifier ON lead_aliases (workspace_id, identifier_type, identifier_hash)
//   WHERE status = 'active'
//   This index is the canonical source of identity uniqueness — not leads.*_hash columns (ADR-005).
//
// INV-IDENTITY-001: No two active aliases can share (workspace_id, identifier_type, identifier_hash).
//   Any attempt to insert a duplicate active alias raises unique_violation — resolver detects merge case.

export const leadAliases = pgTable('lead_aliases', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // IdentifierType: 'email_hash' | 'phone_hash' | 'external_id_hash' | 'lead_token_id'
  // chk_lead_aliases_identifier_type enforces valid values (defined in migration)
  identifierType: text('identifier_type').notNull(),

  // BR-PRIVACY-002: SHA-256 hex of the normalized identifier value
  // INV-IDENTITY-007: normalization (lowercase+trim for email, E.164 for phone) enforced in lib/pii.ts
  identifierHash: text('identifier_hash').notNull(),

  // FK to leads — on delete restrict to prevent orphan aliases
  leadId: uuid('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // Source of this alias creation
  // AliasSource: 'form_submit' | 'webhook:hotmart' | 'webhook:stripe' | 'webhook:kiwify' | 'manual' | 'merge'
  // chk_lead_aliases_source enforces valid values (defined in migration)
  source: text('source').notNull(),

  // LeadAliasStatus: 'active' | 'superseded' | 'revoked'
  // INV-IDENTITY-001: unique partial index on (workspace_id, identifier_type, identifier_hash)
  //   WHERE status = 'active' — only one active alias per identifier per workspace
  // chk_lead_aliases_status enforces valid values (defined in migration)
  status: text('status').notNull().default('active'),

  // ts: when this alias was established
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
});

export type LeadAlias = typeof leadAliases.$inferSelect;
export type NewLeadAlias = typeof leadAliases.$inferInsert;
