import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { pages } from './page.js';
import { workspaces } from './workspace.js';

// T-1-005: Schema MOD-EVENT — raw_events table
//
// raw_events is the fast-accept durability buffer (ADR-004).
// Edge inserts into raw_events BEFORE returning 202 — BR-EVENT-001.
// Ingestion processor reads raw_events and normalises into events/leads/lead_stages.
//
// Retention: 7 days (ADR-004). Purge by background job (hard delete after processed + TTL).
// See docs/30-contracts/02-db-schema-conventions.md § Soft-delete vs hard-delete.
//
// RawEventStatus: 'pending' | 'processed' | 'failed' | 'discarded'
//   pending    — inserted by Edge; awaiting ingestion processor
//   processed  — successfully normalised by processor (event row created or duplicate detected)
//   failed     — processor error; may be retried up to max_attempts; then DLQ
//   discarded  — deliberate skip (e.g. workspace archived, rejected_consent — no retry)
//
// BR-RBAC-002: workspace_id is multi-tenant anchor; RLS enforces app.current_workspace_id.
// BR-EVENT-001: insert raw_events antes de 202 — Edge handler awaits insert.
// INV-EVENT-005: Edge persiste em raw_events antes de retornar 202.

export const rawEvents = pgTable('raw_events', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: app.current_workspace_id enforced by RLS
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to pages — optional; Edge resolves page from page_token before inserting
  pageId: uuid('page_id').references(() => pages.id, { onDelete: 'restrict' }),

  // payload: full original event payload as received by Edge (jsonb)
  // No PII normalisation at this stage — processor handles hashing/encryption
  // BR-PRIVACY-001 note: raw payload MAY contain PII in transit; processor hashes before events table
  // Zod validation of shape happens at Edge before insert (rejects malformed payloads)
  payload: jsonb('payload').notNull(),

  // headers_sanitized: sanitized request headers (jsonb)
  // IP and UA stored hashed — no raw IPs or user agents in clear (BR-PRIVACY-001)
  // Typical keys: ip_hash (SHA-256), ua_hash (SHA-256), referrer, origin, x_forwarded_for_hash
  headersSanitized: jsonb('headers_sanitized').notNull().default({}),

  // received_at: server-side timestamp when Edge accepted the event
  // INV-EVENT-005: set by Edge at insert time; used for ordering + processor queries
  receivedAt: timestamp('received_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // processed_at: timestamp when ingestion processor completed handling this row
  // NULL while status='pending' or status='failed'
  processedAt: timestamp('processed_at', { withTimezone: true }),

  // processing_status: RawEventStatus lifecycle
  // RawEventStatus: 'pending' | 'processed' | 'failed' | 'discarded'
  // chk_raw_events_processing_status enforces valid values
  processingStatus: text('processing_status').notNull().default('pending'),

  // processing_error: human-readable error message when status='failed' or 'discarded'
  // NULL when status is 'pending' or 'processed'
  // No PII allowed in error messages — sanitised by processor before write
  processingError: text('processing_error'),
});

export type RawEvent = typeof rawEvents.$inferSelect;
export type NewRawEvent = typeof rawEvents.$inferInsert;
