-- Migration: 0034_funnel_template_paid_workshop_v3
-- T-FUNIL-048 (Sprint 12 — Onda 3 continuação) — Template v3 do
-- `lancamento_pago_workshop_com_main_offer`.
--
-- Mudanças vs v2 (0031 + 0032):
--   - Adiciona stage `clicked_wpp_join` (custom:click_wpp_join) após
--     `purchased_workshop`. Captura o clique do botão WhatsApp na page
--     `obrigado-workshop` (intent — separado do `wpp_joined` que vira o evento
--     real de adesão ao grupo).
--   - `wpp_joined` (Contact event) MANTIDO — trigger source evolui para webhook
--     SendFlow inbound (T-13-011, Sprint 13). Por enquanto continua aceitando
--     evento canônico Contact (page-side ou webhook).
--   - `survey_responded` MANTIDO como placeholder paralelo a `wpp_joined`.
--     Form de pesquisa virá em T-13-012 (Sprint 13). Audience
--     `respondeu_pesquisa_sem_comprar_main` permanece (mesmo que sem dados ainda).
--   - Page `obrigado-workshop`: event_config.custom passa de `[survey_responded]`
--     para `[click_wpp_join, survey_responded]`. Canonical mantém `Contact`
--     (será populado via webhook SendFlow no futuro).
--
-- Stages v3 (9 total, ordem):
--   1. clicked_buy_workshop
--   2. lead_workshop
--   3. purchased_workshop
--   4. clicked_wpp_join     ← NOVO
--   5. wpp_joined           (trigger via webhook SendFlow — Sprint 13)
--   6. survey_responded     (placeholder — Sprint 13)
--   7. watched_workshop
--   8. clicked_buy_main
--   9. purchased_main
--
-- Decisões D1-D4 desta sessão (2026-05-05): registradas em ADR-026 addendum
-- e em docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md.
--
-- BRs aplicáveis:
--   BR-EVENT-001: custom events com prefixo `custom:` exigem matching exato
--                 (raw-events-processor.ts). source_events preserva o prefixo.
--
-- INVs aplicáveis:
--   INV-FUNNEL-001: slug único por (workspace_id ou _global) — UPDATE preserva.
--   INV-FUNNEL-002: is_system=true exige workspace_id IS NULL — UPDATE preserva.
--
-- Idempotência: UPDATE ... SET com forma alvo final. Re-run = noop.
--
-- ESCOPO DELIBERADAMENTE LIMITADO: migration toca SÓ a row global de
-- funnel_templates. Não mexe em launches.funnel_blueprint, pages, page_tokens
-- ou audiences do launch wkshop-cs-jun26 — reset desse launch é feito por
-- script separado (packages/db/scripts/reset_launch_wkshop_cs_jun26.sql).
-- Razão: migrations devem ser idempotentes e safe across environments;
-- reset destrutivo de launch específico não cabe em history append-only.

UPDATE funnel_templates
   SET blueprint = $json${
    "type": "lancamento_pago",
    "has_main_offer": true,
    "has_workshop": true,
    "stages": [
      {"slug": "clicked_buy_workshop", "label": "Clicou comprar workshop",            "is_recurring": true,  "source_events": ["custom:click_buy_workshop"]},
      {"slug": "lead_workshop",        "label": "Lead identificado (workshop)",       "is_recurring": false, "source_events": ["Lead"]},
      {"slug": "purchased_workshop",   "label": "Comprou workshop",                   "is_recurring": false, "source_events": ["Purchase"], "source_event_filters": {"funnel_role": "workshop"}},
      {"slug": "clicked_wpp_join",     "label": "Clicou entrar no grupo WhatsApp",    "is_recurring": true,  "source_events": ["custom:click_wpp_join"]},
      {"slug": "wpp_joined",           "label": "Entrou no WhatsApp",                 "is_recurring": false, "source_events": ["Contact"]},
      {"slug": "survey_responded",     "label": "Respondeu pesquisa",                 "is_recurring": false, "source_events": ["custom:survey_responded"]},
      {"slug": "watched_workshop",     "label": "Assistiu workshop",                  "is_recurring": false, "source_events": ["custom:watched_workshop"]},
      {"slug": "clicked_buy_main",     "label": "Clicou comprar oferta principal",    "is_recurring": true,  "source_events": ["custom:click_buy_main"]},
      {"slug": "purchased_main",       "label": "Comprou oferta principal",           "is_recurring": false, "source_events": ["Purchase"], "source_event_filters": {"funnel_role": "main_offer"}}
    ],
    "pages": [
      {"role": "sales",    "suggested_public_id": "workshop",           "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","Lead"],                   "custom": ["click_buy_workshop"]}},
      {"role": "thankyou", "suggested_public_id": "obrigado-workshop",  "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","Purchase","Contact"],     "custom": ["click_wpp_join","survey_responded"]}},
      {"role": "webinar",  "suggested_public_id": "aula-workshop",      "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView"],                          "custom": ["watched_workshop"]}},
      {"role": "sales",    "suggested_public_id": "oferta-principal",   "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","ViewContent"],            "custom": ["click_buy_main"]}},
      {"role": "thankyou", "suggested_public_id": "obrigado-principal", "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","Purchase"],               "custom": []}}
    ],
    "audiences": [
      {"slug": "compradores_workshop_aquecimento",     "name": "Compradores workshop — aquecimento", "platform": "meta", "query_template": {"stage_eq":  "purchased_workshop", "stage_not": "purchased_main"}},
      {"slug": "respondeu_pesquisa_sem_comprar_main",  "name": "Respondeu pesquisa, sem comprar main","platform": "meta", "query_template": {"stage_eq":  "survey_responded",   "stage_not": "purchased_main"}},
      {"slug": "engajados_workshop",                   "name": "Engajados no workshop",               "platform": "meta", "query_template": {"stage_gte": "watched_workshop"}},
      {"slug": "abandono_main_offer",                  "name": "Abandono oferta principal",           "platform": "meta", "query_template": {"stage_eq":  "clicked_buy_main",   "stage_not": "purchased_main"}},
      {"slug": "compradores_main",                     "name": "Compradores oferta principal",        "platform": "meta", "query_template": {"stage_eq":  "purchased_main"}},
      {"slug": "nao_compradores_workshop_engajados",   "name": "Engajados workshop, sem compra",      "platform": "meta", "query_template": {"stage_gte": "watched_workshop",   "stage_not": "purchased_main"}}
    ]
  }$json$::jsonb,
       updated_at = now()
 WHERE slug = 'lancamento_pago_workshop_com_main_offer'
   AND workspace_id IS NULL;
