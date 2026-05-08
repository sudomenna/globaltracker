# 02 — ID Registry

Registro vivo de **todos** os IDs alocados. Antes de criar novo ID, consulte aqui para evitar duplicação.

> **Status do registro:** inicial (Fase 1 do rollout de docs). Será expandido nas Fases 2–8 da geração de docs (módulos, contratos, BRs, flows, T-IDs).

## OBJ-* (Objetivos de produto)

Definidos em `00-product/01-brief.md` (a gerar na Fase 2).

| ID | Nome curto | Status |
|---|---|---|
| OBJ-001 | (a definir) | planned |

## PERSONA-*

Definidos em `00-product/03-personas-rbac-matrix.md` (Fase 2).

| ID | Nome | Status |
|---|---|---|
| PERSONA-MARKETER | Profissional de marketing | planned |
| PERSONA-OPERATOR | Dev/operador interno | planned |
| PERSONA-LEAD | Visitante/lead capturado | planned |
| PERSONA-PRIVACY-OFFICER | Operador de privacidade (SAR) | planned |

## ROLE-*

| ID | Nome | Status |
|---|---|---|
| ROLE-OWNER | Workspace owner | planned |
| ROLE-ADMIN | Admin do workspace | planned |
| ROLE-MARKETER | Marketing user | planned |
| ROLE-OPERATOR | DevOps interno | planned |
| ROLE-PRIVACY | Privacy/compliance officer | planned |
| ROLE-VIEWER | Read-only | planned |
| ROLE-API_KEY | Server-to-server (admin operations) | planned |

## MOD-* (Módulos)

Definidos em `20-domain/` (Fase 3 da geração de docs).

| ID | Nome | Tipo | Status |
|---|---|---|---|
| MOD-WORKSPACE | Workspace e configuração de tenant | Core | planned |
| MOD-LAUNCH | Lançamentos | Core | planned |
| MOD-PAGE | Páginas e page tokens | Core | planned |
| MOD-IDENTITY | Leads, aliases, merges, consents, lead tokens, PII | Core | planned |
| MOD-EVENT | Eventos, raw_events, ingestão | Core | planned |
| MOD-FUNNEL | Lead stages | Core | planned |
| MOD-ATTRIBUTION | Links, link_clicks, lead_attribution, redirector | Core | planned |
| MOD-DISPATCH | Dispatch jobs/attempts | Core | planned |
| MOD-AUDIENCE | Audiences, snapshots, sync jobs | Core | planned |
| MOD-COST | ad_spend_daily, FX | Supporting | planned |
| MOD-ENGAGEMENT | Survey, ICP, webinar | Supporting | planned |
| MOD-AUDIT | audit_log (cross-cutting) | Supporting | planned |
| MOD-TRACKER | tracker.js (front-end) | Core | planned |
| MOD-PRODUCT | Catálogo de produtos + lifecycle promote + launch_products | Supporting | active (Sprint 16) |

## BR-* (Business Rules)

Definidas em `50-business-rules/` (Fase 5).

| Domínio | Quantidade prevista | Status |
|---|---:|---|
| BR-IDENTITY | 8 (001–006, 008 + 007 derivado) | active |
| BR-PRIVACY | ~5 | planned |
| BR-CONSENT | ~4 | planned |
| BR-EVENT | ~6 | planned |
| BR-DISPATCH | ~5 | planned |
| BR-ATTRIBUTION | ~3 | planned |
| BR-AUDIENCE | ~4 | planned |
| BR-COST | ~3 | planned |
| BR-WEBHOOK | ~4 | planned |
| BR-RBAC | ~5 | planned |
| BR-AUDIT | ~3 | planned |
| BR-PRODUCT | 3 | active (Sprint 16) |

## CONTRACT-*

Definidos em `30-contracts/` (Fase 4).

