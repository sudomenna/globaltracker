-- ============================================================
-- 0036_funnel_template_paid_workshop_v3_add_vip_main_stage.sql
--
-- T-13-011 (SendFlow webhook inbound) — adiciona stage `wpp_joined_vip_main`
-- ao template `lancamento_pago_workshop_com_main_offer` (v3.1).
--
-- Contexto:
-- O lançamento real do funil B (decisão Tiago 2026-05-05) usa DOIS grupos
-- WhatsApp distintos via SendFlow, ambos parte do mesmo `wkshop-cs-jun26`:
--   1. Grupo dos COMPRADORES do workshop (post-purchase) — stage `wpp_joined`
--      (já existente, source_event=`Contact`).
--   2. Grupo VIP dos INTERESSADOS na oferta principal (post-pitch, pre-buy,
--      sinal de alta intenção) — stage NOVO `wpp_joined_vip_main`,
--      source_event=`custom:wpp_joined_vip_main`.
--
-- Posição no funil: entre `watched_workshop` (assistiu o pitch) e
-- `clicked_buy_main` (clicou comprar a oferta principal). Audience nova
-- `interessados_vip_main_sem_compra` cria segmento de remarketing quente.
--
-- Origem do evento custom: o adapter SendFlow (`apps/edge/src/routes/webhooks/
-- sendflow.ts`) consulta `workspaces.config.sendflow.campaign_map` e
-- decide qual event_name emitir:
--   campaign_id A (grupo workshop)    → event_name = "Contact"
--   campaign_id B (grupo VIP main)    → event_name = "custom:wpp_joined_vip_main"
--
-- Stages v3.1 (10 total, ordem):
--   1. clicked_buy_workshop
--   2. lead_workshop
--   3. purchased_workshop
--   4. clicked_wpp_join
--   5. wpp_joined            (Contact — grupo compradores via SendFlow)
--   6. survey_responded
--   7. watched_workshop
--   8. wpp_joined_vip_main   ← NOVO (custom event — grupo VIP main via SendFlow)
--   9. clicked_buy_main
--  10. purchased_main
--
-- BRs aplicáveis:
--   BR-EVENT-001: custom events com prefixo `custom:` exigem matching exato.
--
-- INVs:
--   INV-FUNNEL-001: slug único por (workspace_id ou _global) — UPDATE preserva.
--   INV-FUNNEL-002: is_system=true exige workspace_id IS NULL — UPDATE preserva.
--
-- Idempotência: UPDATE com forma alvo final. Re-run = noop.
--
-- ESCOPO: toca SOMENTE a row global de `funnel_templates`. Launch
-- `wkshop-cs-jun26` precisa ter o blueprint atualizado separadamente (script
-- operacional ou via CP). Migration não mexe em launches específicos.
-- ============================================================

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
      {"role": "sales",    "suggested_public_id": "workshop",           "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","Lead"],                   "custom": ["click_buy_workshop"]}},
      {"role": "thankyou", "suggested_public_id": "obrigado-workshop",  "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","Purchase","Contact"],     "custom": ["click_wpp_join","survey_responded"]}},
      {"role": "webinar",  "suggested_public_id": "aula-workshop",      "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView"],                          "custom": ["watched_workshop"]}},
      {"role": "sales",    "suggested_public_id": "oferta-principal",   "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","ViewContent"],            "custom": ["click_buy_main"]}},
      {"role": "thankyou", "suggested_public_id": "obrigado-principal", "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","Purchase"],               "custom": []}}
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
