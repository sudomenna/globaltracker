import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { workspaces } from './workspace.js';

// T-1-003: Schema MOD-PAGE — pages table
//
// INV-PAGE-001: (launch_id, public_id) is unique per launch — uq_pages_launch_public_id
// INV-PAGE-002: allowed_domains must not be empty when integration_mode='b_snippet'
//   Validated at Edge service layer (array length check before save)
// INV-PAGE-004: each active page must have at least one active page_token
//   Validated at Edge service layer (not enforceable as a pure DB constraint)
// INV-PAGE-006: event_config must be Zod-valid per EventConfigSchema
//   Validated at Edge service layer on save
// ADR-003: public_id is slug/random string for use in snippets/URLs; id is internal UUID
// ADR-011: pages.event_config declares pixel_policy per page (server_only | browser_and_server_managed | coexist_with_existing_pixel)
// BR-RBAC-002: workspace_id is multi-tenant anchor; RLS enforces app.current_workspace_id

export const pages = pgTable('pages', {
  // PK: internal UUID — never exposed to browser (browser uses public_id or page_token)
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: app.current_workspace_id enforced by RLS
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to launches — on delete restrict; page cannot exist without a launch
  launchId: uuid('launch_id')
    .notNull()
    .references(() => launches.id, { onDelete: 'restrict' }),

  // ADR-003: public_id is slug or random string — used in snippets, URLs, YAML
  // INV-PAGE-001: unique per launch — see constraint uq_pages_launch_public_id
  // chk_pages_public_id_length: length between 1 and 64
  publicId: text('public_id').notNull(),

  // PageRole: 'capture' | 'sales' | 'thankyou' | 'webinar' | 'checkout' | 'survey'
  // chk_pages_role enforces valid values
  role: text('role').notNull(),

  // IntegrationMode: 'a_system' | 'b_snippet' | 'c_webhook'
  // INV-PAGE-002: when mode is 'b_snippet', allowed_domains must not be empty (Edge validates)
  // chk_pages_integration_mode enforces valid values
  integrationMode: text('integration_mode').notNull().default('b_snippet'),

  // Informative URL of the landing page (optional — may be blank for programmatic pages)
  url: text('url'),

  // Multi-domain allowlist — Edge validates Origin header against this list in 'b_snippet' mode
  // INV-PAGE-002: not empty when integration_mode='b_snippet' — enforced at Edge
  // INV-PAGE-007: origin validation uses suffix match (subdomain ok) — enforced at Edge
  allowedDomains: text('allowed_domains').array().notNull().default([]),

  // Declarative event capture schema (jsonb) — which events to capture, pixel_policy, etc.
  // INV-PAGE-006: must be Zod-valid per EventConfigSchema — validated at Edge before save
  // ADR-011: pixel_policy field inside event_config controls CAPI deduplication strategy
  eventConfig: jsonb('event_config').notNull().default({}),

  // A/B testing variant label — optional, NULL when page is a single variant
  variant: text('variant'),

  // PageStatus: 'draft' | 'active' | 'paused' | 'archived'
  // INV-PAGE-004: active page must have at least one active page_token — enforced at service layer
  // chk_pages_status enforces valid values
  status: text('status').notNull().default('draft'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
