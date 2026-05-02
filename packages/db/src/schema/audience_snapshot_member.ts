import { pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { audienceSnapshots } from './audience_snapshot.js';
import { leads } from './lead.js';

// Composite PK: (snapshot_id, lead_id) — junction table (30-contracts/02)
//   on delete cascade from snapshot: if snapshot is physically deleted, members go with it
//   on delete restrict from lead: cannot delete a lead that is a snapshot member
//
// INV-AUDIENCE-005 / BR-AUDIENCE-004: leads without required consent are excluded
//   BEFORE insert into this table. Enforcement is at evaluateAudience() service layer.
//
// NOTE: workspace_id is intentionally omitted from this junction table.
//   RLS isolation is achieved transitively: access to audience_snapshots is gated by
//   the audience_snapshots RLS policy which itself filters by workspace_id.
//   Querying audience_snapshot_members always JOINs through audience_snapshots,
//   so cross-workspace leaks are structurally prevented.
//   See 30-contracts/02-db-schema-conventions.md — junction tables use cascade FK.

export const audienceSnapshotMembers = pgTable(
  'audience_snapshot_members',
  {
    // FK to the snapshot this member belongs to
    // on delete cascade: purging a snapshot deletes its members (INV-AUDIENCE-006 purge phase)
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => audienceSnapshots.id, { onDelete: 'cascade' }),

    // FK to the lead included in this snapshot
    // on delete restrict: cannot delete a lead that appears in an active snapshot
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'restrict' }),
  },
  (table) => ({
    // Composite PK — junction table convention (30-contracts/02)
    pk: primaryKey({ columns: [table.snapshotId, table.leadId] }),
  }),
);

export type AudienceSnapshotMember =
  typeof audienceSnapshotMembers.$inferSelect;
export type NewAudienceSnapshotMember =
  typeof audienceSnapshotMembers.$inferInsert;
