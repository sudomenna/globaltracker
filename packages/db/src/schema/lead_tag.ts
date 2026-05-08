import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { leads } from './lead.js';
import { workspaces } from './workspace.js';

// T-LEADS-VIEW-001: lead_tags — atributos binários atemporais por lead, workspace-scoped.
//
// Diferença canônica vs. outras estruturas:
//   - lead_stages: progressão monotônica num funil (com source_event_id, recurring, etc.).
//   - events:      fato pontual com timestamp.
//   - lead_tags:   atributo binário do lead (presente/ausente), workspace-scoped, atemporal.
//
// Eventos podem disparar simultaneamente: stage promotion + tag set
// (ex.: `custom:wpp_joined` → stage `group_joined` + tag `joined_group`).
// Regras vivem no blueprint (`tag_rules`).
//
// BR-IDENTITY: lead_tags é workspace-scoped (RLS).
// BR-AUDIT-001: set_by + set_at sempre populados — proveniência é parte do contrato.
//
// INV-LEAD-TAG-001: (workspace_id, lead_id, tag_name) é único.
//   Enforced via uq_lead_tags_workspace_lead_tag (DB-level unique index).
//
// INV-LEAD-TAG-002: set_by segue padrão `system | user:<uuid> | integration:<name> | event:<event_name>`.
//   Validação de formato é responsabilidade do service layer (não há check DB
//   por flexibilidade — abrir nova fonte não exige migration).

export const leadTags = pgTable(
  'lead_tags',
  {
    // PK: internal UUID
    id: uuid('id').primaryKey().defaultRandom(),

    // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    // FK to leads — on delete cascade: tag desaparece se o lead for hard-deleted (SAR/erasure)
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),

    // Tag name (ex.: 'joined_group', 'survey_responded', 'bait_purchased', 'main_purchased').
    // Operator-defined; não há lista fechada DB-side. Convenções vivem no blueprint (`tag_rules`).
    tagName: text('tag_name').notNull(),

    // Quando a tag foi setada
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),

    // Proveniência — INV-LEAD-TAG-002:
    //   'system'              → backfill / lógica interna
    //   'user:<uuid>'         → ação manual de operador (workspace_member.user_id)
    //   'integration:<name>'  → ex. 'integration:sendflow', 'integration:guru'
    //   'event:<event_name>'  → tag setada por tag_rule disparada por evento
    setBy: text('set_by').notNull(),
  },
  (table) => ({
    // INV-LEAD-TAG-001: unique (workspace_id, lead_id, tag_name)
    uqWorkspaceLeadTag: uniqueIndex('uq_lead_tags_workspace_lead_tag').on(
      table.workspaceId,
      table.leadId,
      table.tagName,
    ),
  }),
);

export type LeadTag = typeof leadTags.$inferSelect;
export type NewLeadTag = typeof leadTags.$inferInsert;
