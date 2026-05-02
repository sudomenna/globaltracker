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
| Sprint 2 | planned | `docs/80-roadmap/02-sprint-2-runtime-tracking.md` |
| Sprint 3 | planned | `docs/80-roadmap/03-sprint-3-meta-capi-webhooks.md` |
| Sprint 4 | planned | `docs/80-roadmap/04-sprint-4-analytics-google.md` |
| Sprint 5 | planned | `docs/80-roadmap/05-sprint-5-audience-multitouch.md` |
| Sprint 6 | planned | `docs/80-roadmap/06-sprint-6-control-plane.md` |
| Sprint 7 | planned | `docs/80-roadmap/07-sprint-7-orchestrator.md` |
| Sprint 8 | planned | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 2 — Onda 1 completa (commit c4adb3f, 2026-05-02)
Verificação:   typecheck ✓  lint ✓  329 testes passando

Sprint 0: COMPLETO
Sprint 1: COMPLETO
Sprint 2: EM ANDAMENTO
  Onda 1 (COMPLETA):
    T-2-001/002/003: apps/tracker/ criado — init, cookies, decorate (2.28 KB gz)
    T-2-007: lead-resolver.ts + attribution.ts + consent.ts
    T-2-009: middleware Turnstile em /v1/lead (ADR-024)
  Onda 2 (PRÓXIMA):
    T-2-004+005+011: tracker.js identify + page + pixel-coexist
    T-2-006: ingestion processor (raw-events-processor.ts)
    T-2-008+010: lead_token real emission + Set-Cookie __ftk + middleware validação
  Onda 3: E2E FLOW-02, FLOW-07, FLOW-08
```

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Migration 0020 (FK ad_spend_daily→launches) | **aplicada** (2026-05-02) | — |
| Smoke E2E (T-1-021) | escrita, não executada | descomentar `localConnectionString` no `wrangler.toml` + `wrangler dev` |
| Secrets produção | gerados localmente, não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET` e `wrangler secret put PII_MASTER_KEY_V1` |
| Turnstile secret | middleware implementado (T-2-009) | `wrangler secret put TURNSTILE_SECRET_KEY` antes do go-live |

### [SYNC-PENDING]

| Item | Prazo |
|---|---|
| `docs/20-domain/13-mod-tracker.md §12`: `pixel-coexist.ts` não criado ainda (Onda 2) | Onda 2 |
| `docs/30-contracts/07-module-interfaces.md`: consent.ts usa `workspace_id` explícito vs `ctx` no contrato | Final Sprint 2 |

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-024 em `docs/90-meta/04-decision-log.md`
- OQ-007 FECHADA: `lead_token` stateful (tabela `lead_tokens`) — revogação SAR
- OQ-004 FECHADA → ADR-024: Cloudflare Turnstile em `/v1/lead`; honeypot no backlog

### Secrets — onde estão

- `.env.local` na raiz (gitignored): `LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `DATABASE_URL`, chaves Supabase, IDs CF, `HYPERDRIVE_CONFIG_ID`
- `apps/edge/.dev.vars` (gitignored): `LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `DATABASE_URL` — populados nesta sessão
- Produção: secrets **não** deployados ainda — rodar `wrangler secret put` antes do go-live

### Como retomar em nova sessão

1. Ler este §5 + `git log -5` + `git status`
2. Abrir `docs/80-roadmap/02-sprint-2-runtime-tracking.md`
3. Identificar T-IDs da Onda 1 do Sprint 2 (parallel-safe)
4. Despachar subagents conforme decision tree em `CLAUDE.md §2`

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `79ec7d4` — Sprint 1 completo + Hyperdrive configurado |
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
