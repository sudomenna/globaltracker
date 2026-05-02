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
Estado:        SPRINT 1 COMPLETO — pronto para iniciar Sprint 2
Último commit: 79ec7d4 (branch main)
Verificação:   typecheck ✓  lint ✓  248 testes passando

Sprint 0: COMPLETO
Sprint 1: COMPLETO — todas as 7 ondas entregues
  Onda 1–5: schema, helpers, middleware
  Onda 6:   endpoints HTTP (config, events, lead, redirect, admin SAR)
  Onda 7:   smoke E2E (T-1-021) + load test k6 RNF-001 (T-1-022)

Próximo: Sprint 2 — runtime de tracking
  Ler docs/80-roadmap/02-sprint-2-runtime-tracking.md para decompor ondas
```

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Migration 0020 (FK ad_spend_daily→launches) | criada, não aplicada | `supabase db push` |
| Smoke E2E (T-1-021) | escrita, não executada | descomentar `localConnectionString` no `wrangler.toml` + `wrangler dev` |
| Secrets produção | gerados localmente, não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET` e `wrangler secret put PII_MASTER_KEY_V1` |
| Turnstile (ADR-024) | decidido, não implementado | implementar no Sprint 2 antes do go-live de `/v1/lead` |

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
