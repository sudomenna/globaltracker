-- ============================================================
-- 0054_recovery_unnichat.sql
--
-- T-RECOVERY-001 — Recovery via Unnichat (Wave 1: schema).
--
-- Cria três tabelas para a cadência de recuperação de carrinho via
-- WhatsApp (BSP Unnichat):
--
--   1. recovery_templates  — catálogo de templates Meta aprovados na
--      Unnichat, com placeholders (body_params, url_button_params).
--   2. recovery_campaigns  — cadência por launch + funnel_role, com
--      janela diária de envio e lista de status recuperáveis.
--   3. recovery_jobs       — um envio agendado individual (lifecycle
--      queued → sent | failed | suppressed).
--
-- Aplicação:
--   Esta migration é manuscrita (não gerada por drizzle-kit). O schema
--   Drizzle TS em packages/db/src/schema/recovery_*.ts espelha 1:1 este
--   arquivo, mas serve apenas para typecheck/queries em runtime.
--
--   USER APLICA MANUALMENTE VIA PSQL — mesmo padrão de 0053_workspace_tags.sql.
--   (drizzle-kit migrate ESM está quebrado no monorepo; ver MEMORY.md).
--
-- BRs aplicáveis:
--   BR-IDENTITY:    workspace_id NOT NULL, FK CASCADE para workspaces.
--   BR-RBAC-002:    RLS dual-mode (current_setting('app.current_workspace_id')
--                   OR auth_workspace_id()) — mesmo template de 0053.
--   BR-AUDIT-001:   created_at em todas as tabelas; updated_at em recovery_jobs.
--   BR-PRIVACY-001: nenhuma coluna PII em claro; response_payload sanitizado
--                   no service layer antes do INSERT.
--
-- INVs declaradas:
--   INV-RECOVERY-TEMPLATE-001: (workspace_id, name) único.
--   INV-RECOVERY-CAMPAIGN-001: (workspace_id, name) único.
--   INV-RECOVERY-JOB-001:      (campaign_id, lead_id, step_index, trigger_event_id) único.
--   INV-RECOVERY-JOB-002:      status ∈ {'queued','sent','failed','suppressed'} (CHECK).
--
-- Nota sobre trigger_event_id (recovery_jobs):
--   A tabela `events` é PARTITION BY RANGE (received_at). Postgres não
--   permite FK referenciando tabela particionada quando a PK do parent
--   não inclui todas as colunas da partition key. Mesmo padrão usado em
--   dispatch_jobs.event_id: armazenamos uuid como referência lógica sem
--   FK; integridade validada no app layer (ADR-013).
--
-- BR-RECOVERY (nova família) será criada em wave separada por outro
-- agente — esta migration apenas prepara o substrato schema.
--
-- Idempotência: CREATE TABLE/INDEX usa IF NOT EXISTS; policy usa
-- DROP IF EXISTS + CREATE — re-run = noop.
-- ============================================================

-- ============================================================
-- 1. Table: recovery_templates
-- ============================================================
CREATE TABLE IF NOT EXISTS recovery_templates (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor — BR-RBAC-002.
  workspace_id         uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Nome canônico interno (ex: "abandono_7min", "abandono_24h").
  -- INV-RECOVERY-TEMPLATE-001: unicidade por workspace via uq_* abaixo.
  name                 text        NOT NULL,

  -- ID do template aprovado na conta WhatsApp Business (Meta/Unnichat),
  -- ex: "2186334448831228".
  unnichat_template_id text        NOT NULL,

  -- Array de placeholders do body. Schema:
  --   [{ type: 'contactName' | 'text', fallback?: string }, ...]
  -- Validado por Zod no service layer (sem CHECK DB para permitir novos
  -- `type` sem migration — mesma filosofia de lead_tags.set_by).
  body_params          jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Array de placeholders da URL do botão (CTA). Mesmo schema de body_params.
  url_button_params    jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Soft toggle. Templates inativos saem do picker da UI.
  active               boolean     NOT NULL DEFAULT true,

  -- Proveniência — mesmo padrão de workspace_tags.created_by:
  --   'user:<uuid>' | 'system:*'.
  created_by           text        NOT NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),

  -- INV-RECOVERY-TEMPLATE-001: unicidade (workspace_id, name).
  CONSTRAINT uq_recovery_templates_workspace_name
    UNIQUE (workspace_id, name)
);

