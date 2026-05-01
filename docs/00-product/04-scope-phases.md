# 04 — Escopo e fases

Derivado da Seção 28 do [`planejamento.md` v3.0](../../planejamento.md). Cada fase é um sprint operacional em [`80-roadmap/`](../80-roadmap/) e tem critérios de aceite verificáveis.

## Fase 1 — Fundação de dados e contratos

**Duração estimada:** 2–3 semanas
**Sprint:** [`01-sprint-1-fundacao-dados-contratos.md`](../80-roadmap/01-sprint-1-fundacao-dados-contratos.md) (a gerar na Fase 7 da geração de docs).

### Entregável

- Monorepo inicial com `apps/edge`, `packages/db`, `packages/shared`.
- Migrations completas (todas as tabelas do `planejamento.md` Seção 11, incluindo `lead_aliases`, `lead_merges`, `lead_tokens`, `lead_survey_responses`, `lead_icp_scores`, `webinar_attendance`, `audience_snapshots`, `audience_snapshot_members`, `audit_log`, `raw_events`).
- Worker base com Hono, rotas versionadas em modo fast accept (`/v1/config`, `/v1/events`, `/v1/lead`, `/r/:slug` retornam 202 via `raw_events`).
- Middleware de token público / CORS / rate-limit em modo inicial.
- Utilitários de PII (`pii.ts`), idempotência (`idempotency.ts`), lead token stub (`lead-token.ts`), cookies (`cookies.ts`), event_time clamp (`event-time-clamp.ts`), logging sanitizado (`sanitize-logs.ts`).
- Endpoint admin stub `DELETE /v1/admin/leads/:lead_id` (retorna 202 + cria job placeholder; lógica de anonimização vem na Fase 4).
- Ingestion processor stub (recebe da queue, marca `raw_events.processed_at`; lógica de normalização é minimal — apenas insere em `events` sem enriquecimento, completado na Fase 2).
- Contratos Zod compartilhados em `packages/shared/src/contracts/`.
- CI rodando typecheck + lint + test.
- Smoke test do Worker (request real + assertion de 202).

### Critérios de aceite

- [ ] IDs internos (UUID) e públicos (slug/public_id) separados em todas tabelas.
- [ ] Endpoints versionados sob `/v1` retornando 202 via `raw_events`.
- [ ] Migrations com índices declarados, especialmente `(workspace_id, identifier_type, identifier_hash) where status='active'` em `lead_aliases`.
- [ ] `RNF-001` validado: `/v1/events` p95 < 50ms em teste de carga.
- [ ] Test suite confirma que payload com PII em campos não-canônicos é rejeitado por Zod.
- [ ] Logger estruturado redacta automaticamente `email`, `phone`, `name`, `ip`.
- [ ] Modelo "fast accept" comprovado: kill -9 do worker durante request não gera evento aceito.

## Fase 2 — Runtime de tracking confiável

**Duração estimada:** 3–4 semanas
**Sprints:** `02-sprint-2-runtime-tracking.md` + `03-sprint-3-meta-capi-webhooks.md`.

### Entregável

- Tracker.js v0 (apps/tracker) com:
  - Captura de UTMs, `fbclid`, `gclid`, `gbraid`, `wbraid`, `fbc`, `fbp`, `_gcl_au`, `_ga`, referrer sanitizado.
  - localStorage de attribution params para replay no `/v1/lead`.
  - Cookies `__fvid` (anônimo, reservado) e `__ftk` (lead_token, set pelo backend).
  - 3 políticas de Pixel: `server_only`, `browser_and_server_managed`, `coexist_with_existing_pixel`.
  - Bundle < 15 KB gzipped.
