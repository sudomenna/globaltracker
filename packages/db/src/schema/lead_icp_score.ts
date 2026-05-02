import {
  boolean,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// BR-ENGAGEMENT-001: ICP score is versioned — a rule change produces a new row with a new
//   score_version rather than updating the existing record. Historical scores are preserved.
//
// INV-ENGAGEMENT-002: score_version must be non-empty — enforced by chk_lead_icp_scores_score_version
// INV-ENGAGEMENT-003: score_value must be a finite numeric (no NaN, no Infinity) — enforced
//   by DB numeric type; application layer must validate with Zod before insert.

export const leadIcpScores = pgTable('lead_icp_scores', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to leads.id — the lead being scored
  leadId: uuid('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // FK to launches.id — optional; score may be workspace-wide or launch-specific
  launchId: uuid('launch_id').references(() => launches.id, {
    onDelete: 'restrict',
  }),

  // INV-ENGAGEMENT-002: must be non-empty — chk_lead_icp_scores_score_version
  // BR-ENGAGEMENT-001: version string identifies the scoring rule set (e.g. "v1", "2026-05")
  scoreVersion: text('score_version').notNull(),

  // INV-ENGAGEMENT-003: finite numeric — numeric(10,4) avoids float precision issues
  // Typical range: 0.0000 to 100.0000 (operator-defined scale)
  scoreValue: numeric('score_value', { precision: 10, scale: 4 }).notNull(),

  // True when score_value meets the ICP threshold defined by score_version rules
  // Triggers TE-ICP-SCORED timeline event and optional MOD-FUNNEL stage 'icp_qualified'
  isIcp: boolean('is_icp').notNull().default(false),

  // Snapshot of the input fields evaluated during scoring (for audit/debugging)
  // No PII in clear — operator must hash/omit per ADR-009
  inputs: jsonb('inputs').notNull().default({}),

  // Timestamp when the evaluation was performed
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // Append-only — no updated_at (BR-ENGAGEMENT-001: mutation = new row with new score_version)
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LeadIcpScore = typeof leadIcpScores.$inferSelect;
export type NewLeadIcpScore = typeof leadIcpScores.$inferInsert;
