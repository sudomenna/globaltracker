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

- `POST /v1/dispatch-jobs/:id/replay`: contrato JÁ existe em `docs/30-contracts/05-api-server-actions.md` (CONTRACT-api-dispatch-replay-v1) e implementação existe em `apps/edge/src/routes/dispatch-replay.ts`. **Divergência de shape**: implementação retorna 200 + `{ queued, job_id, destination }`, contrato especifica 202 + `{ new_job_id, status: 'queued' }` e body `{ justification }` vs `{ reason }`. Fix incluído em T-7-004 do Sprint 7.

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
| Sprint 6 | **completed** (2026-05-02, commit e613140) | `docs/80-roadmap/06-sprint-6-control-plane.md` |
| Sprint 7 | **próximo** | `docs/80-roadmap/07-sprint-7-orchestrator.md` |
| Sprint 8 | planned | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |
| Sprint 9 | planned | `docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 7 — onda 1 completa, pronto para onda 2
Último commit: (a commitar) — Sprint 7 onda 1
Verificação:   typecheck ✓  lint ✓  1230 testes passando
DB Supabase:   migrations 0000–0024 aplicadas ✓ | 0025_orchestrator pendente de apply
Sprint 7 doc:  docs/80-roadmap/07-sprint-7-orchestrator.md (decomposição completa)
Onda 0:        T-7-000 ✓ — 6 contratos em docs/30-contracts/05-api-server-actions.md + enums em 01-enums.md
Onda 1:        T-7-001 ✓ schema (workflow_runs, lp_deployments, campaign_provisions)
               T-7-002 ✓ apps/orchestrator/ — Trigger.dev 3.3.17, 4 tasks stub
               T-7-003 ✓ apps/lp-templates/ — Astro 4.x, capture template
```

### Sprint 6 entregues (referência rápida)

- **Edge**: 7 novos endpoints (`/v1/pages/:id/status`, `/v1/health/*`, `/v1/integrations/:p/test`, `/v1/onboarding/state`, `/v1/dispatch-jobs/:id/replay`, `/v1/help/skip-reason/:reason`, `/v1/leads/:id/timeline`)
- **CP** (`apps/control-plane/`): Next.js 15 App Router — onboarding wizard, page registration, integration health, lead timeline, workspace header badge, glossary, tooltips, deep-links, skip-reason copy deck
- **DB**: migration 0024 — `onboarding_state JSONB` em `workspaces`
- **Testes**: 130 novos testes (unit + integration + a11y static analysis)

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Smoke E2E (T-1-021) | escrita, não executada | `wrangler dev` com `localConnectionString` |
| Secrets produção (base) | não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET PII_MASTER_KEY_V1 TURNSTILE_SECRET_KEY` |
| Secrets Sprint 4 (cost/google/ga4) | não deployados | `META_ADS_ACCOUNT_ID META_ADS_ACCESS_TOKEN GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_CURRENCY GA4_MEASUREMENT_ID GA4_API_SECRET FX_RATES_PROVIDER` |
| Secrets Sprint 5 (audience) | não deployados | `META_CUSTOM_AUDIENCE_TOKEN META_DEFAULT_AD_ACCOUNT_ID` |
| SYNC-PENDING doc contrato | aberto | `POST /v1/dispatch-jobs/:id/replay` → `docs/30-contracts/05-api-server-actions.md` |

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-024 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto no checkout (não bloqueia Sprint 7)

### Notas técnicas

**OXC + Biome (para subagents de teste)**
`typeof import('long/path')` em type aliases multi-linha → parse error no OXC.
Fix: `Record<string, unknown>` como cast intermediário em `vi.mock` factories.

**Dois diretórios de migrations**
Ao criar em `packages/db/migrations/0NNN_*.sql`, copiar para `supabase/migrations/20260501000NNN_*.sql`.

**A11y nos componentes CP**
Padrão de `<dialog open>` nativo (não `div role="dialog"`) estabelecido na Sprint 6. Overlay `aria-hidden` com biome-ignore `useKeyWithClickEvents`. Usar `<output>` no lugar de `div role="status"`.

### Como retomar em nova sessão

1. Ler este §5 + `git log -5` + `git status`
2. Abrir `docs/80-roadmap/07-sprint-7-orchestrator.md`
3. Decompor em ondas + despachar subagents conforme `CLAUDE.md §2`

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `e613140` — Sprint 6 completo |
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
