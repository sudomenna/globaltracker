# MEMORY.md

> **Estado de sessão volátil.** Não é fonte canônica.
> Decisões grandes migram para ADR em `docs/90-meta/04-decision-log.md`.
> Open Questions migram para `docs/90-meta/03-open-questions-log.md`.
> Este arquivo pode ser limpo entre sessões — preserve apenas o que afeta a próxima sessão.

## §0 Feedback operacional

(vazio)

## §1 Bloqueios e pendências de stack [STACK-BLOQUEIO]

(vazio)

## §2 Divergências doc ↔ código [SYNC-PENDING]

(vazio)

## §3 Modelo de negócio (decisões ainda não em ADR)

2026-05-01 — Supabase em cloud (não local). Projeto `globaltracker`, ref `kaxcmhfaqrxwnpftkslj`, sa-east-1, org CNE Ltda.

## §4 Estado dos sprints — fontes canônicas

| Sprint | Status | Fonte canônica |
|---|---|---|
| Sprint 0 | **completed** (2026-05-01, commit `0d0d42b`) | `docs/80-roadmap/00-sprint-0-foundations.md` |
| Sprint 1 | **completed** (2026-05-01, commit `79ec7d4`) | `docs/80-roadmap/01-sprint-1-fundacao-dados-contratos.md` |
| Sprint 2 | **completed** (2026-05-02, commit 9e01566) | `docs/80-roadmap/02-sprint-2-runtime-tracking.md` |
| Sprint 3 | **completed** (2026-05-02) | `docs/80-roadmap/03-sprint-3-meta-capi-webhooks.md` |
| Sprint 4 | **completed** (2026-05-02, commit b7af2a3) | `docs/80-roadmap/04-sprint-4-analytics-google.md` |
| Sprint 5 | planned | `docs/80-roadmap/05-sprint-5-audience-multitouch.md` |
| Sprint 6 | planned | `docs/80-roadmap/06-sprint-6-control-plane.md` |
| Sprint 7 | planned | `docs/80-roadmap/07-sprint-7-orchestrator.md` |
| Sprint 8 | planned | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |
| Sprint 9 | planned | `docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 4 COMPLETO — próximo: Sprint 5
Último commit: b7af2a3 (branch main)
Verificação S4: typecheck ✓  lint ✓  829 testes passando

Sprint 0: COMPLETO
Sprint 1: COMPLETO
Sprint 2: COMPLETO
  Onda 1: T-2-001/002/003 (tracker.js 2.28KB), T-2-007 (lead-resolver+attribution+consent), T-2-009 (Turnstile)
  Onda 2: T-2-004/005/011 (tracker 3.04KB), T-2-006 (processor), T-2-008/010 (lead_token real+middleware)
  Onda 3: T-2-012 (34 testes FLOW-02/07/08)

Sprint 3: COMPLETO (2026-05-02)
  Pré-onda: schema workspace_integrations (migration 0021) + workspace_integrations.guru_api_token
  Onda 0: dispatch.ts (createDispatchJobs, processDispatchJob, markDeadLetter, requeueDeadLetter, createSkippedJob, computeIdempotencyKey, computeBackoff)
  Onda 1: Meta CAPI dispatcher (T-3-001 mapper, T-3-002 client, T-3-003 eligibility)
  Onda 2: Adapter Digital Manager Guru — mapper + types + rota POST /v1/webhook/guru (T-3-004)
  OQ-011 FECHADA: resolvida via tabela workspace_integrations + adapter Guru
  REMOVIDO: Hotmart, Kiwify, Stripe → movidos para Sprint 9

Sprint 4: COMPLETO (2026-05-02, commit b7af2a3)
  Onda 1 (Cost ingestor + FX):
    - apps/edge/src/integrations/fx-rates/ — ECB/Wise/Manual clients + cache + factory
    - apps/edge/src/lib/fx.ts — getRateForPair (KV cache → provider retry → stale fallback)
    - apps/edge/src/integrations/meta-insights/client.ts — Meta Ads Insights API client
    - apps/edge/src/integrations/google-ads-reporting/client.ts — Google Ads Reporting client
    - apps/edge/src/crons/cost-ingestor.ts — ingestDailySpend (Meta + Google, FX normalização)
  Onda 2 (Dispatchers Google + GA4):
    - apps/edge/src/dispatchers/ga4-mp/ — client + mapper + client-id-resolver + eligibility + index
    - apps/edge/src/dispatchers/google-ads-conversion/ — client + mapper + eligibility + oauth + index
    - apps/edge/src/dispatchers/google-enhanced-conversions/ — client + mapper + eligibility + oauth + index
    - apps/edge/src/index.ts — scheduled handler (cost cron) + 3 novos destinations no queue handler
      (ga4_mp, google_ads_conversion, google_enhancement)
  Infra:
    - packages/db/migrations/0022_metabase_views.sql — views SQL para Metabase
    - docs/80-roadmap/metabase-setup.md — guia de setup Metabase
  OQ-001 FECHADA: ECB como provider default (implementado)
  OQ-003 FECHADA: opção B — mintar client_id derivado de __fvid (implementado)
  OQ-012 ABERTA: GA4 client_id para comprador sem passagem pela LP (ver OQ-012 no log)
```

