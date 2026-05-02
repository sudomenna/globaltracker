import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// BR-IDENTITY-004: Every merge must be recorded in lead_merges for audit purposes.
//   merged_lead.status is set to 'merged'; canonical_lead absorbs all aliases and events.
//
// INV-IDENTITY-003: After merge, merged_lead does not receive new aliases or events.
//   Edge resolver follows merged_into_lead_id to reach canonical lead.

export const leadMerges = pgTable('lead_merges', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // The surviving canonical lead that absorbs the identity of the merged lead
  canonicalLeadId: uuid('canonical_lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // The lead that was merged into canonical (set to status='merged' after this operation)
  mergedLeadId: uuid('merged_lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // MergeReason: 'email_phone_convergence' | 'manual' | 'sar'
  // chk_lead_merges_reason enforces valid values (defined in migration)
  reason: text('reason').notNull(),

  // Actor who performed the merge: 'system' (auto-resolver) or a user UUID string
  // BR-IDENTITY-004: performed_by is required for audit trail
  performedBy: text('performed_by').notNull(),

  // Snapshot of both leads before merge — stored as jsonb for audit purposes
  // BR-PRIVACY-002: no PII in clear text; only hashes and non-sensitive fields
  // BR-PRIVACY-003: enc fields are NOT stored here — only structural metadata
  beforeSummary: jsonb('before_summary'),

  // Snapshot of canonical lead after merge — structural fields only
  afterSummary: jsonb('after_summary'),

  // Timestamp of the merge operation
  mergedAt: timestamp('merged_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LeadMerge = typeof leadMerges.$inferSelect;
export type NewLeadMerge = typeof leadMerges.$inferInsert;