COMMENT ON TABLE recovery_templates IS
  'T-RECOVERY-001: catálogo de templates Meta aprovados na Unnichat, com placeholders para body e CTA. Lido pelo sender no momento do envio.';

-- ============================================================
-- 2. Table: recovery_campaigns
-- ============================================================
CREATE TABLE IF NOT EXISTS recovery_campaigns (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor — BR-RBAC-002.
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- FK para launches — campanha vive dentro de um launch.
  -- ON DELETE CASCADE: apagar launch limpa campanhas atreladas.
  launch_id             uuid        NOT NULL REFERENCES launches(id) ON DELETE CASCADE,

  -- Nome canônico interno (ex: "wcs_jun26_bait_abandono").
  -- INV-RECOVERY-CAMPAIGN-001: unicidade por workspace via uq_* abaixo.
  name                  text        NOT NULL,

  -- Funnel role gatilho — match com funnel_template.pages[].role (texto
  -- livre dentro do blueprint do launch; sem FK rígida).
  trigger_funnel_role   text        NOT NULL,

  -- Array de steps da cadência. Schema:
  --   [{ delay_min: number, template_id: uuid }, ...]
  -- delay_min é offset (minutos) desde o trigger; template_id referencia
  -- recovery_templates.id (validação no service layer).
  steps                 jsonb       NOT NULL,

  -- Janela diária de envio (compliance Meta). Default 07:15–22:30 BRT.
  -- Cron do sender só dispara jobs cujo NOW() em send_window_tz esteja
  -- dentro de [send_window_start, send_window_end].
  send_window_start     time        NOT NULL DEFAULT '07:15:00',
  send_window_end       time        NOT NULL DEFAULT '22:30:00',
  send_window_tz        text        NOT NULL DEFAULT 'America/Sao_Paulo',

  -- Array de status do checkout-provider que qualificam o lead para a
  -- cadência (uppercase normalizado no service layer).
  -- Ex: ['CART_ABANDONED','WAITING','CANCELED','REJECTED','REFUSED'].
  recoverable_statuses  jsonb       NOT NULL,

  -- Soft toggle. Campanhas inativas não geram novos jobs.
  active                boolean     NOT NULL DEFAULT true,

  created_at            timestamptz NOT NULL DEFAULT now(),

  -- INV-RECOVERY-CAMPAIGN-001: unicidade (workspace_id, name).
  CONSTRAINT uq_recovery_campaigns_workspace_name
    UNIQUE (workspace_id, name)
);

COMMENT ON TABLE recovery_campaigns IS
  'T-RECOVERY-001: cadência de recuperação por launch + funnel_role. Define steps (delay+template), janela diária de envio e lista de status recuperáveis.';

