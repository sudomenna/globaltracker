import {
  boolean,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { launches } from './launch.js';
import { workspaces } from './workspace.js';

// T-RECOVERY-001: recovery_campaigns — cadência de recuperação por launch.
//
// Cada row define uma cadência (sequência de envios) atrelada a um launch
// + um funnel role gatilho (ex: `bait_offer`). Quando o trigger dispara
// (lead entra em status recuperável daquele role), o job-creator agenda
// um recovery_job por step da `steps[]`.
//
// Janela de envio (send_window_*) garante compliance com a política da
// Meta de não disparar template fora da janela autorizada do operador
// (07:15–22:30 BRT por padrão; configurável por campanha).
//
// recoverable_statuses define quais status do checkout-provider acionam a
// cadência. Exemplos: 'CART_ABANDONED', 'WAITING', 'CANCELED', 'REJECTED',
// 'REFUSED'. Lista é jsonb (não enum) para permitir variações entre
// provedores (Guru, OnProfit, Hotmart) sem migration.
//
// Relação com recovery_templates:
//   - steps[].template_id aponta para recovery_templates.id.
//   - Validação de existência é responsabilidade do service layer.
//
// BR-IDENTITY:    workspace_id é multi-tenant anchor (RLS dual-mode).
// BR-AUDIT-001:   created_at sempre populado.
// BR-PRIVACY-001: catálogo de campanha não contém PII.
//
// INV-RECOVERY-CAMPAIGN-001: (workspace_id, name) é único.
//   Enforced via uq_recovery_campaigns_workspace_name.
//
// INV-RECOVERY-CAMPAIGN-002: steps é array não-vazio de
//   `{ delay_min: number, template_id: uuid }`. Validação Zod no service layer.
//
// INV-RECOVERY-CAMPAIGN-003: recoverable_statuses é array de strings,
//   normalizado em uppercase pelo service layer antes do save.

export const recoveryCampaigns = pgTable(
  'recovery_campaigns',
  {
    // PK: internal UUID
    id: uuid('id').primaryKey().defaultRandom(),

    // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    // FK to launches — campanha de recuperação vive sempre dentro de um launch.
    // ON DELETE CASCADE: apagar o launch limpa todas as campanhas atreladas.
    launchId: uuid('launch_id')
      .notNull()
      .references(() => launches.id, { onDelete: 'cascade' }),

    // Nome canônico interno (ex: "wcs_jun26_bait_abandono").
    // Unicidade por workspace garantida por uq_recovery_campaigns_workspace_name.
    name: text('name').notNull(),

    // Funnel role gatilho — match com funnel_template.pages[].role.
    // Ex: 'bait_offer', 'main_checkout', 'order_bump'.
    // Sem FK rígida — role é texto livre dentro do blueprint do launch.
    triggerFunnelRole: text('trigger_funnel_role').notNull(),

    // INV-RECOVERY-CAMPAIGN-002: array de steps da cadência.
    // Schema: [{ delay_min: number, template_id: uuid }, ...]
    // delay_min é offset desde o trigger; template_id referencia
    // recovery_templates.id (soft, validado no service layer).
    steps: jsonb('steps').notNull(),

    // Janela de envio — limites diários no fuso `send_window_tz`.
    // Cron do sender só dispara jobs cujo agora() local esteja dentro do
    // intervalo [send_window_start, send_window_end].
    // Default: 07:15–22:30 BRT (política Meta + boas práticas operacionais).
    sendWindowStart: time('send_window_start').notNull().default('07:15:00'),
    sendWindowEnd: time('send_window_end').notNull().default('22:30:00'),

    // IANA tz string. Default 'America/Sao_Paulo'.
    sendWindowTz: text('send_window_tz')
      .notNull()
      .default('America/Sao_Paulo'),

    // INV-RECOVERY-CAMPAIGN-003: array de status do checkout-provider que
    // qualificam o lead para entrar na cadência (uppercase normalizado).
    // Ex: ['CART_ABANDONED','WAITING','CANCELED','REJECTED','REFUSED'].
    recoverableStatuses: jsonb('recoverable_statuses').notNull(),

    // Soft toggle — campanhas inativas não geram novos jobs, mas jobs já
    // agendados continuam no fluxo (decisão operacional, validar via UI).
    active: boolean('active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // INV-RECOVERY-CAMPAIGN-001: unicidade (workspace_id, name)
    uqRecoveryCampaignsName: uniqueIndex('uq_recovery_campaigns_workspace_name').on(
      table.workspaceId,
      table.name,
    ),
  }),
);

export type RecoveryCampaign = typeof recoveryCampaigns.$inferSelect;
export type NewRecoveryCampaign = typeof recoveryCampaigns.$inferInsert;
