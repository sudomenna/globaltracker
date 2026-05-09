# MEMORY.md

> **Estado de sessão volátil — não é fonte canônica.**
> - Decisões → [`docs/90-meta/04-decision-log.md`](docs/90-meta/04-decision-log.md) (ADR)
> - Open Questions → [`docs/90-meta/03-open-questions-log.md`](docs/90-meta/03-open-questions-log.md)
> - Histórico de ondas/sprints → `git log` + `docs/80-roadmap/<sprint>.md`
> - Limpeza periódica esperada — preserve apenas o que afeta a próxima sessão.

---

## §1 Estado atual

- **Sprint ativo**: nenhum ativo. Sequência de hardening entregue 2026-05-09 (tracker race + KV best-effort + alias supersede + dispatch payload audit + Google Ads OAuth refactor + OnProfit launch resolver + geo enrichment + outbox poller + DLQ nativa).
- **Branch**: `main`, working tree limpo (só `facebook_docs.md` untracked — não commitar). 28+ commits ahead de origin (sem push automático — pedir confirmação se for pushar).
- **Edge prod**: deploy atual **`9b78719c`** (outbox poller + DLQ, ADR-042). Comando: **`pnpm deploy:edge`** (wrangler@4; bug 10023 destravado pela CF em 2026-05-09).
- **CDN tracker.js**: R2 `gt-tracker-cdn` etag `991734d4`, 9466 bytes (race fix).
- **DB Supabase**: `kaxcmhfaqrxwnpftkslj` (sa-east-1, org CNE Ltda). Migrations 0000–**0050** aplicadas.
- **Cloudflare plan**: Workers Paid ativo desde 2026-05-09 17:05 UTC ($5/mês). KV quota agora mensal (~1M writes/mês), não daily. Padrão canônico (ADR-040): TODO `kv.put()` é best-effort.
- **DEV_WORKSPACE**: `74860330-a528-4951-bf49-90f0b5c72521` (Outsiders Digital → slug=`outsiders`).
- **Match score Meta CAPI**: 7/8 → **8/8 alcançável** (validado: 15 Purchases em score 8 nos últimos 7 dias).

### Onde começar a próxima sessão

**Pendências críticas**: TODAS resolvidas. Nada bloqueando. Pipeline 100% operacional.

**Recomendação minha pra atacar primeiro** (em ordem de valor/risco):

1. **Doc-sync pendentes** (low risk, low effort, high coverage) — 8 itens marcados `[SYNC-PENDING]` em §3 abaixo. Atualizar:
   - `CONTRACT-api-events-v1` (events.user_data jsonb shape, consent string|bool)
   - `CONTRACT-api-config-v1` (event_config.auto_page_view)
   - `BR-IDENTITY-005` (cookie `__ftk` SameSite=None Secure, sem HttpOnly)
   - `CORS público` em arch doc
   - `TEMPLATE-paid-workshop-v3-event-config-purge`
   - `CP-DOUBLE-STRINGIFY-event-config` (T-13-013)
   - `PHONE-normalizer-9-prefix-BR`
   - `ERASURE-GEO-FIELDS-AND-VISITOR-ID` (BR-PRIVACY-005 escopo expandido)

2. **Investigar 67 tests integration/e2e falhando** (médio risco, descoberto nesta sessão) — confirmados pré-existentes (rodaram em main sem minhas mudanças e falharam igual). Possíveis regressões acumuladas. Listar com `pnpm vitest run 2>&1 | grep "❯.*failed"` — começar pelos guru-launch-resolver (5 failed), processor-creates-dispatch-jobs (4 failed), flow-08-merge-leads (10 failed).

3. **MISSING-UNIT-TESTS-SESSION-2026-05-07** (low risk, hardening) — 6 specs faltando, listadas em §3. Trabalho repetitivo mas valor de regression coverage.

4. **Otimizações KV** (low priority após Workers Paid) — config cache em memory por instance, skip markSeen quando idempotency primary já marcou duplicate.

**NÃO atacar sem decisão de produto**: itens UI no Control Plane (CP-SNIPPET-GENERATOR, CP-MISSING-AUTO-PAGE-VIEW-TOGGLE).
**NÃO atacar sem dependência externa**: ONPROFIT-HMAC-VALIDATION-TODO (depende OnProfit publicar spec).

### Entregas recentes (2026-05-09) — sessão completa

