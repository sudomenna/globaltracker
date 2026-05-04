import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

// INV-FUNNEL-001: slug unique within (workspace_id or '_global' for system presets)
//   — enforced by uq_funnel_templates_workspace_slug (DB-level unique index)
// INV-FUNNEL-002: is_system=true requires workspace_id IS NULL
//   — enforced by chk_funnel_templates_system_no_workspace
// RLS: authenticated users SELECT system presets (workspace_id IS NULL) + own workspace templates.
//   INSERT/UPDATE/DELETE restricted to own workspace (app.current_workspace_id GUC).

export const funnelTemplates = pgTable('funnel_templates', {
  // PK: internal UUID — never exposed to browser directly
  id: uuid('id').primaryKey().defaultRandom(),

  // NULL = system/global preset; NOT NULL = workspace-scoped template
  // INV-FUNNEL-002: system templates (is_system=true) must have workspaceId = null
  // Multi-tenant anchor — BR-RBAC-002: app.current_workspace_id enforced by RLS
  workspaceId: uuid('workspace_id').references(() => workspaces.id, {
    onDelete: 'cascade',
  }),

  // INV-FUNNEL-001: unique within scope (workspace or system) — uq_funnel_templates_workspace_slug
  slug: text('slug').notNull(),

  name: text('name').notNull(),

  description: text('description'),

  // Full funnel blueprint JSONB — shape validated by FunnelBlueprintSchema (Zod) at Edge layer
  blueprint: jsonb('blueprint').notNull(),

  // true = GlobalTracker system preset; false = user-created within workspace
  // INV-FUNNEL-002: is_system=true implies workspaceId IS NULL
  isSystem: boolean('is_system').notNull().default(false),

  // FunnelTemplateStatus: 'active' | 'archived'
  // chk_funnel_templates_status enforces allowed values at DB level
  status: text('status').notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type FunnelTemplate = typeof funnelTemplates.$inferSelect;
export type NewFunnelTemplate = typeof funnelTemplates.$inferInsert;
