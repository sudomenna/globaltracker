import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// T-1-008: Schema MOD-DISPATCH — dispatch_jobs table
//
// INV-DISPATCH-001: idempotency_key is unique globally — uq_dispatch_jobs_idempotency_key
//   BR-DISPATCH-001: idempotency_key = sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)
// INV-DISPATCH-004: skipped job MUST have skip_reason non-empty — chk_dispatch_jobs_skipped_reason
//   BR-DISPATCH-004: skip_reason is required when status='skipped'
// INV-DISPATCH-003: dead_letter job is NOT auto-reprocessed — enforced at service layer (BR-DISPATCH-005)
// INV-DISPATCH-008: atomic lock via status transition pending→processing — BR-DISPATCH-002
//
// Events FK note:
//   The events table is PARTITION BY RANGE (received_at). In Postgres, a foreign key
//   referencing a partitioned table requires the partitioned table to have a unique/PK
//   constraint that includes ALL partition key columns (i.e., received_at). This makes a
//   standard FK on event_id alone impractical. Per T-1-008 criteria and ADR-013, we store
//   event_id (uuid) and event_workspace_id (uuid) as logical references without a referential
//   FK constraint. The application layer enforces referential integrity; the DB provides
//   only the non-FK index for efficient lookups.
//
// Soft-delete: dispatch_jobs are append-only (02-db-schema-conventions.md).
//   Purge by retention job. status='dead_letter' is the terminal failed state.
//
// BR-RBAC-002: workspace_id is multi-tenant anchor; RLS enforces app.current_workspace_id.

export const dispatchJobs = pgTable('dispatch_jobs', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to leads — the lead associated with this dispatch event
  // NULL for system-level dispatches without a lead context
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'restrict' }),

  // Logical reference to the source event (no referential FK — partitioned table limitation)
  // See partitioning note above.
  // BR-DISPATCH-001: idempotency_key derivation includes event_id
  eventId: uuid('event_id').notNull(),

  // event_workspace_id mirrors workspace_id but is kept explicitly as part of the logical
  // event reference to avoid ambiguity when the application reconstructs the FK target.
  eventWorkspaceId: uuid('event_workspace_id').notNull(),

  // destination: target integration platform
  // DispatchDestination: 'meta_capi' | 'ga4_mp' | 'google_ads_conversion' | 'google_enhancement' | 'audience_sync'
  // chk_dispatch_jobs_destination enforces valid values
  destination: text('destination').notNull(),

  // destination_account_id: the platform account ID (Meta Business ID, Google Ads CID, GA4 property)
  destinationAccountId: text('destination_account_id').notNull(),

  // destination_resource_id: pixel_id / measurement_id / customer_id / audience_id
  destinationResourceId: text('destination_resource_id').notNull(),

  // destination_subresource: sub-resource within the destination (conversion_action, etc.)
  // NULL when destination does not require a subresource
  destinationSubresource: text('destination_subresource'),

  // idempotency_key: sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)
  // INV-DISPATCH-001: globally unique — uq_dispatch_jobs_idempotency_key
  // BR-DISPATCH-001: computed by computeIdempotencyKey() helper (ADR-013)
  idempotencyKey: text('idempotency_key').notNull(),

  // status: lifecycle of the dispatch job
  // DispatchStatus: 'pending' | 'processing' | 'succeeded' | 'retrying' | 'failed' | 'skipped' | 'dead_letter'
  // chk_dispatch_jobs_status enforces valid values
  // INV-DISPATCH-008: atomic lock via pending→processing transition (BR-DISPATCH-002)
  status: text('status').notNull().default('pending'),

  // eligibility_reason: why this job was created (informational, for debugging)
  // NULL when no eligibility context is needed
  eligibilityReason: text('eligibility_reason'),

  // skip_reason: required when status='skipped' (INV-DISPATCH-004 / BR-DISPATCH-004)
  // Canonical values: 'consent_denied:<finality>', 'no_user_data', 'integration_not_configured',
  //   'no_click_id_available', 'audience_not_eligible', 'archived_launch'
  // chk_dispatch_jobs_skipped_reason: (status = 'skipped') → skip_reason IS NOT NULL
  skipReason: text('skip_reason'),

  // payload: the serialized dispatch payload sent to the external platform
  // jsonb — schema defined per destination in packages/shared/src/contracts/dispatch/
  // BR-PRIVACY-001: no PII in clear — only hashes; sanitized before storage
  payload: jsonb('payload').notNull().default({}),

  // Retry tracking
  // attempt_count: total attempts made so far; starts at 0
  // INV-DISPATCH-005: attempt_count = count(*) in dispatch_attempts — assertion in integration test
  attemptCount: integer('attempt_count').notNull().default(0),

  // max_attempts: maximum retries before dead_letter; default 5 (BR-DISPATCH-003)
  maxAttempts: integer('max_attempts').notNull().default(5),

  // next_attempt_at: when the next retry should be attempted
  // NULL when status is not 'retrying'; set by computeBackoff() helper (INV-DISPATCH-007)
  // BR-DISPATCH-003: backoff = 2^attempt_count × (1 ± 0.2 jitter) seconds
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),

  // scheduled_at: when this job was scheduled for initial processing
  // Typically the same as created_at; may differ when job is created in advance
  scheduledAt: timestamp('scheduled_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // replayed_from_dispatch_job_id: logical reference to the original job (ADR-025, T-8-001).
  // NULL for jobs created by ingestion processor. Non-null when created via replay endpoint.
  // No referential FK — avoids self-referential cycle; integrity at app layer.
  replayedFromDispatchJobId: uuid('replayed_from_dispatch_job_id'),
});

export type DispatchJob = typeof dispatchJobs.$inferSelect;
export type NewDispatchJob = typeof dispatchJobs.$inferInsert;