| # | Tema | Commit | Deploy/Migration |
|---|---|---|---|
| 1 | Sprint 17 observability + doc-sync (anteriores) | `6af8f61` `ff92500` `0bf22f9` | `83afe16c` |
| 2 | Pacote Meta CAPI hardening (jsonb, fbc/fbp, historical lookup IP/UA/visitor_id) | `748f32e` `22db9a9` `89b1c6d` `77f97c6` `5ed259d` | `ed9a490d` `10bcaaa6` `974368b9` `ba2fbe37` |
| 3 | Health view `v_meta_capi_health` | `10277cf` | migration 0047 |
| 4 | OnProfit adapter inicial | `59003f9` `46e9c2e` | `1e905322` |
| 5 | **Migration 0048**: `obrigado-workshop.auto_page_view = false` | `a48f985` | DB only |
| 6 | **Tracker race-fix**: `capturePlatformCookies()` fresh em `track()` | `6fbcf6c` | R2 etag `991734d4` |
| 7 | CLAUDE.md §9: regra Playwright (matar processo dono) | `2974bd5` | — |
| 8 | **`markSeen` best-effort** (KV quota não 500a mais `/v1/events`) | `85777ec` | edge `f97af05f` |
| 9 | **Workers Paid ativo** ($5/mês, KV quota mensal) | (account-level) | — |
| 10 | **ADR-040** + BR-EVENT-004 refino + AGENTS rule 16 | `173dfb8` | — |
| 11 | **Migration 0049**: supersede 6 aliases órfãos `.con` (anti cross-contamination) | `3a7b6fd` | DB only |
| 12 | **Resolver supersede em re-submit** + 2 tests + BR-IDENTITY-001 update | `c89ccb4` | edge (incluso em deploys posteriores) |
| 13 | **Dispatch payload audit Meta CAPI** (request + response sanitized, IP redacted) + BR-DISPATCH-007 | `e12528b` | edge `35a93927` |
| 14 | + Captura request em GA4/Google Ads conv/enhanced + ADR-041 | `a51442b` | edge `1b2e2d74` |
| 15 | **T-14-009-FOLLOWUP**: Google Ads Conv aceita `accessToken` direto (paridade Enhanced) | `bea8042` | edge `db4c5464` |
| 16 | **OnProfit launch resolver** + lead_stages + tag_rules (paridade Guru) | `5668c67` | edge `d6ce4274` |
| 17 | **GEO-CITY-ENRICHMENT-GAP**: geo histórico Meta CAPI + view 0050 | `9a00f46` | edge `1b45681a` + migration 0050 |
| 18 | **Outbox poller + DLQ nativa** (raw_events recovery automática), ADR-042. Token CF migrado pra `.env.local`, `pnpm deploy:edge` com wrangler@4 | `fc1f778` | edge `9b78719c` + queue `gt-events-dlq` |

### Replays executados (2026-05-09 ~07:00–07:11 UTC)

7 dispatch_jobs de Meta CAPI (Purchase events com `utm_source=meta`) replayados via `POST /v1/dispatch-jobs/:id/replay` após deploy `ba2fbe37`. Todos succeeded. Match score subiu de 4-5/8 (original) para **7/8** (após enrichment com fbc/fbp/IP/UA/visitor_id históricos do mesmo lead). Falta apenas `geo_city` (não vem dos contact.address de algumas Guru transactions).

### Observabilidade — health check ad-hoc

```sql
SELECT received_at, match_score, eff_fbc, eff_fbp, eff_ip, eff_ua,
       eff_external_id, lead_em, lead_ph, amount, product_name, utm_source
  FROM v_meta_capi_health
 WHERE event_name='Purchase' AND received_at > now()-interval '24 hours'
 ORDER BY received_at DESC;
```

A view tem semântica "sem filtro temporal" — reflete o que o dispatcher REAL faz (lookup pega os 10 mais recentes do lead, mesmo posteriores ao evento, alinhado com `apps/edge/src/index.ts:lookupHistoricalBrowserSignals`).

### OnProfit configuração (IMPORTANTE)

- **Webhook URL**: `https://globaltracker-edge.globaltracker.workers.dev/v1/webhooks/onprofit?workspace=outsiders`
- **ERRO RESOLVIDO**: slug era `outsiders`, não `outsiders-digital`. Testado com 202 ✓
- **Checkout page criada**: `checkout-onprofit-workshop` (role=checkout, launch=wkshop-cs-jun26)
- **Tracker.js snippet**: instalado no HTML slot do checkout OnProfit (data-launch-public-id=`wkshop-cs-jun26`)
- **Pixel Web OnProfit**: OFF (usuário decidiu desativar para evitar conflito)
- **HMAC validation**: TODO — OnProfit não publicou spec do header ainda; protegido só por slug

### Sprint 16 — ondas entregues (detalhes em `git show <commit>`)

