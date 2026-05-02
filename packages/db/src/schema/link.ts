import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { workspaces } from './workspace.js';

// BR-ATTRIBUTION-003: links.slug is globally unique (not per-workspace).
//   Slug appears in a public URL (/r/:slug); two workspaces cannot share a slug.
//   Constraint: uq_links_slug (global, not scoped to workspace_id).
// INV-ATTRIBUTION-002: slug unique constraint enforced at DB level.
// INV-ATTRIBUTION-004: ip_hash and ua_hash in link_clicks are SHA-256 — enforced in lib/pii.ts.

export const links = pgTable('links', {
  // PK: internal UUID — never exposed to browser
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to launches — link always belongs to a launch
  // on delete restrict: launch with links cannot be hard-deleted
  launchId: uuid('launch_id')
    .notNull()
    .references(() => launches.id, { onDelete: 'restrict' }),

  // BR-ATTRIBUTION-003: slug is globally unique (uq_links_slug — not per workspace)
  // INV-ATTRIBUTION-002: unique constraint enforced at DB level
  // chk_links_slug_length: length between 3 and 64
  slug: text('slug').notNull().unique(),

  // Full destination URL for the redirect — required
  destinationUrl: text('destination_url').notNull(),

  // UTM parameters — nullable; may be pre-populated or absent
  utmSource: text('utm_source'),
  utmMedium: text('utm_medium'),
  utmCampaign: text('utm_campaign'),
  utmContent: text('utm_content'),
  utmTerm: text('utm_term'),

  // Ad platform structural identifiers — nullable
  channel: text('channel'),
  campaign: text('campaign'),
  adAccountId: text('ad_account_id'),
  campaignId: text('campaign_id'),
  adsetId: text('adset_id'),
  adId: text('ad_id'),
  creativeId: text('creative_id'),
  placement: text('placement'),

  // LinkStatus: 'active' | 'archived'
  // chk_links_status enforces valid values
  // Soft-delete: use status='archived' (no hard delete per conventions)
  status: text('status').notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;
