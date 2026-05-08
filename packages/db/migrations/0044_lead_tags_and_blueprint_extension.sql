-- ============================================================
-- 0044_lead_tags_and_blueprint_extension.sql
--
-- T-LEADS-VIEW-001 — Suporte de schema para feature "Leads tab no launch".
--
-- Três conceitos distintos no domínio:
--   - Stage  (lead_stages, já existe): progressão monotônica do lead num funil.
--   - Event  (events,      já existe): fato pontual com timestamp.
--   - Tag    (lead_tags,   NOVO):       atributo binário do lead, workspace-scoped, atemporal.
--
-- Eventos podem disparar simultaneamente: stage promotion + tag set
-- (ex.: `custom:wpp_joined` → stage `group_joined` + tag `joined_group`).
-- A correspondência evento→tag vive em `blueprint.tag_rules`.
--
-- BRs aplicáveis:
--   BR-IDENTITY:  lead_tags é workspace-scoped (RLS standard).
--   BR-AUDIT-001: set_by + set_at populados sempre.
--
-- INVs aplicáveis:
--   INV-LEAD-TAG-001: (workspace_id, lead_id, tag_name) único.
--   INV-FUNNEL-001:   slug único por (workspace_id ou _global) — preservado.
--   INV-FUNNEL-002:   is_system=true exige workspace_id IS NULL — preservado.
--
-- Idempotência: CREATE TABLE/INDEX usa IF NOT EXISTS; UPDATE com jsonb_set é
-- forma alvo final → re-run = noop.
-- ============================================================

-- ============================================================
-- 1. Table: lead_tags
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_tags (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor — BR-RBAC-002: app.current_workspace_id enforced by RLS.
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- ON DELETE CASCADE: tag desaparece se o lead for hard-deleted (SAR/erasure).
  lead_id      uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  -- Tag name (operator-defined; convenção em blueprint.tag_rules).
  tag_name     text        NOT NULL,

  set_at       timestamptz NOT NULL DEFAULT now(),

  -- Proveniência: 'system' | 'user:<uuid>' | 'integration:<name>' | 'event:<event_name>'.
  -- INV-LEAD-TAG-002: formato validado em service layer (não há check DB).
  set_by       text        NOT NULL,

  -- INV-LEAD-TAG-001: unicidade (workspace_id, lead_id, tag_name).
  CONSTRAINT uq_lead_tags_workspace_lead_tag
    UNIQUE (workspace_id, lead_id, tag_name)
);

-- idx_lead_tags_workspace_tag: lookup "todos os leads com tag X num workspace"
-- (caso de uso da Leads tab → filtro por coluna tag).
CREATE INDEX IF NOT EXISTS idx_lead_tags_workspace_tag
  ON lead_tags (workspace_id, tag_name);

-- idx_lead_tags_lead: lookup "todas as tags de um lead"
-- (caso de uso da timeline / detail view do lead).
CREATE INDEX IF NOT EXISTS idx_lead_tags_lead
  ON lead_tags (lead_id);

-- ============================================================
-- RLS: lead_tags — dual-mode (GUC + JWT-derived auth_workspace_id).
-- Padrão idêntico ao das demais tabelas workspace-scoped (ver migration 0028).
-- ============================================================
ALTER TABLE lead_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_tags_workspace_isolation ON lead_tags;
CREATE POLICY lead_tags_workspace_isolation ON lead_tags
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
-- 2. Blueprint extension — leads_view + tag_rules
--
-- Adicionados via jsonb_set (preserva keys existentes). Aplicado em:
--   (a) funnel_templates global (slug = 'lancamento_pago_workshop_com_main_offer',
--       workspace_id IS NULL).
--   (b) launches.funnel_blueprint dos launches que apontam para esse template
--       (filtro por funnel_template_id, não por keys do JSON — blueprint não tem
--       campos `name`/`version` — uniqueness é por slug do template).
--
-- stage_progression é construído dinamicamente a partir do próprio blueprint
-- (via jsonb_path_query_array), de forma que cada row use a sequência de stages
-- que ela própria contém — o template tem 10 stages (com `wpp_joined_vip_main`),
-- enquanto o launch `wkshop-cs-jun26` tem snapshot anterior com 9 stages.
--
-- Colunas do leads_view e tag_rules são padrão para o arquétipo
-- `lancamento_pago_workshop_com_main_offer` — funnel B Outsiders. Outros
-- templates ganharão suas próprias extensões em migrations subsequentes.
-- ============================================================

