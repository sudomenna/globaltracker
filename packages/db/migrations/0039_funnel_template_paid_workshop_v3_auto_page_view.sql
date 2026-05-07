-- ============================================================
-- 0039_funnel_template_paid_workshop_v3_auto_page_view.sql
--
-- Padroniza a flag `auto_page_view` no blueprint do template
-- `lancamento_pago_workshop_com_main_offer` (v3.2) e propaga para as
-- pages existentes que vieram desse template.
--
-- Contexto (descoberto 2026-05-07):
--   `pages.event_config.auto_page_view` controla se o tracker.js dispara
--   PageView automaticamente no init, ou se o snippet faz `F.page()` manual
--   após resolver identidade (ex: thankyou pages que recebem email/phone via
--   URL params do checkout).
--
--   Antes desta migration, o blueprint não definia `auto_page_view` em nenhuma
--   das 5 pages → todas eram criadas com a flag ausente (== false), o que
--   silenciava PageView no `workshop` (page de captura) — cliques e Lead
--   funcionavam mas PageView nunca era enviado a Meta CAPI / GA4.
--
-- Política canônica por role da page:
--   - role=sales      → auto_page_view: true   (usuário chega/está na page)
--   - role=webinar    → auto_page_view: true   (usuário já identificado)
--   - role=thankyou   → auto_page_view: false  (snippet identifica antes via URL)
--
-- Idempotência: UPDATE com forma alvo final. Re-run = noop.
--
-- ESCOPO desta migration:
--   1. UPDATE blueprint do template global (`workspace_id IS NULL`).
--   2. UPDATE event_config das pages existentes do launch `wkshop-cs-jun26`
--      (e quaisquer outros que tenham vindo desse template) — preserva
--      canonical/custom já presentes, só adiciona/atualiza `auto_page_view`.
--
-- Depende de: 0036_funnel_template_paid_workshop_v3_add_vip_main_stage.sql
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Update blueprint do template global
-- ----------------------------------------------------------------------------
UPDATE funnel_templates
   SET blueprint = $json${
    "type": "lancamento_pago",
    "has_main_offer": true,
    "has_workshop": true,
    "stages": [
      {"slug": "clicked_buy_workshop",  "label": "Clicou comprar workshop",            "is_recurring": true,  "source_events": ["custom:click_buy_workshop"]},
      {"slug": "lead_workshop",         "label": "Lead identificado (workshop)",       "is_recurring": false, "source_events": ["Lead"]},
      {"slug": "purchased_workshop",    "label": "Comprou workshop",                   "is_recurring": false, "source_events": ["Purchase"], "source_event_filters": {"funnel_role": "workshop"}},
      {"slug": "clicked_wpp_join",      "label": "Clicou entrar no grupo WhatsApp",    "is_recurring": true,  "source_events": ["custom:click_wpp_join"]},
      {"slug": "wpp_joined",            "label": "Entrou no grupo WhatsApp",           "is_recurring": false, "source_events": ["Contact"]},
      {"slug": "survey_responded",      "label": "Respondeu pesquisa",                 "is_recurring": false, "source_events": ["custom:survey_responded"]},
      {"slug": "watched_workshop",      "label": "Assistiu workshop",                  "is_recurring": false, "source_events": ["custom:watched_workshop"]},
      {"slug": "wpp_joined_vip_main",   "label": "Entrou no grupo VIP da oferta principal", "is_recurring": false, "source_events": ["custom:wpp_joined_vip_main"]},
      {"slug": "clicked_buy_main",      "label": "Clicou comprar oferta principal",    "is_recurring": true,  "source_events": ["custom:click_buy_main"]},
      {"slug": "purchased_main",        "label": "Comprou oferta principal",           "is_recurring": false, "source_events": ["Purchase"], "source_event_filters": {"funnel_role": "main_offer"}}
    ],
    "pages": [
      {"role": "sales",    "suggested_public_id": "workshop",           "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","Lead"],                   "custom": ["click_buy_workshop"],                "auto_page_view": true}},
      {"role": "thankyou", "suggested_public_id": "obrigado-workshop",  "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","Purchase","Contact"],     "custom": ["click_wpp_join","survey_responded"], "auto_page_view": false}},
      {"role": "webinar",  "suggested_public_id": "aula-workshop",      "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView"],                          "custom": ["watched_workshop"],                  "auto_page_view": true}},
      {"role": "sales",    "suggested_public_id": "oferta-principal",   "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","ViewContent"],            "custom": ["click_buy_main"],                    "auto_page_view": true}},
      {"role": "thankyou", "suggested_public_id": "obrigado-principal", "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","Purchase"],               "custom": [],                                    "auto_page_view": false}}
    ],
    "audiences": [
      {"slug": "compradores_workshop_aquecimento",       "name": "Compradores workshop — aquecimento",                "platform": "meta", "query_template": {"stage_eq":  "purchased_workshop",   "stage_not": "purchased_main"}},
      {"slug": "respondeu_pesquisa_sem_comprar_main",    "name": "Respondeu pesquisa, sem comprar main",               "platform": "meta", "query_template": {"stage_eq":  "survey_responded",     "stage_not": "purchased_main"}},
      {"slug": "engajados_workshop",                     "name": "Engajados no workshop",                              "platform": "meta", "query_template": {"stage_gte": "watched_workshop"}},
      {"slug": "interessados_vip_main_sem_compra",       "name": "Interessados VIP main offer, sem compra",            "platform": "meta", "query_template": {"stage_eq":  "wpp_joined_vip_main",  "stage_not": "purchased_main"}},
      {"slug": "abandono_main_offer",                    "name": "Abandono oferta principal",                          "platform": "meta", "query_template": {"stage_eq":  "clicked_buy_main",     "stage_not": "purchased_main"}},
      {"slug": "compradores_main",                       "name": "Compradores oferta principal",                       "platform": "meta", "query_template": {"stage_eq":  "purchased_main"}},
      {"slug": "nao_compradores_workshop_engajados",     "name": "Engajados workshop, sem compra",                     "platform": "meta", "query_template": {"stage_gte": "watched_workshop",     "stage_not": "purchased_main"}}
    ]
  }$json$::jsonb,
       updated_at = now()
 WHERE slug = 'lancamento_pago_workshop_com_main_offer'
   AND workspace_id IS NULL;

-- ----------------------------------------------------------------------------
-- 2. Propaga auto_page_view para pages existentes que vieram do template.
-- jsonb_set é safe contra rows double-stringified — primeiro normaliza com
-- defensive cast (#>> '{}')::jsonb caso o valor seja stored como string.
-- ----------------------------------------------------------------------------

-- 2a. Pages role=sales/webinar → auto_page_view: true
UPDATE pages
   SET event_config = jsonb_set(
         CASE
           WHEN jsonb_typeof(event_config) = 'string'
             THEN (event_config #>> '{}')::jsonb
           ELSE event_config
         END,
         '{auto_page_view}',
         'true'::jsonb
       ),
       updated_at = now()
 WHERE public_id IN ('workshop', 'oferta-principal', 'aula-workshop');

-- 2b. Pages role=thankyou → auto_page_view: false
UPDATE pages
   SET event_config = jsonb_set(
         CASE
           WHEN jsonb_typeof(event_config) = 'string'
             THEN (event_config #>> '{}')::jsonb
           ELSE event_config
         END,
         '{auto_page_view}',
         'false'::jsonb
       ),
       updated_at = now()
 WHERE public_id IN ('obrigado-workshop', 'obrigado-principal');

COMMIT;
