import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// INV-ENGAGEMENT-001: webinar attendance is unique per (workspace_id, lead_id, session_id).
//   Enforced by uq_webinar_attendances_workspace_lead_session (defined in migration).
// INV-ENGAGEMENT-005: watched_seconds >= 0 — enforced by chk_webinar_attendances_watched_seconds.
//
// WatchMarker values: '25%' | '50%' | '75%' | '100%' | 'completed'
//   Enforced by chk_webinar_attendances_max_watch_marker (defined in migration).
//
// WebinarAttendanceSource values: 'webhook:webinarjam' | 'webhook:zoom' | 'manual'
//   Enforced by chk_webinar_attendances_source (defined in migration).

export const webinarAttendances = pgTable('webinar_attendances', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to leads.id — the attendee
  leadId: uuid('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // FK to launches.id — the launch this webinar session belongs to
  launchId: uuid('launch_id')
    .notNull()
    .references(() => launches.id, { onDelete: 'restrict' }),

  // Operator-defined session identifier (webinarjam room id, zoom meeting id, etc.)
  // INV-ENGAGEMENT-001: (workspace_id, lead_id, session_id) is unique (migration constraint)
  sessionId: text('session_id').notNull(),

  // Entry timestamp (required — always known from webhook)
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),

  // Exit timestamp — nullable (session may still be in progress or unknown)
  leftAt: timestamp('left_at', { withTimezone: true }),

  // INV-ENGAGEMENT-005: must be >= 0 — chk_webinar_attendances_watched_seconds (migration)
  watchedSeconds: integer('watched_seconds').notNull().default(0),

  // WatchMarker: '25%' | '50%' | '75%' | '100%' | 'completed'
  // Nullable until first marker event is received
  // chk_webinar_attendances_max_watch_marker enforces valid values (migration)
  maxWatchMarker: text('max_watch_marker'),

  // WebinarAttendanceSource: 'webhook:webinarjam' | 'webhook:zoom' | 'manual'
  // chk_webinar_attendances_source enforces valid values (migration)
  source: text('source').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WebinarAttendance = typeof webinarAttendances.$inferSelect;
export type NewWebinarAttendance = typeof webinarAttendances.$inferInsert;
