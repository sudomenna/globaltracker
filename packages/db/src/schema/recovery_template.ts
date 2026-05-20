import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

// T-RECOVERY-001: recovery_templates — catálogo de templates Meta aprovados
// (cadastrados na Unnichat) usados pela cadência de recuperação de carrinho.
//
// Cada row representa um template aprovado na conta WhatsApp Business Account
// (BSP Unnichat) com seus placeholders preenchíveis. O sender lê esta tabela,
// resolve os params (contactName, etc.) e dispara via API Unnichat.
//
// Relação com recovery_campaigns:
//   - recovery_campaigns.steps[].template_id aponta para esta tabela.
//   - Soft link via FK em recovery_jobs.template_id (ON DELETE: RESTRICT em
//     prod via SQL — Drizzle não tem default, ver migration 0054).
//
// BR-IDENTITY:    workspace_id é multi-tenant anchor (RLS dual-mode).
// BR-AUDIT-001:   created_by + created_at sempre populados — proveniência é
//                 parte do contrato (mesmo padrão de workspace_tags).
// BR-PRIVACY-001: body_params/url_button_params descrevem placeholders mas
//                 nunca carregam PII em claro.
//
// INV-RECOVERY-TEMPLATE-001: (workspace_id, name) é único.
//   Enforced via uq_recovery_templates_workspace_name.
//
// INV-RECOVERY-TEMPLATE-002: body_params e url_button_params são arrays JSON;
//   cada item segue o contrato `{ type: 'contactName' | 'text', fallback?: string }`.
//   Validação Zod no service layer (sem CHECK DB — flexibilidade para novos
//   tipos de placeholder sem migration).

export const recoveryTemplates = pgTable(
  'recovery_templates',
  {
    // PK: internal UUID
    id: uuid('id').primaryKey().defaultRandom(),

    // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    // Nome canônico interno (ex: "abandono_7min", "abandono_24h").
    // Unicidade por workspace garantida por uq_recovery_templates_workspace_name.
    name: text('name').notNull(),

    // ID do template aprovado no Meta / Unnichat (ex: "2186334448831228").
    // Usado pela API da Unnichat para resolver o template-name.
    unnichatTemplateId: text('unnichat_template_id').notNull(),

    // INV-RECOVERY-TEMPLATE-002: array de placeholders do body do template.
    // Schema: [{ type: 'contactName' | 'text', fallback?: string }, ...]
    // Service layer resolve cada item no momento do envio.
    bodyParams: jsonb('body_params').notNull().default([]),

    // INV-RECOVERY-TEMPLATE-002: array de placeholders da URL do botão (CTA).
    // Mesmo schema de bodyParams.
    urlButtonParams: jsonb('url_button_params').notNull().default([]),

    // Soft toggle — templates inativos são ocultados do picker da UI mas
    // mantidos para histórico (recovery_jobs já criados continuam válidos).
    active: boolean('active').notNull().default(true),

    // Proveniência — mesmo padrão de workspace_tags.created_by:
    //   'user:<uuid>' → criação manual pelo operador
    //   'system:*'    → criação via blueprint / seed
    createdBy: text('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // INV-RECOVERY-TEMPLATE-001: unicidade (workspace_id, name)
    uqRecoveryTemplatesName: uniqueIndex('uq_recovery_templates_workspace_name').on(
      table.workspaceId,
      table.name,
    ),
  }),
);

export type RecoveryTemplate = typeof recoveryTemplates.$inferSelect;
export type NewRecoveryTemplate = typeof recoveryTemplates.$inferInsert;
