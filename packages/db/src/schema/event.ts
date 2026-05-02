import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { leads } from './lead.js';
import { pages } from './page.js';
import { workspaces } from './workspace.js';

// T-1-005: Schema MOD-EVENT — events table
//
// INV-EVENT-001: (workspace_id, event_id) is unique — constraint uq_events_workspace_event_id
//   BR-EVENT-002: idempotência por (workspace_id, event_id) — unique constraint enforced here
// INV-EVENT-004: events.user_data accepts only canonical keys (no PII in clear) — Zod-validated at Edge
//   BR-EVENT-005: user_data canonical only — {em, ph, external_id_hash, fbc, fbp, _gcl_au, client_id_ga4, session_id_ga4}
// INV-EVENT-006: consent_snapshot is populated on every event (even if all 'unknown') — Edge enforced
// INV-EVENT-007: events with valid lead_token have lead_id resolved by processor — Edge/processor enforced
//
// Partitioning intent: events should be partitioned PARTITION BY RANGE (received_at)
//   Drizzle ORM does not natively support declarative table partitioning in pgTable().
//   The actual PARTITION BY clause is declared in the migration SQL (0018_event_tables.sql).
//   This TS definition describes the schema of each partition; the parent table is created in SQL.
//   All FK references point to the parent table (events).
//
// Soft-delete: events are append-only (see docs/30-contracts/02-db-schema-conventions.md).
//   Purge by retention in background job (partition drop). No status='archived'.
//
// BR-RBAC-002: workspace_id is multi-tenant anchor; RLS enforces app.current_workspace_id.
// ADR-004: events are derived from raw_events by the ingestion processor (fast-accept model).

export const events = pgTable('events', {
  // PK: internal UUID — browser never receives event row id in clear
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: app.current_workspace_id enforced by RLS
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to launches — optional; some events arrive without a launch context
  launchId: uuid('launch_id').references(() => launches.id, {
    onDelete: 'restrict',
  }),

  // FK to pages — optional; anonymous events may have no page context
  pageId: uuid('page_id').references(() => pages.id, { onDelete: 'restrict' }),

  // FK to leads — optional; anonymous events have no lead resolved yet
  // INV-EVENT-007: populated by ingestion processor when lead_token is valid
  // BR-EVENT-006: lead_token válido popula lead_id; inválido vira anônimo
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'restrict' }),

  // visitor_id: reserved for Fases 1-2; populated in Fase 3
  // text (not uuid) — external identifier assigned by tracker cookie
  visitorId: text('visitor_id'),

  // event_id: client-supplied idempotency key (text, not uuid — clients may use any format)
  // INV-EVENT-001: unique per workspace — constraint uq_events_workspace_event_id
  // BR-EVENT-002: idempotência por (workspace_id, event_id)
  eventId: text('event_id').notNull(),

  // event_name: canonical or custom event name
  // EventName enum (not strict — custom events allowed with 'custom:' prefix)
  // See docs/30-contracts/01-enums.md § EventName
  // chk_events_event_name_length: length between 1 and 128
  eventName: text('event_name').notNull(),

  // event_source: origin of the event
  // EventSource canonical values — chk_events_event_source
  // See docs/30-contracts/01-enums.md § EventSource
  eventSource: text('event_source').notNull(),

  // schema_version: bumped when event payload contract changes
  schemaVersion: integer('schema_version').notNull().default(1),

  // event_time: client-reported event timestamp (may be clamped — INV-EVENT-002)
  // BR-EVENT-003: clamp event_time when abs(event_time - received_at) > EVENT_TIME_CLAMP_WINDOW_SEC
  eventTime: timestamp('event_time', { withTimezone: true }).notNull(),

  // received_at: server-side timestamp when Edge accepted the raw event
  // Used as partition key — see partitioning note above
  receivedAt: timestamp('received_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // attribution: snapshot of touch attribution at the time of the event (jsonb)
  // jsonb — structure defined in packages/shared/src/contracts/attribution-snapshot.ts
  attribution: jsonb('attribution').notNull().default({}),

  // user_data: hashed/pseudonymous identifiers for ad platform matching
  // INV-EVENT-004: only canonical keys allowed — Zod schema rejects PII in clear
  // BR-EVENT-005: user_data canonical only — {em, ph, external_id_hash, fbc, fbp, _gcl_au, client_id_ga4, session_id_ga4}
  // BR-PRIVACY-001: no PII in clear — only hashes and platform cookies
  userData: jsonb('user_data').notNull().default({}),

  // custom_data: arbitrary event-specific data (product value, order_id, etc.)
  // jsonb — structure defined per event_name in packages/shared/src/contracts/
  customData: jsonb('custom_data').notNull().default({}),

  // consent_snapshot: 5-finality consent at the moment of event ingestion
  // INV-EVENT-006: must be present on every event (even if all 'unknown')
  // ConsentFinality keys: analytics, marketing, ad_user_data, ad_personalization, customer_match
  // ConsentValue per key: 'granted' | 'denied' | 'unknown'
  consentSnapshot: jsonb('consent_snapshot').notNull().default({}),

  // request_context: sanitized HTTP context (IP hash, UA hash, referrer, etc.)
  // No PII in clear — IP and UA are hashed before storage (BR-PRIVACY-001)
  // ip_hash and ua_hash are nested inside request_context jsonb for extensibility
  requestContext: jsonb('request_context').notNull().default({}),

  // processing_status: lifecycle of event within the ingestion pipeline
  // EventProcessingStatus: 'accepted' | 'enriched' | 'rejected_archived_launch' | 'rejected_consent' | 'rejected_validation'
  // chk_events_processing_status enforces valid values
  processingStatus: text('processing_status').notNull().default('accepted'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
