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
| Sprint 0 | **completed** | `docs/80-roadmap/00-sprint-0-foundations.md` |
| Sprint 1 | **completed** | `docs/80-roadmap/01-sprint-1-fundacao-dados-contratos.md` |
| Sprint 2 | **completed** | `docs/80-roadmap/02-sprint-2-runtime-tracking.md` |
| Sprint 3 | **completed** | `docs/80-roadmap/03-sprint-3-meta-capi-webhooks.md` |
| Sprint 4 | **completed** (2026-05-02, commit c1e4abc) | `docs/80-roadmap/04-sprint-4-analytics-google.md` |
| Sprint 5 | **completed** (2026-05-02, commit 3757690) | `docs/80-roadmap/05-sprint-5-audience-multitouch.md` |
| Sprint 6 | **próximo** | `docs/80-roadmap/06-sprint-6-control-plane.md` |
| Sprint 7 | planned | `docs/80-roadmap/07-sprint-7-orchestrator.md` |
| Sprint 8 | planned | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |
| Sprint 9 | planned | `docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 6 — Onda 4 completa, pronto para Onda 5
Último commit: 7b8dfcd (branch main)
Verificação:   typecheck ✓  lint ✓  1100 testes passando
DB Supabase:   migrations 0000–0024 aplicadas ✓
```

### Sprint 6 — Onda 1 **CONCLUÍDA** ✓

| T-ID | Status |
|---|---|
| T-6-001 | ✓ `onboarding_state` JSONB + migration 0024 + Zod schema |
| T-6-002 | ✓ `apps/control-plane/` bootstrapped (Next.js 15 + shadcn + Supabase Auth) |
| T-6-003 | ✓ `GET /v1/pages/:public_id/status` + 31 testes |
| T-6-004 | ✓ `GET /v1/health/integrations` + `GET /v1/health/workspace` + 30 testes |
| T-6-007 | ✓ `POST /v1/integrations/:provider/test` (meta/ga4/google_ads) |

Verificação onda 1: typecheck ✓ lint ✓ 1006 testes ✓

### Sprint 6 — Onda 2 **CONCLUÍDA** ✓

| T-ID | Status |
|---|---|
| T-6-005 | ✓ `GET/PATCH /v1/onboarding/state` + 33 testes |
| T-6-006 | ✓ `<HealthBadge>` component + `useIntegrationsHealth()` SWR hook + sidebar atualizado |
| T-6-008 | ✓ `POST /v1/dispatch-jobs/:id/replay` + 26 testes |
| T-6-009 | ✓ `GET /v1/help/skip-reason/:reason` + 20 testes |
| T-6-010 | ✓ `GET /v1/leads/:public_id/timeline` + 16 testes |

Verificação onda 2: typecheck ✓ lint ✓ 1100 testes ✓

### Sprint 6 — Onda 3 **CONCLUÍDA** ✓

| T-ID | Status |
|---|---|
| T-6-011 | ✓ Wizard 5 passos `/onboarding` + re-entry + skip-all dialog + banner "Setup incompleto" |
| T-6-012 | ✓ Page registration `/launches/:id/pages/new` + detalhe com polling SWR + snippet |
| T-6-013 | ✓ Integration health list + detalhe `/integrations/[provider]` com test flow + deep-links |
| T-6-014 | ✓ Lead timeline `/leads/:id` com filtros + cursor pagination + WhyFailedSheet |
| T-6-016 | ✓ Workspace header badge + IncidentsPanel Sheet + banner setup incompleto |

Verificação onda 3: typecheck ✓ lint ✓ 1100 testes ✓

### Sprint 6 — Onda 4 **CONCLUÍDA** ✓

| T-ID | Status |
|---|---|
| T-6-015 | ✓ `DiagnosticsPanel` (origin_not_allowed, invalid_token, sem ping recente) |
| T-6-017 | ✓ `deep-links.ts` com 9 funções puras (Meta/GA4/Google Ads) |
| T-6-018 | ✓ Re-dispatch AlertDialog + aria-live + RBAC OPERATOR/ADMIN |
| T-6-019 | ✓ `<TooltipHelp>` + `skip-reason-copy.ts` (§1-3 completos) + aplicado em integrações/onboarding |

Verificação onda 4: typecheck ✓ lint ✓ 1100 testes ✓

### Sprint 6 — próxima onda: **Onda 5** (3 T-IDs em paralelo)

- T-6-020 (test-author): Testes unit + integration CP + edge endpoints
- T-6-021 (test-author): A11y tests axe-core
- T-6-022 (general-purpose): Glossary `/help/glossary` + WhyFailedSheet melhorado

Plano detalhado: `docs/80-roadmap/06-sprint-6-control-plane.md`

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Smoke E2E (T-1-021) | escrita, não executada | `wrangler dev` com `localConnectionString` |
| Secrets produção (base) | não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET PII_MASTER_KEY_V1 TURNSTILE_SECRET_KEY` |
| Secrets Sprint 4 (cost/google/ga4) | não deployados | `META_ADS_ACCOUNT_ID META_ADS_ACCESS_TOKEN GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_CURRENCY GA4_MEASUREMENT_ID GA4_API_SECRET FX_RATES_PROVIDER` |
| Secrets Sprint 5 (audience) | não deployados | `META_CUSTOM_AUDIENCE_TOKEN META_DEFAULT_AD_ACCOUNT_ID` |

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-024 em `docs/90-meta/04-decision-log.md`
- OQ-001 FECHADA: ECB como provider FX default
- OQ-003 FECHADA: mintar client_id GA4 de __fvid (opção B)
- OQ-004 FECHADA → ADR-024: Cloudflare Turnstile em `/v1/lead`
- OQ-007 FECHADA: `lead_token` stateful (tabela `lead_tokens`)
- OQ-011 FECHADA: `workspace_integrations` + `createDispatchJobs` implementados
- OQ-012 ABERTA: GA4 client_id para comprador direto no checkout (não bloqueia até Sprint 6)

### Nota técnica — OXC + Biome (para subagents de teste)

`typeof import('long/path')` em type aliases multi-linha causa parse error no OXC (vite:oxc).
Fix: usar `Record<string, unknown>` como cast intermediário em `vi.mock` factories.

### Nota técnica — supabase/migrations vs packages/db/migrations

Dois diretórios de migrations. Ao criar nova migration em `packages/db/migrations/0NNN_*.sql`, copiar manualmente para `supabase/migrations/20260501000NNN_*.sql` antes de `supabase db push`.

### Secrets — onde estão

- `.env.local` na raiz (gitignored): `LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `DATABASE_URL`, chaves Supabase, IDs CF, `HYPERDRIVE_CONFIG_ID`
- `apps/edge/.dev.vars` (gitignored): `LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `DATABASE_URL`
- Produção: secrets **não** deployados ainda

### Como retomar em nova sessão

1. Ler este §5 + `git log -5` + `git status`
2. Abrir `docs/80-roadmap/06-sprint-6-control-plane.md`
3. Decompor em ondas + despachar subagents conforme `CLAUDE.md §2`

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `3757690` — Sprint 5 completo |
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