- `/v1/config` completo com cache KV (60s) e ETag.
- `/v1/events` completo com clamp de `event_time`, validação de `lead_token` HMAC, replay protection (TTL 7 dias em KV).
- `/v1/lead` completo: cria/atualiza lead via `lead_aliases` + `lead_merges`, emite `lead_token`, setta cookie `__ftk`.
- Redirector `/r/:slug` com log async de clique.
- Ingestion processor funcional (raw_events → events normalizado com lead resolution e merge).
- Meta CAPI dispatcher v1 com:
  - Lookup em `leads` para enriquecimento server-side.
  - Idempotency key canonicalizada (ADR-013).
  - Retry com backoff + DLQ.
- Webhooks Hotmart, Kiwify, Stripe (com `constructEvent` + tolerância 5min — ADR-022).
- Bot mitigation em `/v1/lead`: honeypot + tempo mínimo + (Turnstile decisão pendente — OQ-004).
- Smoke E2E de FLOW-01, FLOW-02, FLOW-03, FLOW-04, FLOW-07.

### Critérios de aceite

- [ ] Lead retornante (FLOW-07) reconhecido via `__ftk` e Meta CAPI recebe `user_data` enriquecido sem PII no browser.
- [ ] Webhook Stripe duplicado (mesmo `event.id` enviado 3×) gera apenas 1 evento (idempotência via `event_id` derivado).
- [ ] Lead com email-only + Lead com phone-only convergem em merge canônico quando 3º registro tem email+phone (FLOW-08).
- [ ] Meta CAPI retorna 200 para 95%+ dos eventos elegíveis em fixtures de teste.
- [ ] `dispatch_jobs` em estado `pending` por > 24h: 0.

## Fase 3 — Analytics, integrações pagas e multi-touch

**Duração estimada:** 3 semanas
**Sprints:** `04-sprint-4-analytics-google.md` + `05-sprint-5-audience-multitouch.md`.

### Entregável

- Cost ingestor diário Meta + Google Ads com:
  - `granularity` em `ad_spend_daily`.
  - Normalização cambial (`spend_cents_normalized`, `fx_rate`, `fx_source`).
  - Reprocessamento retroativo quando taxa for revisada.
- GA4 Measurement Protocol dispatcher com estratégia de `client_id`:
  - Lê `_ga` cookie quando presente.
  - Mintera próprio derivado de `__fvid` quando ausente (OQ-003 a fechar).
- Google Ads Conversion Upload com pré-requisitos validados (gclid/gbraid/wbraid + conversion_action mapeado).
- Enhanced Conversions for Web com `order_id` + dados hashados.
- Audience Meta v1 com `audience_snapshots` + `audience_snapshot_members` materializados; diff entre snapshots T-1 e T.
- Customer Match Google com strategy condicional: `google_data_manager` (Data Manager API) / `google_ads_api_allowlisted` / `disabled_not_eligible`.
- Tracker v1 com `visitor_id` (`__fvid`) + retroactive linking entre PageViews anônimos e Lead cadastrado.
- Multi-touch base (all-touch armazenado em eventos; agregação ainda não no MVP).
- Metabase com 6 views/rollups: `fact_funnel_events`, `daily_funnel_rollup`, `ad_performance_rollup` (usa `spend_cents_normalized`), `audience_health_view`, `dispatch_health_view`, `audit_log_view`.

### Critérios de aceite

- [ ] Dashboard CPL/CPA por anúncio mostra valores não-nulos em campanhas com tracking ativo > 7 dias.
- [ ] ROAS calculado com normalização cambial — workspace BRL com conta em USD mostra ROAS coerente.
- [ ] Audience com `disabled_not_eligible` nunca chama Google API.
- [ ] Lead que entrou anônimo, viu 3 PageViews, depois cadastrou: `lead_attribution.first_touch` aponta para a primeira visita (retroactive linking).

## Fase 4 — Control Plane (UI operacional)

**Duração estimada:** 3 semanas
**Sprint:** `06-sprint-6-control-plane.md`.

### Entregável

