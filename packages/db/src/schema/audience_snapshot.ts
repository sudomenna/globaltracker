import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { audiences } from './audience.js';
import { workspaces } from './workspace.js';

// INV-AUDIENCE-006: at most 2 snapshots in retention_status='active' per audience.
//   Enforced by cron/trigger that archives older snapshots beyond the latest 2.
//
// BR-AUDIENCE-003: snapshot materialises member state for deterministic diff.
//   snapshot_hash is a deterministic hash of the member set — used for no-op detection.
//   If snapshot_hash equals previous snapshot_hash, no sync job is created.
//
// AudienceSnapshotRetention: 'active' | 'archived' | 'purged'
//   'active'   — latest or second-to-latest snapshot, members still stored
//   'archived' — older snapshot, members retained for up to 30 days
//   'purged'   — members deleted (background retention job); snapshot row kept as audit record

export const audienceSnapshots = pgTable('audience_snapshots', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — RLS filters by app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to the audience this snapshot belongs to
  audienceId: uuid('audience_id')
    .notNull()
    .references(() => audiences.id, { onDelete: 'restrict' }),

  // BR-AUDIENCE-003: deterministic hash of the full member set at snapshot time
  // Used to detect no-op (unchanged audience) and skip sync job creation
  snapshotHash: text('snapshot_hash').notNull(),

  // Timestamp when this snapshot was generated
  generatedAt: timestamp('generated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // Count of members in this snapshot at generation time
  memberCount: integer('member_count').notNull().default(0),

  // INV-AUDIENCE-006: AudienceSnapshotRetention
  // 'active' | 'archived' | 'purged'
  // chk_audience_snapshots_retention_status enforces valid values
  retentionStatus: text('retention_status').notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AudienceSnapshot = typeof audienceSnapshots.$inferSelect;
export type NewAudienceSnapshot = typeof audienceSnapshots.$inferInsert;
