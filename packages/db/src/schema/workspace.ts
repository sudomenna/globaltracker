import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// BR-PRIVACY-001: Workspace is the crypto anchor — id is used as HKDF salt
// for deriving per-workspace PII keys at runtime. No key field stored here.

export const workspaces = pgTable('workspaces', {
  // BR-RBAC-002: workspaces itself is the tenant root; no workspace_id FK here
  id: uuid('id').primaryKey().defaultRandom(),

  // INV-WORKSPACE-001: slug is globally unique (uq_workspaces_slug)
  // Check: length between 3 and 64 (chk_workspaces_slug_length)
  slug: text('slug').notNull().unique(),

  name: text('name').notNull(),

  // WorkspaceStatus: 'draft' | 'active' | 'suspended' | 'archived'
  // chk_workspaces_status enforces valid values
  // INV-WORKSPACE-002: 'archived' workspace rejects ingest — enforced at Edge layer
  status: text('status').notNull().default('draft'),

  // INV-WORKSPACE-004: must be valid ISO 4217 code from allowed list
  // chk_workspaces_fx_currency enforces IN list
  fxNormalizationCurrency: text('fx_normalization_currency')
    .notNull()
    .default('BRL'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