| ID | Tipo | Status |
|---|---|---|
| CONTRACT-api-config-v1 | API endpoint | planned |
| CONTRACT-api-events-v1 | API endpoint | planned |
| CONTRACT-api-lead-v1 | API endpoint | planned |
| CONTRACT-api-redirect-v1 | API endpoint | planned |
| CONTRACT-api-webhooks-v1 | API endpoint | planned |
| CONTRACT-api-admin-leads-erase-v1 | API endpoint (SAR) | planned |
| CONTRACT-event-pageview-v1 | Tracker event schema | planned |
| CONTRACT-event-lead-v1 | Tracker event schema | planned |
| CONTRACT-event-purchase-v1 | Tracker event schema | planned |
| CONTRACT-lead-token-v1 | HMAC token format | planned |
| CONTRACT-api-products-list-v1 | API endpoint (Sprint 16) | active |
| CONTRACT-api-products-create-v1 | API endpoint (Sprint 16) | active |
| CONTRACT-api-products-patch-v1 | API endpoint (Sprint 16) | active |
| CONTRACT-api-launch-products-list-v1 | API endpoint (Sprint 16) | active |
| CONTRACT-api-launch-products-upsert-v1 | API endpoint (Sprint 16) | active |
| CONTRACT-api-launch-leads-list-v1 | API endpoint (Sprint 16, T-LEADS-VIEW-002) | active |
| CONTRACT-api-launch-recovery-list-v1 | API endpoint (Sprint 14, T-RECOVERY-004) | active |

## TE-* (Timeline events / domain events)

Definidos em `30-contracts/03-timeline-event-catalog.md` (Fase 4).

| ID | Status |
|---|---|
| TE-LEAD-CREATED | planned |
| TE-LEAD-MERGED | planned |
| TE-LEAD-ERASED | planned |
| TE-EVENT-INGESTED | planned |
| TE-DISPATCH-SUCCEEDED | planned |
| TE-DISPATCH-FAILED | planned |
| TE-AUDIENCE-SYNCED | planned |
| TE-PAGE-TOKEN-ROTATED | planned |
| TE-PURCHASE-RECORDED | planned |

## FLOW-*

Derivados de UC-001..009 do `planejamento.md` v3.0 (Fase 6 da geração de docs).

| ID | Nome | Status |
|---|---|---|
| FLOW-01 | Registrar LP externa e instalar tracking | planned |
| FLOW-02 | Capturar lead e atribuir origem | planned |
| FLOW-03 | Enviar Lead para Meta CAPI com deduplicação | planned |
| FLOW-04 | Registrar Purchase via webhook | planned |
| FLOW-05 | Sincronizar público ICP | planned |
| FLOW-06 | Dashboard de performance | planned |
| FLOW-07 | Lead retornante dispara InitiateCheckout | planned |
| FLOW-08 | Merge de leads convergentes | planned |
| FLOW-09 | Erasure por SAR | planned |

## ADR-*

Em `90-meta/04-decision-log.md` (este arquivo + decision log são complementares).