-- ============================================================
-- 3. Table: recovery_jobs
-- ============================================================
CREATE TABLE IF NOT EXISTS recovery_jobs (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor — BR-RBAC-002.
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- FK para a campanha que originou o job.
  campaign_id           uuid        NOT NULL REFERENCES recovery_campaigns(id) ON DELETE CASCADE,

  -- FK para o lead destinatário.
  lead_id               uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  -- Referência LÓGICA ao evento gatilho em events.id. Sem FK referencial —
  -- events é PARTITION BY RANGE (received_at) e Postgres não permite FK
  -- nesse cenário. Integridade no app layer (mesmo padrão de
  -- dispatch_jobs.event_id, ADR-013).
  trigger_event_id      uuid        NOT NULL,

  -- Índice do step dentro de campaign.steps[] (0-based).
  step_index            integer     NOT NULL,

  -- FK para o template usado neste envio. ON DELETE RESTRICT: template em
  -- uso não pode ser hard-deletado (use active=false).
  template_id           uuid        NOT NULL REFERENCES recovery_templates(id) ON DELETE RESTRICT,

  -- Quando o envio deve acontecer (timestamp absoluto UTC).
  scheduled_for         timestamptz NOT NULL,

  -- INV-RECOVERY-JOB-002: status enum literal — CHECK abaixo.
  status                text        NOT NULL DEFAULT 'queued',

  -- Quando o envio efetivamente saiu (NULL até status='sent').
  sent_at               timestamptz,

  -- ID retornado pela API Unnichat (ex: WAMID).
  unnichat_message_id   text,

  -- Resposta sanitizada da API Unnichat. BR-PRIVACY-001: sanitizar antes
  -- do INSERT (sem PII em claro).
  response_payload      jsonb,

  -- Erro humano para debugging (falha final).
  error                 text,

  -- Contador de tentativas, incrementado pelo sender.
  attempts              integer     NOT NULL DEFAULT 0,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- INV-RECOVERY-JOB-001: idempotência do job-creator.
  CONSTRAINT uq_recovery_jobs_campaign_lead_step_event
    UNIQUE (campaign_id, lead_id, step_index, trigger_event_id),

  -- INV-RECOVERY-JOB-002: status válidos.
  CONSTRAINT chk_recovery_jobs_status
    CHECK (status IN ('queued', 'sent', 'failed', 'suppressed'))
);

COMMENT ON TABLE recovery_jobs IS
  'T-RECOVERY-001: um envio agendado individual da cadência. Lifecycle: queued → sent | failed | suppressed. Cron do sender consulta status=queued AND scheduled_for<=NOW().';

COMMENT ON COLUMN recovery_jobs.trigger_event_id IS
  'Referência LÓGICA a events.id. Sem FK referencial — events é PARTITION BY RANGE (received_at). Integridade no app layer (mesmo padrão de dispatch_jobs.event_id, ADR-013).';

-- Cron do sender (status='queued' AND scheduled_for <= NOW()) — partial
-- index minimiza tamanho já que a maioria das rows vira terminal.
CREATE INDEX IF NOT EXISTS idx_recovery_jobs_status_scheduled
  ON recovery_jobs (status, scheduled_for)
  WHERE status = 'queued';

-- Listagem por campanha na UI do Control Plane.
CREATE INDEX IF NOT EXISTS idx_recovery_jobs_campaign_status
  ON recovery_jobs (campaign_id, status, scheduled_for DESC);

-- Supressão final / hasSentRecoveryToLead(lead_id) lookup.
CREATE INDEX IF NOT EXISTS idx_recovery_jobs_lead_status
  ON recovery_jobs (lead_id, status);

-- ============================================================
-- RLS: recovery_templates — dual-mode (GUC + JWT-derived auth_workspace_id).
-- Padrão idêntico ao de workspace_tags (migration 0053) e demais tabelas
-- workspace-scoped (ver migration 0028 para auth_workspace_id() definition).
-- ============================================================
ALTER TABLE recovery_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recovery_templates_workspace_isolation ON recovery_templates;
CREATE POLICY recovery_templates_workspace_isolation ON recovery_templates
  FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

-- ============================================================
-- RLS: recovery_campaigns — dual-mode (mesmo template).
-- ============================================================
ALTER TABLE recovery_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recovery_campaigns_workspace_isolation ON recovery_campaigns;
CREATE POLICY recovery_campaigns_workspace_isolation ON recovery_campaigns
  FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

-- ============================================================
-- RLS: recovery_jobs — dual-mode (mesmo template).
-- ============================================================
ALTER TABLE recovery_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recovery_jobs_workspace_isolation ON recovery_jobs;
CREATE POLICY recovery_jobs_workspace_isolation ON recovery_jobs
  FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

-- Down (manual rollback, em ordem reversa por causa das FKs):
-- DROP TABLE IF EXISTS recovery_jobs;
-- DROP TABLE IF EXISTS recovery_campaigns;
-- DROP TABLE IF EXISTS recovery_templates;
