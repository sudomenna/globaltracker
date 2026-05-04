-- Migration: 0029_funnel_templates
-- T-FUNIL-010: funnel_templates table + launches extensions
-- Sprint 10 — Funil Configurável Fase 2
--
-- Depends on: 0002_launch_table.sql (launches), 0001_workspace_tables.sql (workspaces)
--
-- funnel_templates holds both system-wide presets (workspace_id IS NULL)
-- and workspace-scoped custom templates.
-- Uniqueness: (COALESCE(workspace_id::text, '_global'), slug) — INV-FUNNEL-001
-- RLS: authenticated users see system presets + their workspace templates.
-- INSERT/UPDATE/DELETE restricted to workspace members (app.current_workspace_id must match).

-- ============================================================
-- Table: funnel_templates
-- INV-FUNNEL-001: slug unique within (workspace_id or system scope)
--   — enforced by uq_funnel_templates_workspace_slug
-- INV-FUNNEL-002: system templates (is_system=true) have workspace_id IS NULL
--   — enforced by chk_funnel_templates_system_no_workspace
-- ============================================================
CREATE TABLE IF NOT EXISTS funnel_templates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL = system/global preset; NOT NULL = workspace-scoped template
  -- INV-FUNNEL-002: system templates must have workspace_id IS NULL
  workspace_id uuid        NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Unique identifier within scope (system or workspace) — INV-FUNNEL-001
  slug         text        NOT NULL,

  name         text        NOT NULL,
  description  text,

  -- Full funnel blueprint (stages, pages, audiences, type, etc.)
  -- Shape validated by FunnelBlueprintSchema (Zod) at Edge layer before persistence
  blueprint    jsonb       NOT NULL,

  -- true = managed by GlobalTracker system; false = user-created within workspace
  -- INV-FUNNEL-002: is_system=true requires workspace_id IS NULL
  is_system    boolean     NOT NULL DEFAULT false,

  -- FunnelTemplateStatus: 'active' | 'archived'
  -- chk_funnel_templates_status enforces allowed values
  status       text        NOT NULL DEFAULT 'active',

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- INV-FUNNEL-002: system templates must not belong to a workspace
  CONSTRAINT chk_funnel_templates_system_no_workspace CHECK (
    NOT (is_system = true AND workspace_id IS NOT NULL)
  ),

  -- Status allowed values
  CONSTRAINT chk_funnel_templates_status CHECK (
    status IN ('active', 'archived')
  )
);

-- INV-FUNNEL-001: slug unique per (workspace_id or '_global' for system presets)
CREATE UNIQUE INDEX uq_funnel_templates_workspace_slug
  ON funnel_templates (COALESCE(workspace_id::text, '_global'), slug);

-- idx_funnel_templates_workspace_id: supports RLS filter + list queries
CREATE INDEX idx_funnel_templates_workspace_id
  ON funnel_templates (workspace_id);

-- idx_funnel_templates_is_system: fast lookup of system presets
CREATE INDEX idx_funnel_templates_is_system
  ON funnel_templates (is_system)
  WHERE is_system = true;

-- Trigger: auto-update updated_at (reuses set_updated_at() from 0001)
CREATE TRIGGER trg_funnel_templates_before_update_set_updated_at
  BEFORE UPDATE ON funnel_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS: funnel_templates
