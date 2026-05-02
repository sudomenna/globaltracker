import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// INV-FUNNEL-001: unique (workspace_id, launch_id, lead_id, stage) WHERE is_recurring = false
//   Non-recurring stages may be recorded only once per (lead, launch, stage) combination.
//   Partial unique index uq_lead_stages_non_recurring enforces this at the DB layer.
//
// INV-FUNNEL-002: source_event_id (when present) references an event in the same workspace/lead.
//   Enforced at the service layer (recordStage). DB holds FK to events table (added in T-1-005).
//   NOTE: events table is created in T-1-005; FK is deferred to that migration.
//
// INV-FUNNEL-003: stage is non-empty and length ≤ 64.
//   chk_lead_stages_stage_length constraint enforces this at the DB layer.
//
// INV-FUNNEL-004: stages for the same lead in different launches do not conflict.
//   Implicitly guaranteed because the unique partial index includes launch_id.
//
// BR-FUNNEL-001: stage='purchased' is unique per purchase (not auto-refunded).
//   Enforced by is_recurring=false for purchased stage — service layer sets this.

export const leadStages = pgTable('lead_stages', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to leads — on delete restrict to prevent orphaned stage records
  // INV-FUNNEL-002: stage belongs to the same workspace as the lead
  leadId: uuid('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // FK to launches — on delete restrict to preserve stage history
  launchId: uuid('launch_id')
    .notNull()
    .references(() => launches.id, { onDelete: 'restrict' }),

  // Stage name — operator-defined text (not a closed enum; see docs/30-contracts/01-enums.md Stage note)
  // INV-FUNNEL-003: non-empty, length ≤ 64
  // chk_lead_stages_stage_length enforces this (defined in migration)
  stage: text('stage').notNull(),

  // INV-FUNNEL-001: when false, this row participates in the partial unique index.
  //   When true (recurrent stages like watched_class_1), multiple rows are allowed.
  isRecurring: boolean('is_recurring').notNull().default(false),

  // source_event_id: optional FK to the event that triggered this stage transition.
  // INV-FUNNEL-002: when present, must reference an event in the same workspace and lead.
  //   FK to events table is added in migration 0013 (T-1-005 creates events; FK added here).
  //   Application layer validates same-workspace/same-lead constraint (recordStage).
  sourceEventId: uuid('source_event_id'),

  // ts: wall-clock time when this stage was recorded
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
});

export type LeadStage = typeof leadStages.$inferSelect;
export type NewLeadStage = typeof leadStages.$inferInsert;
