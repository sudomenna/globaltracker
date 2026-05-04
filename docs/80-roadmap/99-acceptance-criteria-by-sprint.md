# 99 — Acceptance criteria by sprint

> Critério de aceite global de cada sprint, marcado [x] quando passa.

## Sprint 0 — Foundations

- [ ] `pnpm install && pnpm typecheck && pnpm lint && pnpm test` rodando local sem erro.
- [ ] CI verde em PR de exemplo.
- [ ] Wrangler dev funciona em `apps/edge`.
- [ ] Supabase local com migration zero aplicada.
- [ ] AGENTS.md, CLAUDE.md, MEMORY.md, TESTING.md, README.md em pé.
- [ ] `.claude/agents/` com 9 subagents.

## Sprint 1 — Fundação de dados e contratos (Fase 1)

- [ ] Schema completo de todos 13 módulos em `packages/db/src/schema/`.
- [ ] Migrations versionadas, reversíveis, com índices declarados.
- [ ] RLS habilitado em 100% das tabelas de domínio (test confirma cross-workspace bloqueado).
- [ ] Endpoints `/v1/{config,events,lead}` + `/r/:slug` + admin SAR stub aceitam request, validam Zod, persistem em `raw_events`, retornam 202.
- [ ] Middleware: token público, CORS, rate-limit modo inicial, sanitize-logs (zero PII em logs verificado).
- [ ] Helpers: `pii.ts`, `idempotency.ts`, `lead-token.ts`, `cookies.ts`, `event-time-clamp.ts`, `replay-protection.ts` testados com cobertura ≥ 95%.
- [ ] Smoke E2E (`smoke-fase-1.spec.ts`) verde.
- [ ] Load test: `/v1/events` p95 < 50ms a 1000 req/s sustentados (RNF-001).
- [ ] Cobertura unit + integration: ≥ 80% em `packages/db/`, ≥ 70% em `apps/edge/src/lib/`.
- [ ] OQs do Sprint 1 fechadas (D2, D3, D4, D5 confirmadas; OQ-007 decidida).

## Sprint 2 — Runtime de tracking confiável (parte A da Fase 2)

- [ ] `tracker.js` build < 15 KB gz; instalação manual em LP de teste.
- [ ] Ingestion processor consome `raw_events`, normaliza, cria `events` + `lead_attribution` + `lead_stages` + `dispatch_jobs`.
- [ ] `lead_token` real emitido por `/v1/lead`; cookie `__ftk` setado e lido em retornos.
- [ ] FLOW-02 (capturar lead) E2E verde.
- [ ] FLOW-08 (merge convergente) E2E verde.
- [ ] Bot mitigation ativa (decisão de OQ-004).

## Sprint 3 — Meta CAPI v1 + webhooks (parte B da Fase 2)

- [ ] Meta CAPI dispatcher: lookup em leads, retry 429/5xx, DLQ, idempotency_key.
- [ ] Adapters Hotmart, Kiwify, Stripe com signature validation + mapper + fixtures.
- [ ] FLOW-03 (Meta CAPI dedup) E2E verde.
- [ ] FLOW-04 (Purchase via webhook) E2E verde.
- [ ] FLOW-07 (lead retornante) E2E verde — `__ftk` + Meta CAPI enriquecido.
- [ ] `dispatch_jobs` em estado `pending` por > 24h: 0 (em tests).
- [ ] Métricas operacionais (`dispatch_health_view`) populadas.

## Sprint 4 — Analytics + Google (parte A da Fase 3)

- [ ] Cron de cost ingestor diário; `ad_spend_daily.spend_cents_normalized` populado.
- [ ] FX rates fetch funcional.
- [ ] GA4 MP dispatcher operacional.
- [ ] Google Ads Conversion Upload com eligibility check.
- [ ] Enhanced Conversions com `order_id` + hash.
- [ ] Metabase views completas; FLOW-06 (dashboard) E2E verde.
- [ ] OQ-001 (FX provider) e OQ-003 (GA4 client_id) decididas.

## Sprint 5 — Audience + multi-touch (parte B da Fase 3)