| ID | Decisão | Status |
|---|---|---|
| ADR-001 | Stack canônica (Cloudflare Workers + Hono + Postgres/Supabase + Drizzle + CF Queues + CF KV; Trigger.dev só Fase 5) | aceito |
| ADR-002 | Multi-tenant via `workspace_id` em todas as tabelas | aceito |
| ADR-003 | IDs duplos: UUID interno + `public_id` externo por entidade exposta | aceito |
| ADR-004 | Modelo "fast accept": Edge → `raw_events` → ingestion processor async → DB canônico | aceito |
| ADR-005 | Identidade de lead via `lead_aliases` + `lead_merges` (substitui unique constraints em `leads`) | aceito |
| ADR-006 | Reidentificação de retornantes via cookie `__ftk` + `lead_token` HMAC stateless (Fase 2) | aceito |
| ADR-007 | `visitor_id` adiado para Fase 3; MVP usa localStorage client-side para first-touch | aceito |
| ADR-008 | Trigger.dev só na Fase 5; MVP usa CF Cron + CF Queues | aceito |
| ADR-009 | PII: hash + AES-256-GCM com `pii_key_version` por registro + HKDF por workspace | aceito |
| ADR-010 | Consent como entidade própria com 5 finalidades (analytics, marketing, ad_user_data, ad_personalization, customer_match) | aceito |
| ADR-011 | Política de Pixel por página: `server_only` / `browser_and_server_managed` / `coexist_with_existing_pixel` | aceito |
| ADR-012 | Customer Match Google: estratégia condicional (`google_data_manager` default; `google_ads_api_allowlisted` opcional; `disabled_not_eligible`) | aceito |
| ADR-013 | `idempotency_key = sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)` | aceito |
| ADR-014 | Retenção e SAR explícitos: events 13m, dispatch_attempts 90d, logs 30d, raw_events 7d, audit_log 7y, PII enc até erasure | aceito |
| ADR-015 | Atribuição first-touch por `(lead_id, launch_id)`, não global por workspace | aceito |
| ADR-016 | TypeScript estrito (`strict: true`, `noUncheckedIndexedAccess: true`); Zod em todas fronteiras HTTP/webhooks/filas | aceito |
| ADR-017 | Conventional Commits em inglês; nomes em inglês; UI/copy em português | aceito |
| ADR-018 | Metabase consulta views/rollups, não tabelas quentes diretamente | aceito |
| ADR-019 | Webhook `event_id = sha256(platform || ':' || platform_event_id)[:32]` para idempotência de retry | aceito |
| ADR-020 | Clamp de `event_time` no Edge quando `abs(event_time - received_at) > EVENT_TIME_CLAMP_WINDOW_SEC` (default 300s) | aceito |
| ADR-021 | Replay protection com TTL de 7 dias alinhado com janela CAPI; purge incremental | aceito |
| ADR-022 | Stripe webhook signature: `constructEvent` + tolerância 5min + comparação tempo-constante | aceito |
| ADR-023 | Page token rotation com janela de overlap configurável (default 14 dias); status `active`/`rotating`/`revoked` | aceito |
| ADR-024 | Cloudflare Turnstile como camada principal de bot mitigation em `/v1/lead`; honeypot como camada complementar futura | aceito |
| ADR-025 | dispatch-replay: criar novo job filho (Opção A) | aceito |
| ADR-026 | Realinhamento template `lancamento_pago_workshop_com_main_offer` ao fluxo operacional real (Sprint 12) | aceito |
| ADR-027 | `null=tombstone` em PATCH de configs JSONB | aceito |
| ADR-028 | Google Ads OAuth flow no Edge (não service account) — refresh_token criptografado workspace-scoped via PII_MASTER_KEY_V1 | aceito |
| ADR-029 | Data Manager API como default para Customer Match (Sprint 16); allowlist legacy mantida; auto-demote em `CUSTOMER_NOT_ALLOWLISTED` | aceito |
| ADR-030 | Custom events em Google Ads ficam como pendência manual (FUTURE-001); Sprint 14 cobre só canonical events na UI de mapping | aceito |
| ADR-031 | IP/UA + `external_id` (visitor_id) persistidos em `events.user_data` para EMQ Meta CAPI; separação intencional vs `raw_events.headers_sanitized` | aceito |
| ADR-032 | GA4 client_id cascade 4 níveis (self → sibling → cross_lead → deterministic) garante 100% Purchase com lead_id resolvem | aceito |
| ADR-033 | Geo enrichment: Cloudflare `request.cf` (browser) + Guru `contact.address` (Purchase) → `events.userData.geo_*` → Meta CAPI hash + Google Enhanced plain text | aceito |
| ADR-034 | Roles privilegiadas para PII em claro: ampliação para admin/marketer + reveal-on-demand para operator (Sprint 16) | aceito |
| ADR-035 | `lifecycle_status` armazenado em `leads` (vs derivado em query) — Sprint 16 | aceito |
| ADR-036 | Categorias de produto hardcoded no MVP, com `lifecycleForCategory(workspaceId, category)` pronto para futura tabela `lifecycle_rules` (FUTURE-001) — Sprint 16 | aceito |
| ADR-037 | `launch_products` (relação tipada) substitui `workspaces.config.integrations.guru.product_launch_map`; `guru-launch-resolver` Strategy 0 + Strategy 1 fallback durante migração — Sprint 16 | aceito |