| Onda | Tema | Commit(s) | Deploy edge |
|---:|---|---|---|
| 1 | Meta CAPI external_id + IP/UA | `19bd917` (+ hotfix `1f95781`) | `e9a0a989` → `29f63e20` |
| 2 | GA4 client_id cascade + dispatch-replay fix (ADR-032, OQ-012 fechada) | `4bde77f` + `4dd703d` + `4eff5f9` | sucessivos |
| 3 | Geo enrichment Cloudflare + Guru contact.address (ADR-033) | (incluso em commits seguintes) | — |
| 4 | SendFlow pipeline fix (queue ingestion ponta-a-ponta) | `052d3b3` + `33549b9` + `f0d86dc` | `a64d6825` |
| 5 | Leads UX Fase 1 (3 colunas + multi-search + GMT-3) | `b143a0c` | — |
| 6 | Leads RBAC Fase 2 (JWT verify + masking + reveal, ADR-034) | `c183411` | `9224056b` |
| 7 | Lead Lifecycle + Products Catalog | `cf66e83` | `ed818549` |
| 8 | Launch Products + UI revamp + cadastro manual | `0fb5ca6` `2c04c97` `542c5e0` `0d6a0ed` | `68a7fcff` → `242869d2` |
| 9 | Recovery de Vendas (Guru abandoned/refund/chargeback) | `938a01f` | `f798d162` |
| 10 | Contatos vs Leads + lead_tags + tag_rules | `72ce0ee` | `bc11afa8` → `e818d984` |
| 11 | PII enrichment via Guru + last_seen_at monotônico | `1279304` | `d6ff7b4a` |
| 12 | lead-payload consent string\|bool + visitor_id arch | `ed14fd5` + `854ecd5` | `83afe16c` |

Doc-sync das Ondas 9–12 foi entregue no commit `445c048`.

---

## §2 Estado dos sprints

| Sprint | Status | Fonte canônica |
|---|---|---|
| 0 | completed | [`00-sprint-0-foundations.md`](docs/80-roadmap/00-sprint-0-foundations.md) |
| 1 | completed | [`01-sprint-1-fundacao-dados-contratos.md`](docs/80-roadmap/01-sprint-1-fundacao-dados-contratos.md) |
| 2 | completed | [`02-sprint-2-runtime-tracking.md`](docs/80-roadmap/02-sprint-2-runtime-tracking.md) |
| 3 | completed | [`03-sprint-3-meta-capi-webhooks.md`](docs/80-roadmap/03-sprint-3-meta-capi-webhooks.md) |
| 4 | completed (`c1e4abc`) | [`04-sprint-4-analytics-google.md`](docs/80-roadmap/04-sprint-4-analytics-google.md) |
| 5 | completed (`3757690`) | [`05-sprint-5-audience-multitouch.md`](docs/80-roadmap/05-sprint-5-audience-multitouch.md) |
| 6 | completed (`e613140`) | [`06-sprint-6-control-plane.md`](docs/80-roadmap/06-sprint-6-control-plane.md) |
| 7 | completed (`bd44b7f`) | [`07-sprint-7-orchestrator.md`](docs/80-roadmap/07-sprint-7-orchestrator.md) |
| 8 | completed (`4c72732`) | [`08-sprint-8-ai-dashboard.md`](docs/80-roadmap/08-sprint-8-ai-dashboard.md) |
| 9 | completed (`ded8fd2`) | [`09-sprint-9-funil-ux-hardening.md`](docs/80-roadmap/09-sprint-9-funil-ux-hardening.md) |
| 10 | completed (`ac93148`) | [`10-sprint-10-funil-templates-scaffolding.md`](docs/80-roadmap/10-sprint-10-funil-templates-scaffolding.md) |
| 11 | completed (`165855c`) | [`11-sprint-11-funil-webhook-guru.md`](docs/80-roadmap/11-sprint-11-funil-webhook-guru.md) |
| 12 | in progress (Onda 3 parcial — passos 1–4 do E2E) | [`12-sprint-12-funil-paid-workshop-realinhamento.md`](docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md) |
| 13 | planned (foundation funil B + cleanups) | [`13-sprint-13-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/13-sprint-13-webhooks-hotmart-kiwify-stripe.md) |
| 14 | completed (`f19b488`; T-14-017 adiado — ver §4) | [`14-sprint-14-fanout-google-ads-ga4.md`](docs/80-roadmap/14-sprint-14-fanout-google-ads-ga4.md) |
| 15 | planned (webhook adapters Hotmart/Kiwify/Stripe) | [`15-sprint-15-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/15-sprint-15-webhooks-hotmart-kiwify-stripe.md) |
| 16 | completed (Ondas 1–12 entregues 2026-05-08) | a criar |
| 17 | completed (`6af8f61`; doc-sync 2026-05-09) | a criar |

---

## §3 Pendências abertas

### Otimizações de KV writes (TECH-DEBT, médio prazo)

Hoje cada `/v1/events` faz ~3 KV writes (rate-limit + idempotency + markSeen) e cada `/v1/config` faz ~2 (rate-limit + cache). Workers Paid resolve o teto, mas reduzir writes melhora custo+performance e diminui acoplamento ao KV. Itens (não bloqueantes — só compensam se volume crescer >10x):

