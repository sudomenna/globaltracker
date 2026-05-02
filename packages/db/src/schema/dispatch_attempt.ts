import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { dispatchJobs } from './dispatch_job.js';
import { workspaces } from './workspace.js';

// T-1-008: Schema MOD-DISPATCH — dispatch_attempts table
//
// INV-DISPATCH-005: attempt_count in dispatch_jobs = count(*) in dispatch_attempts
//   Enforced by application layer (createAttempt increments job.attempt_count atomically).
//   Verified in integration test (tests/integration/dispatch/).
//
// AttemptStatus: 'succeeded' | 'retryable_failure' | 'permanent_failure'
//   chk_dispatch_attempts_status enforces valid values.
//
// BR-PRIVACY-001: request_payload_sanitized and response_payload_sanitized must not contain PII in clear.
//   sanitizeLogs() applied before storage.
//
// Soft-delete: dispatch_attempts are append-only (02-db-schema-conventions.md).
//   Purge by retention job alongside parent dispatch_jobs.
//
// BR-RBAC-002: workspace_id is multi-tenant anchor; RLS enforces app.current_workspace_id.

export const dispatchAttempts = pgTable('dispatch_attempts', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to the parent dispatch job
  // INV-DISPATCH-005: every row here increments dispatch_jobs.attempt_count
  dispatchJobId: uuid('dispatch_job_id')
    .notNull()
    .references(() => dispatchJobs.id, { onDelete: 'restrict' }),

  // attempt_number: 1-based sequence within the job; matches attempt_count at job level
  attemptNumber: integer('attempt_number').notNull(),

  // status: outcome of this individual attempt
  // AttemptStatus: 'succeeded' | 'retryable_failure' | 'permanent_failure'
  // chk_dispatch_attempts_status enforces valid values
  // BR-DISPATCH-003: retryable_failure → job retries; permanent_failure → job fails
  status: text('status').notNull(),

  // Sanitized request and response payloads for debugging and audit
  // jsonb — structure defined per destination in packages/shared/src/contracts/dispatch/
  // BR-PRIVACY-001: sanitizeLogs() applied before storage; no PII in clear
  requestPayloadSanitized: jsonb('request_payload_sanitized')
    .notNull()
    .default({}),
  responsePayloadSanitized: jsonb('response_payload_sanitized')
    .notNull()
    .default({}),

  // response_status: HTTP status code returned by the external platform
  // NULL when request did not reach the platform (network error, timeout before response)
  responseStatus: integer('response_status'),

  // error_code: platform-specific or internal error code (e.g. 'invalid_pixel_id', 'timeout')
  // NULL when status='succeeded'
  errorCode: text('error_code'),

  // error_message: sanitized error description
  // NULL when status='succeeded'; no PII in error messages (BR-PRIVACY-001)
  errorMessage: text('error_message'),

  // Lifecycle timestamps
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DispatchAttempt = typeof dispatchAttempts.$inferSelect;
export type NewDispatchAttempt = typeof dispatchAttempts.$inferInsert;