## OQ-*

Em `90-meta/03-open-questions-log.md`.

| ID | Status | Bloqueante? |
|---|---|---|
| OQ-001 | **fechada** (Sprint 4) | pode esperar |
| OQ-002 | aberta | pode esperar |
| OQ-003 | **fechada** (Sprint 4) | pode esperar |
| OQ-004 | **fechada → ADR-024** (Sprint 2) | bloqueante (resolvida) |
| OQ-005 | aberta | pode esperar |
| OQ-006 | aberta | pode esperar |
| OQ-007 | **fechada** (Sprint 2) | pode esperar |
| OQ-008 | aberta | pode esperar |
| OQ-009 | aberta | pode esperar |
| OQ-010 | aberta | pode esperar |
| OQ-011 | **fechada** (Sprint 3) | bloqueante (resolvida) |
| OQ-012 | aberta | pode esperar (antes Sprint 6) |

## INV-* (Invariantes — registro vivo)

Subset registrado a partir de Sprint 16 (T-LEADS-VIEW-002 / T-CONTACTS-LASTSEEN-002). INVs estabelecidas anteriormente vivem nos respectivos `docs/20-domain/<NN>-mod-*.md § 7`.

| ID | Módulo | Enforcement | Doc canônica |
|---|---|---|---|
| INV-IDENTITY-001..008 | MOD-IDENTITY | DB constraint + domain | `20-domain/04-mod-identity.md § 7` |
| INV-IDENTITY-LASTSEEN-MONOTONIC | MOD-IDENTITY | Domain (`GREATEST` no UPDATE) | `20-domain/04-mod-identity.md § 7` + `BR-IDENTITY-008` |
| INV-LEAD-TAG-001 | MOD-IDENTITY | DB UNIQUE `(workspace_id, lead_id, tag_name)` + UPSERT idempotente | `20-domain/04-mod-identity.md § 7` |
| INV-LEAD-TAG-002 | MOD-IDENTITY | Service-layer (formato de `set_by`) | `20-domain/04-mod-identity.md § 7` |
| INV-EVENT-007 | MOD-EVENT | Domain (raw-events-processor) — eventos com `lead_token` válido têm `lead_id` resolvido pelo processor; backfill retroativo `visitor_id → lead_id` em Step 8 | `20-domain/05-mod-event.md § 7` |

## T-*

Definidas nos arquivos de sprint em `80-roadmap/` (Fase 7 da geração de docs).

### Registrados desde Sprint 16

| ID | Onda / Sprint | Docs afetadas |
|---|---|---|
| T-LEADS-VIEW-001 | Sprint 16 | migration `0044_lead_tags_and_blueprint_extension.sql`, `20-domain/04-mod-identity.md` (entidade LeadTag) |
| T-LEADS-VIEW-002 | Sprint 16 | `30-contracts/05-api-server-actions.md` (GET /v1/launches/:id/leads), `30-contracts/07-module-interfaces.md` (setLeadTag/applyTagRules) |
| T-RECOVERY-001 | Sprint 14 | `40-integrations/13-digitalmanager-guru-webhook.md` (abandoned → InitiateCheckout) |
| T-RECOVERY-004 | Sprint 14 | `30-contracts/05-api-server-actions.md` (GET /v1/launches/:id/recovery) |
| T-CONTACTS-LASTSEEN-002 | Sprint 16 | `BR-IDENTITY-008`, `INV-IDENTITY-LASTSEEN-MONOTONIC`, `30-contracts/07-module-interfaces.md` (resolveLeadByAliases options.eventTime) |