- **Config cache em memória por instance** — hoje cada cold start re-busca config do DB e regrava no KV. In-memory Map com TTL mediano cobriria boa parte sem write.
- **Rate-limit em Durable Objects** — sliding window via DO state em vez de KV counter. Menos writes, mais preciso, atomicidade nativa.
- **Skip markSeen quando idempotency já marcou duplicata** — hoje sempre tenta gravar; pode ler antes ou unificar com idempotency.checkAndSet.
- **TTL maior em config cache** — se config muda raramente, TTL atual pode estar alto demais (gerando refresh writes).

Tracking: criar issue futura quando o assunto voltar.

### Pendências críticas — Meta CAPI EMQ Hardening (2026-05-09)

- ~~**PIXEL-SNIPPET-LP-FIX (USUÁRIO)**~~ — RESOLVIDO 2026-05-09 (diagnóstico anterior estava errado). HTML deployado em `wk-obg` JÁ tem `fbq('consent','grant')` + `fbq('init','149334790553204')` + `fbq('track','PageView')` síncronos no head. O bug real era race interno do tracker (state.platformCookies snapshot em init vs handler do snippet executando durante `await fetchConfig` do init). Resolvido pelo tracker race-fix entregue nesta sessão. Validado via Playwright contra LP de prod.
- ~~**DISPATCH-ATTEMPTS-PAYLOAD-EMPTY**~~ — RESOLVIDO 2026-05-09 (deploy edge `35a93927`). `DispatchResult` extendido com `request?`/`response?` opcionais. Helper `sanitizeDispatchPayload` em `apps/edge/src/lib/dispatch-payload-sanitize.ts` redacta `client_ip_address`/`ip` (LGPD). `processDispatchJob` aplica como última camada (defesa em profundidade) e grava nas 6 call sites em vez de `{}` literal. Validado em prod com Lead event de teste — request mostra hashes em/ph/fn/ln/ct/st/zp/country preservados, IP redacted, response da Meta `{events_received, fbtrace_id, messages}` capturada. **Implementado apenas em Meta CAPI nesta entrega**; GA4/Google Ads/audience-sync continuam gravando `{}` (incremental — BR-DISPATCH-007 documenta tabela de status). Doc-sync: BR-DISPATCH-007 nova.
- ~~**GEO-CITY-ENRICHMENT-GAP**~~ — RESOLVIDO 2026-05-09 (deploy `1b45681a` + migration 0050). `lookupHistoricalBrowserSignals` agora retorna geo_city/geo_region_code/geo_postal_code/geo_country também. `buildMetaCapiDispatchFn` faz fallback via histórico do tracker.js quando o evento corrente não traz geo (caso típico: Purchase Guru sem contact.address). View `v_meta_capi_health` atualizada com `eff_geo` (CTE historical + match_score considerando hist_geo_city). Validação: 27 Purchases com `eff_geo=true`, antes 4 ficavam em score 7 — agora 15 em 8.
- **JSONB-LEGACY-ROWS-BACKFILL** — Rows pré-deploy `ed9a490d` (todas events/raw_events/dispatch_jobs anteriores a 2026-05-09 ~05:00) têm `jsonb_typeof='string'` em colunas jsonb. Funciona via Drizzle (parse na leitura), mas queries SQL ad-hoc precisam de `(col #>> '{}')::jsonb` defensivo. Backfill seria UPDATE em massa para re-cast: `UPDATE events SET user_data = (user_data #>> '{}')::jsonb WHERE jsonb_typeof(user_data)='string'`. Não urgente — mitigado via `lookupHistoricalBrowserSignals` defensivo e view `v_meta_capi_health`.

### Bloqueios e TODOs de código

- **MISSING-UNIT-TESTS-SESSION-2026-05-07** — TODO Sprint 16. 6 specs faltando:
  1. `tests/unit/dispatchers/meta-capi/mapper.test.ts` — mapeamento de custom events (`custom:click_buy_workshop`/`click_buy_main` → `InitiateCheckout`, `custom:click_wpp_join` → `Contact`, `custom:watched_workshop` → `ViewContent`).
  2. `tests/unit/dispatchers/ga4-mp/mapper.test.ts` — `begin_checkout`, `join_group`, `view_item` + `params.group_id` extraído de `cd.group_id` ou `cd.campaign_id`.
  3. `tests/unit/dispatchers/ga4-mp/client-id-resolver.test.ts` — `extractClientIdFromGaCookie` parse de `GA1.1.<n>.<n>`.
  4. `tests/unit/lib/raw-events-processor.test.ts` — `UserDataSchema` aceita `_ga`/`fvid` nullish e rejeita keys desconhecidas (`.strict`).
  5. `tests/integration/edge/config-route.test.ts` — `/v1/config` retorna config real do DB quando HYPERDRIVE/DATABASE_URL bindings presentes.
  6. `tests/unit/edge/ga4-sibling-lookup.test.ts` — Purchase sem `_ga` busca em events anteriores do mesmo lead.
  7. (a partir da Onda 3) `buildMetaCapiDispatchFn` hashing geo + Google mapper addressInfo geo.