-- SELECT: system presets visible to all authenticated; workspace templates isolated.
-- INSERT/UPDATE/DELETE: only workspace members.
-- Dual-mode (migration 0028): GUC app.current_workspace_id (Edge Worker)
--   OR public.auth_workspace_id() (Supabase JWT via supabase-js).
-- ============================================================
ALTER TABLE funnel_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY funnel_templates_select ON funnel_templates
  FOR SELECT
  USING (
    workspace_id IS NULL
    OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

CREATE POLICY funnel_templates_insert ON funnel_templates
  FOR INSERT
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

CREATE POLICY funnel_templates_update ON funnel_templates
  FOR UPDATE
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

CREATE POLICY funnel_templates_delete ON funnel_templates
  FOR DELETE
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

-- ============================================================
-- Extend launches: funnel_template_id + funnel_blueprint
-- ============================================================
ALTER TABLE launches
  ADD COLUMN IF NOT EXISTS funnel_template_id uuid NULL
    REFERENCES funnel_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS funnel_blueprint    jsonb NULL;

-- idx_launches_funnel_template_id: supports lookups of all launches using a template
CREATE INDEX idx_launches_funnel_template_id
  ON launches (funnel_template_id)
  WHERE funnel_template_id IS NOT NULL;

-- Down (manual rollback):
-- ALTER TABLE launches DROP COLUMN IF EXISTS funnel_blueprint;
-- ALTER TABLE launches DROP COLUMN IF EXISTS funnel_template_id;
-- DROP TABLE IF EXISTS funnel_templates;

-- ============================================================
-- Seed: 4 presets globais (workspace_id = NULL, is_system = true)
-- T-FUNIL-014
--
-- Fixed UUIDs (for stable cross-references in tests / future seeds):
--   lancamento_gratuito_3_aulas              = 'a1000000-0000-0000-0000-000000000001'
--   lancamento_pago_workshop_com_main_offer  = 'a1000000-0000-0000-0000-000000000002'
--   lancamento_pago_workshop_apenas          = 'a1000000-0000-0000-0000-000000000003'
--   evergreen_direct_sale                    = 'a1000000-0000-0000-0000-000000000004'
-- ============================================================

INSERT INTO funnel_templates (id, workspace_id, slug, name, description, blueprint, is_system, status)
VALUES (
  'a1000000-0000-0000-0000-000000000001',
  NULL,
  'lancamento_gratuito_3_aulas',
  'Lançamento Gratuito — 3 Aulas',
  'Funil de lançamento com sequência de 3 aulas gratuitas antes da abertura do carrinho.',
  $json${
    "type": "lancamento_gratuito",
    "has_main_offer": true,
    "has_workshop": false,
    "stages": [
      {"slug": "lead_identified",  "label": "Lead identificado",       "is_recurring": false, "source_events": ["Lead"]},
      {"slug": "wpp_joined",       "label": "Entrou no WhatsApp",      "is_recurring": false, "source_events": ["Contact"]},
      {"slug": "watched_class_1",  "label": "Assistiu aula 1",         "is_recurring": false, "source_events": ["custom:watched_class_1"]},
      {"slug": "watched_class_2",  "label": "Assistiu aula 2",         "is_recurring": false, "source_events": ["custom:watched_class_2"]},
      {"slug": "watched_class_3",  "label": "Assistiu aula 3",         "is_recurring": false, "source_events": ["custom:watched_class_3"]},
      {"slug": "clicked_buy_main", "label": "Clicou em comprar",       "is_recurring": true,  "source_events": ["InitiateCheckout"]},
      {"slug": "purchased_main",   "label": "Comprou oferta principal","is_recurring": false, "source_events": ["Purchase"]}
    ],
    "pages": [
      {"role": "capture",  "suggested_public_id": "captura",  "event_config": {"canonical": ["PageView","Lead"],                         "custom": []}},
      {"role": "sales",    "suggested_public_id": "vendas",   "event_config": {"canonical": ["PageView","ViewContent","InitiateCheckout"],"custom": []}},
      {"role": "thankyou", "suggested_public_id": "obrigado", "event_config": {"canonical": ["PageView","Purchase"],                     "custom": []}}
    ],
    "audiences": [
      {"slug": "cadastrados_sem_compra",  "name": "Cadastrados sem compra",     "platform": "meta", "query_template": {"stage_not": "purchased_main",  "stage_gte": "lead_identified"}},
      {"slug": "engajados_aula_2",        "name": "Engajados aula 2+",          "platform": "meta", "query_template": {"stage_gte": "watched_class_2"}},
      {"slug": "abandono_checkout_main",  "name": "Abandono checkout",          "platform": "meta", "query_template": {"stage_eq": "clicked_buy_main", "stage_not": "purchased_main"}},
      {"slug": "compradores_main",        "name": "Compradores oferta principal","platform": "meta","query_template": {"stage_eq": "purchased_main"}}
    ]
  }$json$::jsonb,
  true,
  'active'
)
ON CONFLICT (COALESCE(workspace_id::text, '_global'), slug) DO NOTHING;

INSERT INTO funnel_templates (id, workspace_id, slug, name, description, blueprint, is_system, status)
VALUES (
  'a1000000-0000-0000-0000-000000000002',
  NULL,
  'lancamento_pago_workshop_com_main_offer',
  'Lançamento Pago — Workshop + Oferta Principal',
  'Funil de lançamento com workshop pago como aquecimento e oferta principal ao final.',
  $json${
    "type": "lancamento_pago",
    "has_main_offer": true,
    "has_workshop": true,
    "stages": [
      {"slug": "lead_workshop",        "label": "Lead workshop",                  "is_recurring": false, "source_events": ["Lead"]},
      {"slug": "clicked_buy_workshop", "label": "Clicou comprar workshop",        "is_recurring": true,  "source_events": ["InitiateCheckout"], "source_event_filters": {"funnel_role": "workshop"}},
      {"slug": "purchased_workshop",   "label": "Comprou workshop",               "is_recurring": false, "source_events": ["Purchase"],         "source_event_filters": {"funnel_role": "workshop"}},
      {"slug": "wpp_joined",           "label": "Entrou no WhatsApp",             "is_recurring": false, "source_events": ["Contact"]},
      {"slug": "watched_class_1",      "label": "Assistiu aula 1",               "is_recurring": false, "source_events": ["custom:watched_class_1"]},
      {"slug": "watched_class_2",      "label": "Assistiu aula 2",               "is_recurring": false, "source_events": ["custom:watched_class_2"]},
      {"slug": "watched_class_3",      "label": "Assistiu aula 3",               "is_recurring": false, "source_events": ["custom:watched_class_3"]},
      {"slug": "clicked_buy_main",     "label": "Clicou comprar oferta principal","is_recurring": true,  "source_events": ["InitiateCheckout"], "source_event_filters": {"funnel_role": "main_offer"}},
      {"slug": "purchased_main",       "label": "Comprou oferta principal",       "is_recurring": false, "source_events": ["Purchase"],         "source_event_filters": {"funnel_role": "main_offer"}}
    ],
    "pages": [
      {"role": "sales",    "suggested_public_id": "workshop",           "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","ViewContent","InitiateCheckout"],"custom": []}},
      {"role": "thankyou", "suggested_public_id": "obrigado-workshop",  "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","Purchase"],                     "custom": []}},
      {"role": "sales",    "suggested_public_id": "oferta-principal",   "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","ViewContent","InitiateCheckout"],"custom": []}},
      {"role": "thankyou", "suggested_public_id": "obrigado-principal", "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","Purchase"],                     "custom": []}}
    ],
    "audiences": [
      {"slug": "compradores_workshop_aquecimento","name": "Compradores workshop — aquecimento",  "platform": "meta", "query_template": {"stage_eq": "purchased_workshop", "stage_not": "purchased_main"}},
      {"slug": "engajados_workshop",              "name": "Engajados no workshop",               "platform": "meta", "query_template": {"stage_gte": "watched_class_1"}},
      {"slug": "abandono_main_offer",             "name": "Abandono oferta principal",           "platform": "meta", "query_template": {"stage_eq": "clicked_buy_main",  "stage_not": "purchased_main"}},
      {"slug": "compradores_main",                "name": "Compradores oferta principal",         "platform": "meta","query_template": {"stage_eq": "purchased_main"}},
      {"slug": "compradores_apenas_workshop",     "name": "Apenas compradores workshop",          "platform": "meta","query_template": {"stage_eq": "purchased_workshop", "stage_not": "purchased_main"}}
    ]
  }$json$::jsonb,
  true,
  'active'
)
ON CONFLICT (COALESCE(workspace_id::text, '_global'), slug) DO NOTHING;

