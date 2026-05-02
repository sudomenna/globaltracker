import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

// INV-AUDIENCE-001: (workspace_id, public_id) must be unique — enforced by uq_audiences_workspace_public_id
// INV-AUDIENCE-007: query_definition is validated by Zod schema before save (service layer)
//
// BR-AUDIENCE-001: destination_strategy ∈ AudienceDestinationStrategy enum
//   'meta_custom_audience' | 'google_data_manager' | 'google_ads_api_allowlisted' | 'disabled_not_eligible'
//   Audiences with disabled_not_eligible MUST NOT call external API (dispatcher enforced)
//
// AudienceStatus: 'draft' | 'active' | 'paused' | 'archived'
// Platform: 'meta' | 'google'

export const audiences = pgTable('audiences', {
  // PK: internal UUID — never exposed to browser
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — RLS filters by app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // INV-AUDIENCE-001: public_id is unique per workspace — uq_audiences_workspace_public_id
  // public_id is the externally visible identifier (max 64 chars per convention)
  publicId: text('public_id').notNull(),

  // Human-readable audience name
  name: text('name').notNull(),

  // Platform enum: 'meta' | 'google'
  // chk_audiences_platform enforces valid values
  platform: text('platform').notNull(),

  // BR-AUDIENCE-001: destination strategy controls which API pathway is used
  // AudienceDestinationStrategy: 'meta_custom_audience' | 'google_data_manager' |
  //   'google_ads_api_allowlisted' | 'disabled_not_eligible'
  // chk_audiences_destination_strategy enforces valid values
  destinationStrategy: text('destination_strategy').notNull(),

  // INV-AUDIENCE-007: DSL-validated query definition (jsonb)
  // Schema: { type: 'builder', all: [{ stage: ... }, { is_icp: true }, ...] }
  // Zod validation runs at service layer before insert/update
  queryDefinition: jsonb('query_definition').notNull(),

  // BR-AUDIENCE-004: consent_policy specifies required finalidades before snapshot
  // Schema: { require_customer_match?: boolean, require_analytics?: boolean, ... }
  consentPolicy: jsonb('consent_policy').notNull().default('{}'),

  // AudienceStatus: 'draft' | 'active' | 'paused' | 'archived'
  // Soft-delete via status='archived' — hard delete is prohibited (30-contracts/02)
  // chk_audiences_status enforces valid values
  status: text('status').notNull().default('draft'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Audience = typeof audiences.$inferSelect;
export type NewAudience = typeof audiences.$inferInsert;