- **CP-SNIPPET-GENERATOR-INCOMPLETE** — TODO Sprint 16. Gerador em [`apps/control-plane/src/app/(app)/launches/[launch_public_id]/pages/[page_public_id]/page-detail-client.tsx`](apps/control-plane/src/app/(app)/launches/[launch_public_id]/pages/[page_public_id]/page-detail-client.tsx) desalinhado com `apps/tracker/snippets/paid-workshop/*.html`:
  - `buildHeadSnippet` (L81): só emite tracker.js, **sem GA4/Meta Pixel** nem instruções WP Rocket.
  - `buildBodySnippet` (L97): usa `Funil.identify({email, phone, name})` — viola INV-TRACKER-008/BR-TRACKER-001 (API só aceita `lead_token`).
  - `buildDetectionScript` (L131): `consent.{analytics,marketing}: false` — deveria ser `'granted'` em todas finalidades.
  - **Plano**: (1) `buildHeadSnippet` v2 emite GA4 → Pixel → tracker (skip blocos não configurados), comentário com exclusões WP Rocket; (2) substituir `buildBodySnippet` por `buildFooterSnippet(role)` específico por `pages.role` (sales/thankyou/webinar); (3) corrigir consent + adicionar `fbq` calls com `eventID`; (4) tests cobrindo head sem GA4, head sem Meta, snippet por role.

- **CP-MISSING-AUTO-PAGE-VIEW-TOGGLE** — Tela de Configuração de eventos da page no CP não expõe toggle `auto_page_view` que vive em `pages.event_config.auto_page_view`. Hoje só via SQL direto. Política canônica (migration 0039): `role=thankyou → false`, `role=sales/webinar → true`. `obrigado-workshop` corrigido para `false` via migration 0048 (2026-05-09) após edição manual incorreta.

- **ONPROFIT-HMAC-VALIDATION-TODO** — `apps/edge/src/routes/webhooks/onprofit.ts:96-100` loga warn `onprofit_webhook_hmac_validation_todo` em todo request porque o spec do header HMAC do OnProfit não foi publicado. Hoje protegido apenas por `?workspace=<slug>` no query string. Atualizar quando OnProfit publicar a assinatura.

- ~~**ONPROFIT-LAUNCH-RESOLVER-TODO**~~ — RESOLVIDO 2026-05-09 (deploy `d6ce4274`). Criado `apps/edge/src/lib/onprofit-launch-resolver.ts` (mirror estrutural de `guru-launch-resolver.ts` — Strategy 0 launch_products, Strategy 1 product_launch_map legacy, Strategy 2 last_attribution, Strategy 3 none). Wired na rota `/v1/webhooks/onprofit` (resolve antes do raw_event insert; falha não-fatal). Processor agora ler `payload.launch_id`/`funnel_role` injetados, popula `events.launchId`, e implementa Steps 9+10 (lead_stages + tag_rules) seguindo blueprint do funnel. Próximo Purchase OnProfit emite stage corretamente.

- **T-13-013-FOLLOWUP** — RESOLVIDO (commit `22db9a9`, deploy `ed9a490d`, 2026-05-09). Helper `jsonb()` aplicado em ~58 writes em 12 arquivos do edge worker (4 raw-events-processors + dispatch.ts + index.ts + 6 webhook adapters). Adicionado `tests/helpers/jsonb-unwrap.ts` para mocks de teste extraírem JS value do SQL fragment. Pendente: backfill de rows antigas (events.user_data/custom_data/attribution/consent_snapshot ainda com jsonb_typeof='string' nas linhas pré-deploy — não bloqueia, queries SQL ad-hoc precisam usar `(col #>> '{}')::jsonb` pra essas).

- ~~**T-14-009-FOLLOWUP**~~ — RESOLVIDO 2026-05-09 (deploy `db4c5464`). `GoogleAdsConfig` aceita `accessToken?` direto; `buildGoogleAdsConversionDispatchFn` agora usa `getGoogleAdsAccessToken` (mesmo helper do Enhanced) — paridade entre os dois dispatchers Google Ads. `invalid_grant` agora classifica como `oauth_token_revoked` (skip permanente actionable) em vez de `server_error` (retry inútil). Backward-compat preservado: client ainda aceita `oauth?` legacy. 3 testes novos (50 total).

### Doc-sync pendentes (`SYNC-PENDING`)

