import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { audiences } from './audience.js';
import { audienceSnapshots } from './audience_snapshot.js';
import { workspaces } from './workspace.js';

// INV-AUDIENCE-002 / BR-AUDIENCE-002: at most 1 sync job in status='processing'
//   per (audience_id, platform_resource_id) at any time.
//   Lock enforced at service layer via acquireSyncLock() (advisory lock or Redis).
//
// BR-AUDIENCE-001: sync jobs for audiences with destination_strategy='disabled_not_eligible'
//   must complete with sent_additions=0, sent_removals=0 and must NOT call external API.
//   Validated in audience-sync dispatcher before any API call.
//
// BR-AUDIENCE-003: diff is calculated as SET difference between snapshot_id and prev_snapshot_id.
//   planned_additions / planned_removals populated by job planner.
//   sent_additions / sent_removals populated by dispatcher after actual API calls.
//
// SyncJobStatus: 'pending' | 'processing' | 'succeeded' | 'failed'
// Retry tracking: next_attempt_at drives cron-based re-dispatch for 'failed' jobs.

export const audienceSyncJobs = pgTable('audience_sync_jobs', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — RLS filters by app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to the audience being synced
  audienceId: uuid('audience_id')
    .notNull()
    .references(() => audiences.id, { onDelete: 'restrict' }),

  // FK to the current snapshot (members(T))
  snapshotId: uuid('snapshot_id')
    .notNull()
    .references(() => audienceSnapshots.id, { onDelete: 'restrict' }),

  // FK to the previous snapshot (members(T-1)) — NULL on first sync
  // BR-AUDIENCE-003: diff = snapshotId \ prevSnapshotId
  prevSnapshotId: uuid('prev_snapshot_id').references(
    () => audienceSnapshots.id,
    { onDelete: 'restrict' },
  ),

  // SyncJobStatus: 'pending' | 'processing' | 'succeeded' | 'failed'
  // chk_audience_sync_jobs_status enforces valid values
  status: text('status').notNull().default('pending'),

  // Diff counts — planned values set by job planner before dispatch
  // BR-AUDIENCE-003: based on SET difference between snapshot and prev_snapshot
  plannedAdditions: integer('planned_additions').notNull().default(0),
  plannedRemovals: integer('planned_removals').notNull().default(0),

  // Actual sent counts — populated by dispatcher after API calls complete
  // BR-AUDIENCE-001: both must be 0 for disabled_not_eligible
  sentAdditions: integer('sent_additions').notNull().default(0),
  sentRemovals: integer('sent_removals').notNull().default(0),

  // Platform-assigned job/operation ID returned by Meta/Google API
  // NULL until the platform responds with a reference ID
  platformJobId: text('platform_job_id'),

  // Platform resource ID used for INV-AUDIENCE-002 lock key
  // e.g. Meta custom audience ID or Google remarketing list ID
  platformResourceId: text('platform_resource_id'),

  // Error tracking — populated on 'failed' status
  errorCode: text('error_code'),
  errorMessage: text('error_message'),

  // Timestamps for job lifecycle
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),

  // Retry scheduling — NULL when no retry is planned
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AudienceSyncJob = typeof audienceSyncJobs.$inferSelect;
export type NewAudienceSyncJob = typeof audienceSyncJobs.$inferInsert;