-- (a) Template global
UPDATE funnel_templates
   SET blueprint = jsonb_set(
         jsonb_set(
           blueprint,
           '{leads_view}',
           jsonb_build_object(
             'stage_progression',
             COALESCE(
               (SELECT jsonb_agg(s->>'slug' ORDER BY ord)
                  FROM jsonb_array_elements(blueprint->'stages') WITH ORDINALITY AS t(s, ord)),
               '[]'::jsonb
             ),
             'columns',
             $json$[
               {"key":"whatsapp_valid",   "label":"WhatsApp Válido",       "type":"tag",   "source":"whatsapp_valid"},
               {"key":"bait_purchased",   "label":"Comprou Bait Offer",    "type":"stage", "source":"purchased_workshop"},
               {"key":"group_joined",     "label":"Entrou Grupo",          "type":"any",   "sources":[{"type":"stage","name":"wpp_joined"},{"type":"event","name":"custom:wpp_joined"}]},
               {"key":"survey_responded", "label":"Respondeu Pesquisa",    "type":"event", "source":"custom:survey_responded"},
               {"key":"workshop_watched", "label":"Assistiu Workshop",     "type":"any",   "sources":[{"type":"stage","name":"watched_workshop"},{"type":"event","name":"custom:watched_workshop"}]}
             ]$json$::jsonb
           ),
           true
         ),
         '{tag_rules}',
         $json$[
           {"event":"custom:wpp_joined",       "tag":"joined_group"},
           {"event":"custom:watched_workshop", "tag":"watched_workshop"},
           {"event":"custom:survey_responded", "tag":"survey_responded"},
           {"event":"Purchase", "when":{"funnel_role":"workshop"},   "tag":"bait_purchased"},
           {"event":"Purchase", "when":{"funnel_role":"main_offer"}, "tag":"main_purchased"}
         ]$json$::jsonb,
         true
       ),
       updated_at = now()
 WHERE slug = 'lancamento_pago_workshop_com_main_offer'
   AND workspace_id IS NULL;

-- (b) Launches vivos (snapshots) que usam esse template.
-- Filtro por funnel_template_id — robusto contra blueprints que não carregam
-- name/version no JSON.
UPDATE launches l
   SET funnel_blueprint = jsonb_set(
         jsonb_set(
           l.funnel_blueprint,
           '{leads_view}',
           jsonb_build_object(
             'stage_progression',
             COALESCE(
               (SELECT jsonb_agg(s->>'slug' ORDER BY ord)
                  FROM jsonb_array_elements(l.funnel_blueprint->'stages') WITH ORDINALITY AS t(s, ord)),
               '[]'::jsonb
             ),
             'columns',
             $json$[
               {"key":"whatsapp_valid",   "label":"WhatsApp Válido",       "type":"tag",   "source":"whatsapp_valid"},
               {"key":"bait_purchased",   "label":"Comprou Bait Offer",    "type":"stage", "source":"purchased_workshop"},
               {"key":"group_joined",     "label":"Entrou Grupo",          "type":"any",   "sources":[{"type":"stage","name":"wpp_joined"},{"type":"event","name":"custom:wpp_joined"}]},
               {"key":"survey_responded", "label":"Respondeu Pesquisa",    "type":"event", "source":"custom:survey_responded"},
               {"key":"workshop_watched", "label":"Assistiu Workshop",     "type":"any",   "sources":[{"type":"stage","name":"watched_workshop"},{"type":"event","name":"custom:watched_workshop"}]}
             ]$json$::jsonb
           ),
           true
         ),
         '{tag_rules}',
         $json$[
           {"event":"custom:wpp_joined",       "tag":"joined_group"},
           {"event":"custom:watched_workshop", "tag":"watched_workshop"},
           {"event":"custom:survey_responded", "tag":"survey_responded"},
           {"event":"Purchase", "when":{"funnel_role":"workshop"},   "tag":"bait_purchased"},
           {"event":"Purchase", "when":{"funnel_role":"main_offer"}, "tag":"main_purchased"}
         ]$json$::jsonb,
         true
       ),
       updated_at = now()
 WHERE l.funnel_template_id IN (
         SELECT id FROM funnel_templates
          WHERE slug = 'lancamento_pago_workshop_com_main_offer'
            AND workspace_id IS NULL
       )
   AND l.funnel_blueprint IS NOT NULL;

-- Down (manual rollback):
-- UPDATE funnel_templates
--   SET blueprint = blueprint - 'leads_view' - 'tag_rules'
--   WHERE slug = 'lancamento_pago_workshop_com_main_offer' AND workspace_id IS NULL;
-- UPDATE launches
--   SET funnel_blueprint = funnel_blueprint - 'leads_view' - 'tag_rules'
--   WHERE funnel_template_id = 'a1000000-0000-0000-0000-000000000002';
-- DROP TABLE IF EXISTS lead_tags;