- [ ] Audience Meta sync com snapshots materializados; diff entre snapshots.
- [ ] Customer Match Google com strategy condicional + auto-demote.
- [ ] `visitor_id` + retroactive linking.
- [ ] FLOW-05 (sync ICP) E2E verde.

## Sprint 6 — Control Plane (Fase 4)

- [ ] Marketer cria lançamento end-to-end via UI sem YAML.
- [ ] Page token rotation com janela de overlap.
- [ ] SAR via UI com double-confirm; FLOW-09 E2E verde.
- [ ] Audit log viewer com filtros.
- [ ] Multi-workspace operacional.
- [ ] RBAC plenamente operacional (todos 7 roles).
- [ ] 2FA obrigatório para owner/admin/privacy.

## Sprint 7 — Orchestrator (Fase 5)

- [ ] Operador deploya nova LP em < 5min via UI.
- [ ] Job de provisionamento de campanha gera estrutura + pausa para aprovação.
- [ ] Rollback de provisioning desfaz mudanças via API.

## Sprint 8 — IA + dashboard custom (Fase 6)

- [ ] LP gerada por IA passa em smoke E2E.
- [ ] Dashboard custom mostra métricas em tempo real (latência < 5s).

## Sprint 9 — Funil Configurável: UX Hardening (Fase 1)

- [ ] Form de launch expõe `type`, `objective`, `start_date`/`end_date`; valores persistem em `launches.config`.
- [ ] Form de page expõe seletor `role` com pré-população de `event_config` por role.
- [ ] Painel "Configuração de eventos" no page detail permite editar e salvar `event_config`.
- [ ] Launch detail refatorado em tabs (Overview, Pages, Eventos, Audiences, Performance); chip de role visível na tab Pages.
- [ ] `GET /v1/events?launch_id=` retorna eventos do launch com workspace isolation.

## Sprint 10 — Funil Configurável: Templates + Scaffolding (Fase 2)

- [ ] Migration `0029_funnel_templates` aplicada; tabela `funnel_templates` + colunas `launches.funnel_template_id` e `launches.funnel_blueprint` criadas.
- [ ] `GET /v1/funnel-templates` retorna os 4 presets globais.
- [ ] `POST /v1/launches` com `funnel_template_slug` scaffolda pages + audiences automaticamente.
- [ ] `raw-events-processor` usa `funnel_blueprint.stages` do launch (com fallback hardcoded se blueprint ausente).
- [ ] `source_event_filters: { funnel_role: 'workshop' }` distingue stage `purchased_workshop` de `purchased_main`.
- [ ] UI de edição de stages permite renomear label; processor usa o label atualizado.

## Sprint 11 — Funil Configurável: Webhook Guru Contextualizado (Fase 3)

- [ ] `guru-launch-resolver.ts` resolve launch_id + funnel_role por product_id (mapping explícito ou fallback last_attribution).
- [ ] Cada estratégia de resolução registrada em `audit_log`.
- [ ] `PATCH /v1/workspace/config` operacional com JSONB merge seguro.
- [ ] UI de mapeamento Guru no launch detail (tab Overview) permite cadastrar/editar product↔launch+funnel_role.
- [ ] Webhook Guru Purchase com product mapeado → stage correto (`purchased_workshop` ou `purchased_main`).
- [ ] Cenário E2E Funil B completo verde (sequência 8 eventos conforme `11-sprint-11-funil-webhook-guru.md §Verificação E2E`).

## Sprint 12 — Webhooks Hotmart, Kiwify, Stripe

- [ ] Adapter Hotmart: `X-Hotmart-Hottok` signature validation + mapper + fixtures.
- [ ] Adapter Kiwify: HMAC-SHA256 validation (`X-Kiwify-Signature`) + mapper + fixtures.
- [ ] Adapter Stripe: `constructEvent` raw body + tolerância 5min (ADR-022) + mapper + fixtures.
- [ ] FLOW-04 (Purchase via webhook) E2E verde para os três provedores.
- [ ] Smoke em produção com webhook test mode de cada provedor.

## Política

Sprint não é considerado completo até **todos** os critérios de aceite globais estarem [x]. OPERATOR (ou tech lead) marca após validação. ADR de exceção se algum item for adiado para sprint posterior.