INSERT INTO funnel_templates (id, workspace_id, slug, name, description, blueprint, is_system, status)
VALUES (
  'a1000000-0000-0000-0000-000000000003',
  NULL,
  'lancamento_pago_workshop_apenas',
  'Lançamento Pago — Apenas Workshop',
  'Funil de lançamento com workshop pago como produto único, sem oferta principal subsequente.',
  $json${
    "type": "lancamento_pago",
    "has_main_offer": false,
    "has_workshop": true,
    "stages": [
      {"slug": "lead_workshop",        "label": "Lead workshop",           "is_recurring": false, "source_events": ["Lead"]},
      {"slug": "clicked_buy_workshop", "label": "Clicou comprar workshop", "is_recurring": true,  "source_events": ["InitiateCheckout"], "source_event_filters": {"funnel_role": "workshop"}},
      {"slug": "purchased_workshop",   "label": "Comprou workshop",        "is_recurring": false, "source_events": ["Purchase"],         "source_event_filters": {"funnel_role": "workshop"}},
      {"slug": "wpp_joined",           "label": "Entrou no WhatsApp",      "is_recurring": false, "source_events": ["Contact"]},
      {"slug": "watched_class_1",      "label": "Assistiu aula 1",        "is_recurring": false, "source_events": ["custom:watched_class_1"]},
      {"slug": "watched_class_2",      "label": "Assistiu aula 2",        "is_recurring": false, "source_events": ["custom:watched_class_2"]},
      {"slug": "watched_class_3",      "label": "Assistiu aula 3",        "is_recurring": false, "source_events": ["custom:watched_class_3"]}
    ],
    "pages": [
      {"role": "sales",    "suggested_public_id": "workshop",          "suggested_funnel_role": "workshop", "event_config": {"canonical": ["PageView","ViewContent","InitiateCheckout"],"custom": []}},
      {"role": "thankyou", "suggested_public_id": "obrigado-workshop", "suggested_funnel_role": "workshop", "event_config": {"canonical": ["PageView","Purchase"],                     "custom": []}}
    ],
    "audiences": [
      {"slug": "leads_sem_compra_workshop",  "name": "Leads sem compra do workshop",  "platform": "meta", "query_template": {"stage_not": "purchased_workshop", "stage_gte": "lead_workshop"}},
      {"slug": "abandono_checkout_workshop", "name": "Abandono checkout workshop",    "platform": "meta", "query_template": {"stage_eq": "clicked_buy_workshop","stage_not": "purchased_workshop"}},
      {"slug": "compradores_workshop",       "name": "Compradores workshop",          "platform": "meta", "query_template": {"stage_eq": "purchased_workshop"}},
      {"slug": "engajados_workshop",         "name": "Engajados no workshop",         "platform": "meta", "query_template": {"stage_gte": "watched_class_1"}}
    ]
  }$json$::jsonb,
  true,
  'active'
)
ON CONFLICT (COALESCE(workspace_id::text, '_global'), slug) DO NOTHING;

