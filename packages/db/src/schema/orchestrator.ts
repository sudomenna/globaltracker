import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { workspaces } from './workspace.js';

// T-7-001: Schema MOD-ORCHESTRATOR — workflow_runs, lp_deployments, campaign_provisions
//
// BR-RBAC-002: workspace_id is the multi-tenant anchor on all three tables.
//   RLS enforces app.current_workspace_id per request transaction.
//
// BR-AUDIT-001: these tables are append-only for audit purposes.
//   No DELETE is issued by application code; purge by retention job only.
//
// BR-PRIVACY-001: trigger_payload, provision_payload, and rollback_payload are
//   jsonb columns that MUST NOT contain PII in clear. The upstream service layer
//   is responsible for sanitizing payloads before insert.
//
// INV-ORC-001: workflow_runs.status ∈ {'running','waiting_approval','completed',
//   'failed','rolled_back','expired'} — enforced by chk_workflow_runs_status.
// INV-ORC-002: lp_deployments.slug is unique per workspace —
//   enforced by uq_lp_deployments_workspace_slug.
// INV-ORC-003: campaign_provisions.platform ∈ {'meta','google'} —
//   enforced by chk_campaign_provisions_platform.

// ---------------------------------------------------------------------------
// workflow_runs — tracks each Trigger.dev workflow execution
// ---------------------------------------------------------------------------

export const workflowRuns = pgTable('workflow_runs', {
  // PK: internal UUID (02-db-schema-conventions.md)
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // workflow: identifies which Trigger.dev workflow was executed
  // INV-ORC-001 (partial): chk_workflow_runs_workflow enforces allowed values
  // Allowed: 'setup-tracking' | 'deploy-lp' | 'provision-campaigns' | 'rollback-provisioning'
  workflow: text('workflow').notNull(),

  // status: lifecycle state of the workflow run
  // INV-ORC-001: chk_workflow_runs_status enforces the 6-value enum
  // Allowed: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'rolled_back' | 'expired'
  status: text('status').notNull().default('running'),

  // trigger_payload: payload that initiated the workflow (no PII — BR-PRIVACY-001)
  triggerPayload: jsonb('trigger_payload').notNull().default({}),

  // result: final result of the workflow; NULL while running
  result: jsonb('result'),

  // trigger_run_id: the run ID in Trigger.dev for cross-platform correlation
  // NULL until Trigger.dev returns an ID
  triggerRunId: text('trigger_run_id'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;

// ---------------------------------------------------------------------------
// lp_deployments — records LP template deploys to CF Pages
// ---------------------------------------------------------------------------

export const lpDeployments = pgTable('lp_deployments', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // run_id: the workflow_run that triggered this deployment
  runId: uuid('run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'restrict' }),

  // launch_id: the launch this LP belongs to
  launchId: uuid('launch_id')
    .notNull()
    .references(() => launches.id, { onDelete: 'restrict' }),

  // template: name of the Astro template used
  template: text('template').notNull(),

  // slug: unique per workspace — INV-ORC-002: uq_lp_deployments_workspace_slug
  slug: text('slug').notNull(),

  // domain: optional custom FQDN; NULL when using default CF Pages domain
  domain: text('domain'),

  // cf_pages_url: final published URL on CF Pages; NULL until deployed
  cfPagesUrl: text('cf_pages_url'),

  // status: lifecycle of the deployment
  // chk_lp_deployments_status: 'deploying' | 'deployed' | 'failed'
  status: text('status').notNull().default('deploying'),

  // deployed_at: when the deploy completed successfully; NULL while deploying
  deployedAt: timestamp('deployed_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LpDeployment = typeof lpDeployments.$inferSelect;
export type NewLpDeployment = typeof lpDeployments.$inferInsert;

// ---------------------------------------------------------------------------
// campaign_provisions — tracks Meta/Google campaign provisioning
// ---------------------------------------------------------------------------

export const campaignProvisions = pgTable('campaign_provisions', {
  // PK: internal UUID
  id: uuid('id').primaryKey().defaultRandom(),

  // Multi-tenant anchor — BR-RBAC-002
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' }),

  // run_id: the workflow_run that triggered this provisioning
  runId: uuid('run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'restrict' }),

  // launch_id: the launch this campaign provision belongs to
  launchId: uuid('launch_id')
    .notNull()
    .references(() => launches.id, { onDelete: 'restrict' }),

  // platform: target ad platform — INV-ORC-003: chk_campaign_provisions_platform
  // Platform: 'meta' | 'google'
  platform: text('platform').notNull(),

  // external_id: ID returned by the platform API (Ad Set ID, Campaign ID, etc.)
  // NULL until the platform returns an ID
  externalId: text('external_id'),

  // status: lifecycle of the provisioning
  // chk_campaign_provisions_status: 'pending' | 'pending_approval' | 'active' | 'failed' | 'rolled_back'
  status: text('status').notNull().default('pending'),

  // provision_payload: payload sent to the platform API (no PII — BR-PRIVACY-001)
  provisionPayload: jsonb('provision_payload').notNull().default({}),

  // rollback_payload: data needed to undo provisioning (external IDs, prior state)
  // BR-PRIVACY-001: no PII; only platform IDs and non-personal metadata
  rollbackPayload: jsonb('rollback_payload').notNull().default({}),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CampaignProvision = typeof campaignProvisions.$inferSelect;
export type NewCampaignProvision = typeof campaignProvisions.$inferInsert;
