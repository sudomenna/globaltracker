import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

  // INV-WORKSPACE-003: onboarding_state structure validated by Zod at service layer (not DB constraint)
  // Sprint 6: stores wizard progress; nullable inner fields — workspace starts with empty object
  onboardingState: jsonb('onboarding_state').notNull().default({}),

  // Workspace-level integration configuration: { integrations: { meta: { pixel_id, capi_token }, ga4: { measurement_id, api_secret } } }
  // Populated by onboarding wizard on step='complete'. Dispatchers read from here with env var fallback.
  config: jsonb('config').notNull().default({}),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
