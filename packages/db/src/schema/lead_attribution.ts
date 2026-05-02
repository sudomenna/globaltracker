import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { leads } from './lead.js';
import { links } from './link.js';
import { workspaces } from './workspace.js';

// BR-ATTRIBUTION-001: First-touch row is unique per (workspace_id, lead_id, launch_id).
//   INSERT ON CONFLICT DO NOTHING for touch_type='first'.
//   Constraint: uq_lead_attributions_first_per_launch (partial: WHERE touch_type='first').
// BR-ATTRIBUTION-002: Last-touch is upserted per (workspace_id, lead_id, launch_id).
//   INSERT ... ON CONFLICT DO UPDATE for touch_type='last'.
//   Constraint: uq_lead_attributions_last_per_launch (partial: WHERE touch_type='last').
// INV-ATTRIBUTION-001: (workspace_id, launch_id, lead_id, touch_type) unique when touch_type IN ('first','last').
//   Two partial unique indexes enforce this.
// INV-ATTRIBUTION-005: first-touch from first event; last-touch from last conversion — ordering by event_time.
// INV-ATTRIBUTION-006: lead reappearing in another launch gets a new first-touch for that launch (ADR-015).

export const leadAttributions = pgTable('lead_attributions', {
  // PK: internal UUID — never exposed to browser
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to launches — attribution is scoped per launch (ADR-015 / INV-ATTRIBUTION-006)
  launchId: uuid('launch_id')
    .notNull()
    .references(() => launches.id, { onDelete: 'restrict' }),

  // FK to leads — the attributed lead
  // on delete restrict to preserve attribution history on lead erasure (SAR handles differently)
  leadId: uuid('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // TouchType: 'first' | 'last' | 'all'
  // INV-ATTRIBUTION-001: unique when touch_type IN ('first','last') — enforced by partial unique indexes
  // BR-ATTRIBUTION-001: 'first' insert with ON CONFLICT DO NOTHING
  // BR-ATTRIBUTION-002: 'last' upsert with ON CONFLICT DO UPDATE
  // chk_lead_attributions_touch_type enforces valid values
  touchType: text('touch_type').notNull(),

  // UTM attribution fields — nullable; absent when click arrived without UTM params
  source: text('source'),
  medium: text('medium'),
  campaign: text('campaign'),
  content: text('content'),
  term: text('term'),

  // FK to links — nullable; attribution can exist without a short link (direct UTM)
  linkId: uuid('link_id').references(() => links.id, { onDelete: 'restrict' }),

  // Ad platform structural identifiers — nullable
  adAccountId: text('ad_account_id'),
  campaignId: text('campaign_id'),
  adsetId: text('adset_id'),
  adId: text('ad_id'),
  creativeId: text('creative_id'),

  // Click identifiers — nullable; raw values captured from the inbound event
  fbclid: text('fbclid'),
  gclid: text('gclid'),
  gbraid: text('gbraid'),
  wbraid: text('wbraid'),
  fbc: text('fbc'),
  fbp: text('fbp'),

  // ts: event_time of the touch (clamped per BR-EVENT-003 at the application layer)
  // INV-ATTRIBUTION-005: first-touch ordered by ts ASC; last-touch ordered by ts DESC
  ts: timestamp('ts', { withTimezone: true }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LeadAttribution = typeof leadAttributions.$inferSelect;
export type NewLeadAttribution = typeof leadAttributions.$inferInsert;
