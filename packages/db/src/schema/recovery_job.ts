import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
} from 'drizzle-orm/pg-core';
import { leads } from './lead.js';
import { recoveryCampaigns } from './recovery_campaign.js';
import { recoveryTemplates } from './recovery_template.js';
import { workspaces } from './workspace.js';

// T-RECOVERY-001: recovery_jobs — um envio agendado individual da cadência.
//
// Lifecycle:
//   1. Trigger (lead entra em status recuperável) → job-creator insere N rows
//      (uma por step da campaign.steps[]) com status='queued' e scheduled_for
//      = trigger_time + delay_min.
//   2. Cron do sender consulta `status='queued' AND scheduled_for <= NOW()`
//      dentro da janela `send_window_*` da campaign.
//   3. Após envio bem-sucedido: status='sent', sent_at=NOW(),
//      unnichat_message_id preenchido.
//   4. Falha permanente: status='failed', error preenchido (após attempts >= N).
//   5. Supressão (lead virou cliente, opt-out, etc.): status='suppressed'
//      (não dispara, mas mantém histórico).
//
// trigger_event_id é referência LÓGICA ao evento gatilho em events.id.
// A tabela events é PARTITION BY RANGE (received_at), e Postgres exige que a
// PK de uma tabela particionada inclua todas as colunas da partition key para
// permitir FK. Como events.id sozinho não é PK total, NÃO há FK referencial
// (mesmo padrão de dispatch_jobs.event_id — ver dispatch_job.ts). Integridade
// é responsabilidade do app layer.
//
// BR-IDENTITY:    workspace_id é multi-tenant anchor (RLS dual-mode).
// BR-AUDIT-001:   created_at + updated_at sempre populados.
// BR-PRIVACY-001: response_payload sanitizado antes de persistir (sem PII em
//                 claro). Service layer aplica sanitizeLogs() antes do write.
//
// INV-RECOVERY-JOB-001: (campaign_id, lead_id, step_index, trigger_event_id)
//   é único — garante idempotência do job-creator. Enforced via
//   uq_recovery_jobs_campaign_lead_step_event.
//
// INV-RECOVERY-JOB-002: status ∈ {'queued','sent','failed','suppressed'}.
//   Enforced via CHECK constraint na migration (chk_recovery_jobs_status).
//
// INV-RECOVERY-JOB-003: status='sent' implica sent_at IS NOT NULL.
//   Validado no service layer (sem CHECK DB — coluna pode ser populada em
//   write paralelo ao status update).

export const recoveryJobs = pgTable(
  'recovery_jobs',
  {
    // PK: internal UUID
    id: uuid('id').primaryKey().defaultRandom(),

    // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    // FK to recovery_campaigns — campanha que originou o job.
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => recoveryCampaigns.id, { onDelete: 'cascade' }),

    // FK to leads — destinatário do template.
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),

    // Referência LÓGICA ao evento gatilho (events.id). Sem FK referencial —
    // ver nota de partitioning no header deste arquivo.
    triggerEventId: uuid('trigger_event_id').notNull(),

    // Índice do step dentro de campaign.steps[] (0-based).
    stepIndex: integer('step_index').notNull(),

    // FK to recovery_templates — template usado no envio.
    templateId: uuid('template_id')
      .notNull()
      .references(() => recoveryTemplates.id, { onDelete: 'restrict' }),

    // Quando o envio deve acontecer. Cron do sender consulta
    // `status='queued' AND scheduled_for <= NOW()`.
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),

    // INV-RECOVERY-JOB-002: enum literal — chk_recovery_jobs_status.
    // 'queued'     → aguardando janela + dispatch
    // 'sent'       → enviado com sucesso
    // 'failed'     → falha permanente após attempts >= N
    // 'suppressed' → suprimido (lead virou cliente, opt-out, fora de janela)
    status: text('status').notNull().default('queued'),

    // Quando o envio efetivamente saiu (status='sent').
    // INV-RECOVERY-JOB-003: status='sent' → sent_at NOT NULL.
    sentAt: timestamp('sent_at', { withTimezone: true }),

    // ID retornado pela API Unnichat após envio (ex: WAMID). Usado para
    // correlacionar com webhook de delivery/read futuro.
    unnichatMessageId: text('unnichat_message_id'),

    // Resposta sanitizada da API Unnichat (sucesso ou erro). jsonb por
    // flexibilidade — schema definido no dispatcher.
    // BR-PRIVACY-001: sanitizado antes de persistir.
    responsePayload: jsonb('response_payload'),

    // Mensagem de erro humana para debugging (falha final).
    error: text('error'),

    // Contador de tentativas — incrementado a cada attempt do sender.
    // Política de backoff/max_attempts vive no service layer (config global
    // do módulo recovery, não por job).
    attempts: integer('attempts').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // INV-RECOVERY-JOB-001: idempotência do job-creator.
    uqRecoveryJobsIdempotency: uniqueIndex(
      'uq_recovery_jobs_campaign_lead_step_event',
    ).on(table.campaignId, table.leadId, table.stepIndex, table.triggerEventId),

    // Cron do sender: "jobs prontos para envio" — partial index minimiza
    // tamanho/IO já que a maioria das rows vai estar em estado terminal.
    idxStatusScheduled: index('idx_recovery_jobs_status_scheduled')
      .on(table.status, table.scheduledFor),

    // Listagem por campanha na UI do Control Plane.
    idxCampaignStatus: index('idx_recovery_jobs_campaign_status').on(
      table.campaignId,
      table.status,
      table.scheduledFor,
    ),

    // Supressão final (`hasSentRecoveryToLead(lead_id)` / opt-out check).
    idxLeadStatus: index('idx_recovery_jobs_lead_status').on(
      table.leadId,
      table.status,
    ),
  }),
);

export type RecoveryJob = typeof recoveryJobs.$inferSelect;
export type NewRecoveryJob = typeof recoveryJobs.$inferInsert;
