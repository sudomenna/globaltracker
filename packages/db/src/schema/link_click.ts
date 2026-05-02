import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { leads } from './lead.js';
import { links } from './link.js';
import { workspaces } from './workspace.js';

// BR-ATTRIBUTION-004: Redirector registers link_clicks async; latency < 50ms p95.
//   link_clicks is append-only — no UPDATE or DELETE in normal flow.
// INV-ATTRIBUTION-004: ip_hash and ua_hash MUST be SHA-256 hex, never stored in clear.
//   Enforced in lib/pii.ts hash() helper at the application layer.
// INV-ATTRIBUTION-003: link_click recording is fire-and-forget (does not block redirect).

export const linkClicks = pgTable('link_clicks', {
  // PK: internal UUID — never exposed to browser
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to launches — click scoped to a launch context
  launchId: uuid('launch_id')
    .notNull()
    .references(() => launches.id, { onDelete: 'restrict' }),

  // FK to links — nullable: click can arrive via direct UTM without a short link
  // on delete restrict: prevents accidental removal of a link with click history
  linkId: uuid('link_id').references(() => links.id, { onDelete: 'restrict' }),

  // lead_id: nullable — click may occur before lead is identified
  // FK to leads; on delete restrict to preserve click attribution history
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'restrict' }),

  // The slug that was resolved to perform this click (denormalized for append-only queries)
  slug: text('slug'),

  // ts: exact timestamp of the click event
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),

  // INV-ATTRIBUTION-004: SHA-256 hex hashes — never stored in clear
  // Enforced in lib/pii.ts at the application layer
  ipHash: text('ip_hash'),
  uaHash: text('ua_hash'),

  // Referrer domain (not the full URL — stripped to domain only to avoid PII leakage)
  referrerDomain: text('referrer_domain'),

  // Click identifiers from ad platforms — raw values from query string
  fbclid: text('fbclid'),
  gclid: text('gclid'),
  gbraid: text('gbraid'),
  wbraid: text('wbraid'),

  // Derived identifiers
  fbc: text('fbc'),
  fbp: text('fbp'),

  // Consolidated attribution parameters (UTM + click IDs) as a jsonb blob
  // Schema validated in packages/shared/src/contracts/ (Zod)
  attribution: jsonb('attribution'),

  // Append-only — no updated_at column (link_clicks are immutable once written)
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LinkClick = typeof linkClicks.$inferSelect;
export type NewLinkClick = typeof linkClicks.$inferInsert;