- **ERASURE-GEO-FIELDS-AND-VISITOR-ID** (Sprint 16, ADR-033 + Sprint 17 hardening, ADR-039) — `apps/edge/src/lib/erasure.ts` (`eraseLead`) precisa zerar em **TODOS** os events do lead (não apenas no atual): `events.user_data.{geo_city, geo_region_code, geo_postal_code, geo_country, fbc, fbp, client_ip_address, client_user_agent}` + `events.visitor_id` (coluna dedicada, ADR-031). Geo via IP é dado pessoal sob LGPD. `visitor_id` é propagado via `lookupHistoricalBrowserSignals` (ADR-039) e precisa ser anonimizado para impedir re-enrichment em replays pós-erasure. Doc atualizada 2026-05-09 em `docs/50-business-rules/BR-PRIVACY.md` BR-PRIVACY-005 com escopo expandido (ainda marcada `[SYNC-PENDING]` até código mudar). ETA: próxima sprint que toque erasure.
- **CONTRACT-api-events-v1** — `event-payload.ts` aceita `user_data`, `attribution.nullish()`, consent string-or-bool. Atualizar `docs/30-contracts/05-api-server-actions.md`.
- **CONTRACT-api-config-v1** — Response inclui `event_config.auto_page_view`. Atualizar doc.
- **BR-IDENTITY-005** — Cookie `__ftk` mudou de `HttpOnly; SameSite=Lax` para `SameSite=None; Secure` sem HttpOnly (tracker lê via JS para propagar identidade cross-page). Atualizar BR + ADR.
- **CORS público** — Quando `pages.allowed_domains` está vazio, libera todas as origens (security via page token). Atualizar `docs/10-architecture/06-auth-rbac-audit.md`.
- **TEMPLATE-paid-workshop-v3-event-config-purge** — Migration 0034 manteve `Purchase` e `Contact` em `event_config.canonical` da page `obrigado-workshop`, mas pela arquitetura v3 ambos são server-side (Purchase via webhook Guru, Contact via webhook SendFlow). Próxima migration deve deixar canonical=`[PageView]`, custom=`[click_wpp_join, survey_responded]`. Aplicado runtime em `wkshop-cs-jun26` via UI do CP; template global ainda divergente. Verificar se o mesmo cabe em outras pages.
- **CP-DOUBLE-STRINGIFY-event-config** (T-13-013) — Save handler do CP grava `event_config` como string JSON dentro do JSONB (double-encoded). UPDATE manual já aplicado em `wkshop-cs-jun26`. Encontrar e corrigir o save handler que está rodando `JSON.stringify` antes do Drizzle.
- **PHONE-normalizer-9-prefix-BR** — `normalizePhone` em `apps/edge/src/lib/lead-resolver.ts:67` não reconcilia mobiles BR sem o "9" extra. Sistemas legados (SendFlow) enviam phone sem o 9 → `phone_hash` divergente. Tracking T-13-014. Após implementação atualizar `BR-IDENTITY-002` + nova `INV-IDENTITY-008` (mobile canônico = 13 dígitos `+55DD9XXXXXXXX`).
- ~~**RAW_EVENTS-jsonb-string**~~ — RESOLVIDO via T-13-013-FOLLOWUP (commit `22db9a9`, deploy `ed9a490d`, 2026-05-09). Helper `jsonb()` agora aplicado em todos call sites do edge. Doc-sync 2026-05-09: padrão documentado em `docs/30-contracts/02-db-schema-conventions.md` + ADR-038 + `BR-EVENT-005` reforçada. Pendência residual: backfill em massa de rows pré-deploy `ed9a490d` (jsonb-string legadas) — não urgente, mitigado via parse defensivo em reads. Tracking em `JSONB-LEGACY-ROWS-BACKFILL` acima.

### Pendências residuais — Sprint 16 Onda 8 (Products)

- **T-PRODUCTS-009**: integration tests E2E (`guru-purchase-promotes-lifecycle`, `lead-lifecycle-progression`).
- **T-PRODUCTS-010**: tela `/leads/[id]` seção "Compras" listando produtos comprados (deferred Onda 7).
- **T-PRODUCTS-011**: depreciar `product_launch_map` legacy — após confirmar resolver Strategy 0 estável, remover Strategy 1 fallback + UI legacy.
- **T-PRODUCTS-012** (FUTURE-002): tornar mapping categoria→lifecycle editável via tabela `lifecycle_rules(workspace_id, category, lifecycle_status)`. Função `lifecycleForCategory(workspaceId, cat)` já recebe `workspaceId` para facilitar migração sem rewrite.

### Trilhas E2E em aberto

#### TRILHA 1 — Purchase real via Guru (cartão real)

Comprar workshop em `https://clkdmg.site/pay/wk-contratos-societarios`. Valida pipeline completo: form workshop → `/v1/lead` → enrich PII → redirect Guru com UTMs → checkout → cartão → webhook Guru → `purchased_workshop` stage.

**Pré-requisitos**: tracker.js em prod com fix de race; snippet workshop com `stopImmediatePropagation`. **CRÍTICO** — abrir page com UTMs explícitas (ex: `?utm_source=teste-trilhaA&utm_campaign=cartao-real-2026-05`) para destravar T-13-009.

