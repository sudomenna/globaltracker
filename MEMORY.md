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
| Sprint 3 | **em execução** (iniciado 2026-05-02) | `docs/80-roadmap/03-sprint-3-meta-capi-webhooks.md` |
| Sprint 4 | planned | `docs/80-roadmap/04-sprint-4-analytics-google.md` |
| Sprint 5 | planned | `docs/80-roadmap/05-sprint-5-audience-multitouch.md` |
| Sprint 6 | planned | `docs/80-roadmap/06-sprint-6-control-plane.md` |
| Sprint 7 | planned | `docs/80-roadmap/07-sprint-7-orchestrator.md` |
| Sprint 8 | planned | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |
| Sprint 9 | planned | `docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 3 EM EXECUÇÃO
Último commit: bd6ff23 (branch main)
Verificação S2: typecheck ✓  lint ✓  431 testes passando

Sprint 0: COMPLETO
Sprint 1: COMPLETO
Sprint 2: COMPLETO
  Onda 1: T-2-001/002/003 (tracker.js 2.28KB), T-2-007 (lead-resolver+attribution+consent), T-2-009 (Turnstile)
  Onda 2: T-2-004/005/011 (tracker 3.04KB), T-2-006 (processor), T-2-008/010 (lead_token real+middleware)
  Onda 3: T-2-012 (34 testes FLOW-02/07/08)

Sprint 3: EM EXECUÇÃO (2026-05-02)
  Pré-onda: schema workspace_integrations (migration 0021) + workspace_integrations.guru_api_token
  Onda 0: dispatch.ts (createDispatchJobs, processDispatchJob, markDeadLetter, requeueDeadLetter, createSkippedJob, computeIdempotencyKey, computeBackoff)
  Onda 1: Meta CAPI dispatcher (T-3-001 mapper, T-3-002 client, T-3-003 eligibility)
  Onda 2: Adapter Digital Manager Guru — mapper + types + rota POST /v1/webhook/guru (T-3-004)
  Pendente: Dispatch worker CF Queue consumer (T-3-007), backoff+DLQ (T-3-008), E2E FLOW-03/04 (T-3-009)
  OQ-011 FECHADA: resolvida via tabela workspace_integrations + adapter Guru
  REMOVIDO: Hotmart, Kiwify, Stripe → movidos para Sprint 9
```

### Escopo Sprint 3 — contexto chave

**Adapter Guru** (`POST /v1/webhook/guru`):
- Autenticação por `api_token` no body JSON (sem HMAC) — diferente de todos os outros provedores
- Resolve `workspace_id` via lookup em `workspace_integrations.guru_api_token`
- Exige nova coluna `guru_api_token` em `workspace_integrations` (migration + schema)
- Spec completa: `docs/40-integrations/13-digitalmanager-guru-webhook.md`
- Contrato: `docs/30-contracts/04-webhook-contracts.md`

**OQ-011** — dispatch_jobs no ingestion processor precisa de tabela de config de integrações por workspace (ponto de entrada para T-3-001+).

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Migration 0020 (FK ad_spend_daily→launches) | **aplicada** | — |
| Smoke E2E (T-1-021) | escrita, não executada | descomentar `localConnectionString` no `wrangler.toml` + `wrangler dev` |
| Secrets produção | não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `TURNSTILE_SECRET_KEY` |

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-024 em `docs/90-meta/04-decision-log.md`
- OQ-007 FECHADA: `lead_token` stateful (tabela `lead_tokens`)
- OQ-004 FECHADA → ADR-024: Cloudflare Turnstile em `/v1/lead`

### Secrets — onde estão

- `.env.local` na raiz (gitignored): `LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `DATABASE_URL`, chaves Supabase, IDs CF, `HYPERDRIVE_CONFIG_ID`
- `apps/edge/.dev.vars` (gitignored): `LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `DATABASE_URL`
- Produção: secrets **não** deployados ainda

### Como retomar em nova sessão

1. Ler este §5 + `git log -5` + `git status`
2. Abrir `docs/80-roadmap/03-sprint-3-meta-capi-webhooks.md`
3. Verificar OQ-011 — config de integrações por workspace (depende do adapter Guru e do Meta CAPI)
4. Decompor em ondas + despachar subagents conforme `CLAUDE.md §2`

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `bd6ff23` — docs Sprint 3 + protótipos |
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