- Next.js 15 App Router em `apps/control-plane`.
- Telas SCREEN-* (a especificar em `70-ux/`):
  - Lista e detalhe de lançamentos.
  - Registro de página + emissão/rotação de page_token (ADR-023).
  - Gerador de links curtos com macros.
  - Builder de audiences (DSL validada, não SQL livre).
  - UI de SAR/erasure com double-confirm (AUTHZ-003).
  - Audit log viewer.
  - Dashboard nativo (alternativa/complemento ao Metabase).
- RBAC plenamente operacional (todos os 7 roles + AUTHZ-001..012).
- Onboarding multi-workspace (até então MVP rodava 1 workspace).

### Critérios de aceite

- [ ] Marketer cria lançamento end-to-end via UI sem YAML manual.
- [ ] SAR via UI executa em < 60s para lead com 100k eventos.
- [ ] Page token rotation respeita janela de overlap (ADR-023) e mostra métrica `legacy_token_in_use`.
- [ ] Validações impedem setup inseguro (Pixel policy `coexist` sem `event_id` mapping → bloqueia ou alerta).

## Fase 5 — Orchestrator e automação

**Duração estimada:** 4+ semanas
**Sprint:** `07-sprint-7-orchestrator.md`.

### Entregável

- Trigger.dev jobs com:
  - LP templates (Astro) deployáveis para Cloudflare Pages com tracker pré-instalado.
  - Setup de tracking automatizado (provisiona Meta Pixel + Google Ads conversion actions via API com aprovação humana).
  - Provisionamento de campanhas (cria estrutura inicial Meta/Google a partir do YAML do lançamento).
- Workflows com aprovação humana, rollback explícito, audit log de cada etapa.
- Integração com Control Plane (Fase 4) — operador dispara jobs via UI.

### Critérios de aceite

- [ ] Operador deploya nova LP em < 5min com tracker pré-instalado.
- [ ] Job de provisionamento de campanha gera estrutura Meta/Google e pausa para aprovação.
- [ ] Rollback de provisioning desfaz mudanças via API das plataformas.

## Fase 6 — IA e dashboard custom

**Duração estimada:** 4+ semanas
**Sprint:** `08-sprint-8-ai-dashboard.md`.

### Entregável

- Copy/LP Generator com IA (Claude API ou similar) para gerar variações de headline, CTA, copy.
- Dashboard customizado em Next.js com realtime via Supabase Realtime — alternativa ao Metabase para casos de uso operacionais (alertas, anomalias).

### Critérios de aceite

- [ ] LP gerada por IA passa em smoke test E2E.
- [ ] Dashboard custom mostra métricas em tempo real com latência < 5s.

---

## Fora de escopo total

| Item | Razão |
|---|---|
| Modelagem estatística de atribuição (MMM, multi-touch incremental, Markov) | Requer escala de dados maior que MVP justifica; produto separado se for prioridade. |
| Otimização automática de budget Meta/Google | Risco operacional alto; foco do GlobalTracker é tracking + dispatch, não otimização. |
| Criação autônoma irrestrita de campanhas sem aprovação humana | Trade-off de risco vs autonomia favorece aprovação humana sempre. |
| Enriquecimento de dados por terceiros (Clearbit, FullContact) | Adiciona dependência paga + risco LGPD; cliente pode adicionar via custom adapter. |
| Suporte universal a qualquer plataforma de checkout sem adapter homologado | Cada plataforma tem nuances de webhook signature, payload, idempotency; adapter genérico vira buggy. Adicionar plataforma nova é projeto explícito. |
| BI/relatórios financeiros (P&L, faturamento) | Domínio diferente; integração via export de dados é viável mas relatórios financeiros não são responsabilidade do GlobalTracker. |
| CRM completo | GlobalTracker tem dados de lead mas não substitui CRM (HubSpot/RD Station). Integração via webhook out é possível como evolução. |

## Política de mudança de escopo

Mover item de "fora de escopo" para escopo exige:
1. ADR explicando justificativa.
2. Atualização desta página.
3. Decisão de qual fase recebe (e qual é deslocada).

Sem ADR, item permanece fora de escopo independente de quem peça.