**O que validar pós-compra**:
1. `events` row `event_name='Purchase'`, `event_source='webhook:guru'`, `customData.dates.confirmed_at` populado, `customData.amount` correto, `attribution.utm_*` populados (fecha T-13-009 se UTMs chegaram).
2. `lead_stages` row `stage='purchased_workshop'`, `funnel_role='workshop'`.
3. `leads.email_enc/phone_enc/name_enc` populados via `enrichLeadPii` (já wired em guru-raw-events-processor desde Onda 11).
4. Se 2 webhooks (autorização + settlement), confirmar UPDATE com `dates.confirmed_at` correto via T-13-010 fix (`guru_webhook_updated_with_newer_payload` no log).

```sql
SELECT id, event_name, event_source, lead_id, event_time, attribution, custom_data
  FROM events
 WHERE workspace_id='74860330-a528-4951-bf49-90f0b5c72521'
   AND event_name='Purchase' AND received_at > now() - interval '15 minutes'
 ORDER BY received_at DESC LIMIT 5;
```

**Cuidado**: compra real tem custo. Combinar com Tiago (cartão pessoal vs sandbox Guru). Após teste, registrar lead resultante + event_ids para regressão.

#### TRILHA 3 — T-13-012 Survey form em obrigado-workshop

Formulário de pesquisa pós-compra do workshop, dispara `custom:survey_responded` → stage `survey_responded`. Audience `respondeu_pesquisa_sem_comprar_main` já existe no template v3 (migration 0036).

**Onde**: page `/wk-obg/` no WordPress (Elementor atomic form), CSS ID `gt-form-survey`. Snippet WPCode FOOTER intercepta submit em capture phase com `ev.preventDefault() + ev.stopImmediatePropagation()`, monta `customData` com respostas, chama `Funil.track('custom:survey_responded', { custom_data: { q1, q2, q3 } })`. BR-EVENT-001 exige prefixo `custom:`. Schema validado contra `pages.event_config.custom_data_schema` (hoje `{}`).

**Conteúdo das perguntas**: confirmar com Tiago no início da trilha (decisão de produto).

**Reaproveitar**: `apps/tracker/snippets/paid-workshop/workshop.html:128-194` (wireForm) como modelo.

**Validação**:
1. Aplicar form na page WP, allowlist Wordfence, limpar WP Rocket.
2. Modo anônimo: visitar `/wk-obg/`, preencher, submeter.
3. SQL: novo `events` row `event_name='custom:survey_responded'` + `lead_stages` `stage='survey_responded'`.
4. Audience: lead deve aparecer em `respondeu_pesquisa_sem_comprar_main` se ainda não comprou main.

---

## §4 Tarefas futuras

### T-14-017 — Backfill Google Ads (90 dias de Purchase)

Script que cria retroativamente `dispatch_jobs` para `google_ads_conversion` + `google_enhancement` para Purchase events anteriores à conexão Google Ads.

**Pré-requisitos**: OAuth Google Ads conectado no workspace + `conversion_actions` mapeados em `workspaces.config.integrations.google_ads.conversion_actions`. Setup externo (criar OAuth Client no Google Cloud Console, solicitar developer_token Basic access ~1–2 dias úteis, `wrangler secret put` de `GOOGLE_OAUTH_CLIENT_ID/SECRET/STATE_SECRET` + `GOOGLE_ADS_DEVELOPER_TOKEN`, adicionar `GOOGLE_OAUTH_REDIRECT_URI` em `wrangler.toml`).

**Como**: rodar `/tmp/pgquery/test-fanout-google.mjs` para sanidade, depois script análogo a `replay-ga4-purchase-skips-v2.mjs` — Purchase events últimos 90d sem `dispatch_jobs` para `google_ads_conversion` → INSERT.

**Limite API**: conversions >90d são rejeitadas. Estimativa ~30min após pré-requisitos.

---

## §5 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Supabase project | `kaxcmhfaqrxwnpftkslj` (globaltracker, sa-east-1, org CNE Ltda) |
| Workspace slug | `outsiders` (ID `74860330-a528-4951-bf49-90f0b5c72521`) — usar em `?workspace=outsiders` |
| Cloudflare account | `118836e4d3020f5666b2b8e5ddfdb222` (cursonovaeconomia@gmail.com) |
| CF KV (prod) | `c92aa85488a44de6bdb5c68597881958` |
| CF KV (preview) | `59d0cf1570ca499eb4597fc5218504c2` |
| CF Queues | `gt-events`, `gt-dispatch` |
| Hyperdrive | config `globaltracker-db`, id `39156b974a274f969ca96d4e0c32bce1` |
| Worker prod | `globaltracker-edge.globaltracker.workers.dev` |
| R2 bucket | `gt-tracker-cdn` (público em `pub-e224c543d78644699af01a135279a5e2.r2.dev`) |
| Wrangler | **2.20.0** via `npx wrangler@2.20.0 publish` — wrangler 3.x/4.x falha com code 10023. Requer `CLOUDFLARE_API_TOKEN` env (API token "Edit Cloudflare Workers", **não** OAuth de `wrangler login`). |
| Supabase CLI | 2.90.0 |
| Node | 24.x (v24.10.0) |
| pnpm | 10.x |

