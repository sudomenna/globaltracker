import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// INV-ENGAGEMENT-004: survey_id is non-empty — enforced by chk_lead_survey_responses_survey_id
// BR-ENGAGEMENT-001 (implicit): survey responses are append-only; re-submission creates a new row
//   with the same survey_id but a new id (historical record preserved).

export const leadSurveyResponses = pgTable('lead_survey_responses', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // FK to leads.id — the lead who submitted the survey
  // on delete restrict: a lead with survey responses cannot be hard-deleted
  leadId: uuid('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'restrict' }),

  // FK to launches.id — optional; survey may not be associated to a specific launch
  launchId: uuid('launch_id').references(() => launches.id, {
    onDelete: 'restrict',
  }),

  // INV-ENGAGEMENT-004: survey_id must be non-empty — chk_lead_survey_responses_survey_id
  // Operator-defined identifier (e.g. "qual-form-v3", typeform id, tally id)
  surveyId: text('survey_id').notNull(),

  // Version of the survey form at time of submission (operator-defined semver or slug)
  surveyVersion: text('survey_version').notNull(),

  // Arbitrary question/answer pairs from the survey form
  // INV-note: no PII stored in clear — operator must hash/omit PII before sending (ADR-009)
  response: jsonb('response').notNull().default({}),

  // Timestamp when the response was recorded (event time, not insert time)
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),

  // Append-only — no updated_at (responses are immutable once inserted)
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LeadSurveyResponse = typeof leadSurveyResponses.$inferSelect;
export type NewLeadSurveyResponse = typeof leadSurveyResponses.$inferInsert;