### Escopo Sprint 4 — contexto chave

**Cost ingestor** (`apps/edge/src/crons/cost-ingestor.ts`):
- `ingestDailySpend(date, env, db, fetchFn?, sleepFn?)` — nunca lança, erros em `errors[]`
- Busca Meta Insights (granularity=`ad`) + Google Ads Reporting (granularity=`adset`)
- Normaliza para BRL via `getRateForPair` (ECB default, stale fallback, KV cache)
- Upsert via constraint `uq_ad_spend_daily_natural_key` (INV-COST-001)
- Scheduled handler no `index.ts` — 17:30 UTC diário

**FX rates** (`apps/edge/src/lib/fx.ts`):
- `getRateForPair(from, to, date, env, fetchFn?, sleepFn?): Promise<FxRateResult>`
- Fluxo: KV cache → provider (3× retry, backoff 1s/2s/4s) → stale KV → `FxRatesUnavailableError`
- Provider selecionado via `FX_RATES_PROVIDER` env (`ecb` default / `wise` / `manual`)

**Dispatchers Google** (Sprint 4 Onda 2):
- `ga4_mp` — eligibility (consent analytics + measurementId), mapper (mintar client_id de __fvid), client (POST MP)
- `google_ads_conversion` — eligibility (click ID + consent ad_user_data), mapper, OAuth refresh, client
- `google_enhancement` — eligibility (order_id + 24h + email/phone hash + consent), mapper (SHA-256 normalized), OAuth, client
- Todos roteados no queue handler de `index.ts`

**OQ-012** — GA4 client_id para comprador direto no checkout (sem LP): default é skip via eligibility.
Ver `docs/90-meta/03-open-questions-log.md#OQ-012`.

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Migration 0020 (FK ad_spend_daily→launches) | **aplicada** | — |
| Migration 0022 (Metabase views) | implementada, não aplicada em prod | `supabase db push` |
| Smoke E2E (T-1-021) | escrita, não executada | descomentar `localConnectionString` no `wrangler.toml` + `wrangler dev` |
| Secrets produção (base) | não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `TURNSTILE_SECRET_KEY` |
| Secrets Sprint 4 (cost/google/ga4) | não deployados | `META_ADS_ACCOUNT_ID`, `META_ADS_ACCESS_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CURRENCY`, `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `FX_RATES_PROVIDER` |

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-024 em `docs/90-meta/04-decision-log.md`
- OQ-001 FECHADA: ECB como provider FX default
- OQ-003 FECHADA: mintar client_id GA4 de __fvid (opção B)
- OQ-007 FECHADA: `lead_token` stateful (tabela `lead_tokens`)
- OQ-004 FECHADA → ADR-024: Cloudflare Turnstile em `/v1/lead`
- OQ-011 FECHADA: `workspace_integrations` + `createDispatchJobs` implementados

### Secrets — onde estão

- `.env.local` na raiz (gitignored): `LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `DATABASE_URL`, chaves Supabase, IDs CF, `HYPERDRIVE_CONFIG_ID`
- `apps/edge/.dev.vars` (gitignored): `LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `DATABASE_URL`
- Produção: secrets **não** deployados ainda

### Como retomar em nova sessão

1. Ler este §5 + `git log -5` + `git status`
2. Abrir `docs/80-roadmap/05-sprint-5-audience-multitouch.md`
3. Verificar OQ-012 — GA4 client_id para comprador direto no checkout (não bloqueia até Sprint 6)
4. Decompor em ondas + despachar subagents conforme `CLAUDE.md §2`

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `b7af2a3` — Sprint 3 + Sprint 4 completos |
| Supabase project | `kaxcmhfaqrxwnpftkslj` (globaltracker, sa-east-1, org CNE) |
| Cloudflare account | `118836e4d3020f5666b2b8e5ddfdb222` (cursonovaeconomia@gmail.com) |
| CF KV (prod) | `c92aa85488a44de6bdb5c68597881958` |
| CF KV (preview) | `59d0cf1570ca499eb4597fc5218504c2` |
| CF Queues | `gt-events`, `gt-dispatch` |
| Hyperdrive | config `globaltracker-db`, id `39156b974a274f969ca96d4e0c32bce1` — direct connection Supabase (Supavisor rejeitou com "Tenant not found") |
| Wrangler | 4.87.0 (via npx — não instalado globalmente) |
| Supabase CLI | 2.90.0 (logado na conta CNE) |
| Node | 24.x (v24.10.0 detectado) |
| pnpm | 10.x |

## Política de uso

- `MEMORY.md` é volátil — pode ser limpa entre sessões.
- Decisões importantes migram para `docs/90-meta/04-decision-log.md` (ADR).
- OQs migram para `docs/90-meta/03-open-questions-log.md`.
- Não duplique aqui o que já está em ADR/OQ — referencie.