**DB connect ad-hoc**: `host=db.kaxcmhfaqrxwnpftkslj.supabase.co port=5432 user=postgres database=postgres ssl={rejectUnauthorized:false}` — senha em `~/.zshrc` ou cofre.

**Recovery operacional pós-deploy**: hoje rodando via `DATABASE_URL` secret (fallback do binding HYPERDRIVE stripado pelo wrangler 2.x). Restaurar HYPERDRIVE binding quando descobrirmos como deploy com wrangler 4.x.

---

## §6 Notas técnicas invariantes

- **DB binding pattern**: `DATABASE_URL ?? HYPERDRIVE.connectionString ?? ''` — obrigatório em todas as rotas.
- **Migrations**: duas pastas — `packages/db/migrations/0NNN_*.sql` e `supabase/migrations/20260502000NNN_*.sql`. Manter sincronizadas.
- **RLS dual-mode**: `NULLIF(current_setting('app.current_workspace_id', true), '')::uuid OR public.auth_workspace_id()`.
- **JSONB writes**: usar helper `jsonb()` em [`apps/edge/src/lib/jsonb-cast.ts`](apps/edge/src/lib/jsonb-cast.ts) (dollar-quoted via `sql.raw`) para qualquer escrita em coluna jsonb. Driver pg-cloudflare-workers/Hyperdrive serializa params como text com aspas — sem o helper, valores JSON viram jsonb-string.
- **JSONB reads**: parse defensivo `(payload #>> '{}')::jsonb` ou JSON.parse — pode chegar como string em rows legadas.
- **Cookie `__ftk`**: `SameSite=None; Secure;` sem `HttpOnly` (tracker lê via JS). BR-IDENTITY-005 sync pendente.
- **Tracker.js**: `dist/` é gitignored. Após mudar `apps/tracker/src/`: `node build.config.js` + `npx wrangler r2 object put gt-tracker-cdn/tracker.js --remote --file=./dist/tracker.js --content-type=application/javascript`.
- **Edge redeploy**: `cd apps/edge && CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler@2.20.0 publish` (NÃO `deploy`, NÃO da raiz do monorepo).
- **Tracker dedup**: events deduped por `(event_name, sessionStorage)` TTL 5min. Segundo Lead/PageView na mesma sessão → `event_duplicate_accepted` (esperado).
- **`/v1/events`**: dual-mode — POST = tracker.js (public auth+CORS), GET = CP (admin CORS, Bearer auth).
- **Events partitioned**: tabela `events` é `PARTITIONED BY RANGE (received_at)` — UNIQUE constraint inclui `received_at`. `INSERT ... ON CONFLICT` não dispara para retries em horários diferentes; usar pre-insert SELECT por `(workspace_id, event_id)` (padrão T-FUNIL-047 / T-13-008).
- **CP**: usar `<dialog open>` nativo (não `div role="dialog"`).
- **OXC parse error** em type aliases multi-linha → usar `Record<string, unknown>`.
- **Biome**: varre `.claude/worktrees/`. Limpar com `git worktree remove -f <path>` após uso.
- **Semântica `null=tombstone`** (ADR-027): `null` em qualquer chave do body do `PATCH /v1/workspace/config` (qualquer profundidade) **deleta** a chave do JSONB. Padrão genérico para PATCHes futuros sobre configs JSONB.
- **Routes mounting order**: rotas mais específicas (ex: `/v1/launches/:id/products`) **antes** de `launchesRoute` em `apps/edge/src/index.ts` — caso contrário o catch-all intercepta primeiro.
- **`hashPii` é workspace-scoped** (uso interno lead-resolver); para Meta/Google usar `hashPiiExternal` (SHA-256 puro) + colunas `email_hash_external/phone_hash_external/fn_hash/ln_hash` na tabela `leads`.

---

## §7 Política de uso

- `MEMORY.md` é volátil — pode ser limpa entre sessões.
- Decisões importantes migram para [`docs/90-meta/04-decision-log.md`](docs/90-meta/04-decision-log.md) (ADR).
- OQs migram para [`docs/90-meta/03-open-questions-log.md`](docs/90-meta/03-open-questions-log.md).
- Não duplique aqui o que já está em ADR/OQ — referencie.
- Histórico de ondas/sprints fica em `git log` + `docs/80-roadmap/<sprint>.md`. Não copiar pra cá.
- Bugs RESOLVIDOS saem do MEMORY após o commit que os fechou. Se foi resolvido, `git show <commit>` é a fonte.
