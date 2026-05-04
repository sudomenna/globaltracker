import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { funnelTemplates } from './funnel_template.js';
import { workspaces } from './workspace.js';

// INV-LAUNCH-001: (workspace_id, public_id) is unique per workspace — constraint uq_launches_workspace_public_id
// INV-LAUNCH-002: status='archived' rejects ingest — enforced at Edge layer (requireActiveLaunch)
// INV-LAUNCH-003: launch only goes live with Pixel policy declared — validated at Edge service layer
// INV-LAUNCH-004: timezone is a valid IANA tz — validated by Zod at Edge; DB accepts text not null
// INV-LAUNCH-005: config.tracking.google.customer_match_strategy ∈ enum — validated by Zod at Edge; DB accepts jsonb
// BR-DISPATCH-001: config.tracking.meta.pixel_policy='browser_and_server_managed' requires shared event_id
// BR-AUDIENCE-001: config.tracking.google.customer_match_strategy is conditional on audience eligibility

export const launches = pgTable('launches', {
  // PK: internal UUID — never exposed to browser (browser uses public_id or lead_token)
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: app.current_workspace_id enforced by RLS
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // INV-LAUNCH-001: unique per workspace — uq_launches_workspace_public_id
  // Check: length between 3 and 64 — chk_launches_public_id_length
  publicId: text('public_id').notNull(),

  name: text('name').notNull(),

  // LaunchStatus: 'draft' | 'configuring' | 'live' | 'ended' | 'archived'
  // chk_launches_status enforces valid values
  // INV-LAUNCH-002: 'archived' launch rejects ingest — enforced at Edge layer
  status: text('status').notNull().default('draft'),

  // INV-LAUNCH-004: IANA tz string; Zod validates isValidIanaTimezone at Edge
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),

  // Tracking configuration blob (meta, google, lead_token TTL, fx, etc.)
  // BR-DISPATCH-001: pixel_policy='browser_and_server_managed' => shared event_id required
  // BR-AUDIENCE-001: customer_match_strategy is conditional on audience eligibility
  // INV-LAUNCH-005: config.tracking.google.customer_match_strategy ∈ CustomerMatchStrategy enum — Zod validates
  // INV-LAUNCH-003: config.tracking.meta.pixel_policy must be declared before status -> 'live' — service validates
  config: jsonb('config').notNull().default({}),

  // T-FUNIL-010: funnel template applied to this launch (nullable — legacy launches have none)
  // ON DELETE SET NULL: template deletion does not affect existing launches
  funnelTemplateId: uuid('funnel_template_id')
    .references(() => funnelTemplates.id, { onDelete: 'set null' }),

  // T-FUNIL-010: snapshot of the funnel blueprint at the time of launch creation
  // Decoupled from funnel_templates to allow template evolution without affecting live launches
  funnelBlueprint: jsonb('funnel_blueprint'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Launch = typeof launches.$inferSelect;
export type NewLaunch = typeof launches.$inferInsert;