INSERT INTO funnel_templates (id, workspace_id, slug, name, description, blueprint, is_system, status)
VALUES (
  'a1000000-0000-0000-0000-000000000004',
  NULL,
  'evergreen_direct_sale',
  'Evergreen — Venda Direta',
  'Funil evergreen simples para venda direta sem lançamento, com checkout e página de obrigado.',
  $json${
    "type": "evergreen",
    "has_main_offer": true,
    "has_workshop": false,
    "stages": [
      {"slug": "clicked_buy_main","label": "Clicou comprar","is_recurring": true,  "source_events": ["InitiateCheckout"]},
      {"slug": "purchased_main",  "label": "Comprou",       "is_recurring": false, "source_events": ["Purchase"]}
    ],
    "pages": [
      {"role": "sales",    "suggested_public_id": "vendas",   "event_config": {"canonical": ["PageView","ViewContent","InitiateCheckout"],"custom": []}},
      {"role": "checkout", "suggested_public_id": "checkout", "event_config": {"canonical": ["PageView","InitiateCheckout"],              "custom": []}},
      {"role": "thankyou", "suggested_public_id": "obrigado", "event_config": {"canonical": ["PageView","Purchase"],                     "custom": []}}
    ],
    "audiences": [
      {"slug": "abandono_checkout","name": "Abandono checkout","platform": "meta","query_template": {"stage_eq": "clicked_buy_main","stage_not": "purchased_main"}},
      {"slug": "compradores",      "name": "Compradores",       "platform": "meta","query_template": {"stage_eq": "purchased_main"}}
    ]
  }$json$::jsonb,
  true,
  'active'
)
ON CONFLICT (COALESCE(workspace_id::text, '_global'), slug) DO NOTHING;
