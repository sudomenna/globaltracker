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

2026-05-01 — Supabase em cloud (não local). Projeto `globaltracker`, ref `kaxcmhfaqrxwnpftkslj`, sa-east-1, org CNE Ltda. Mover para ADR se persistir.

## §4 Estado dos sprints — fontes canônicas

| Sprint | Status | Fonte canônica |
|---|---|---|
| Sprint 0 | **completed** (2026-05-01, commit `0d0d42b`) | `docs/80-roadmap/00-sprint-0-foundations.md` |
| Sprint 1 | planned | `docs/80-roadmap/01-sprint-1-fundacao-dados-contratos.md` |
| Sprint 2 | planned | `docs/80-roadmap/02-sprint-2-runtime-tracking.md` |
| Sprint 3 | planned | `docs/80-roadmap/03-sprint-3-meta-capi-webhooks.md` |
| Sprint 4 | planned | `docs/80-roadmap/04-sprint-4-analytics-google.md` |
| Sprint 5 | planned | `docs/80-roadmap/05-sprint-5-audience-multitouch.md` |
| Sprint 6 | planned | `docs/80-roadmap/06-sprint-6-control-plane.md` |
| Sprint 7 | planned | `docs/80-roadmap/07-sprint-7-orchestrator.md` |
| Sprint 8 | planned | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 1 — Ondas 1 e 2 concluídas; pronto para Onda 3
Sprint 0:      COMPLETO — monorepo, packages/shared, packages/db, apps/edge, CI, Supabase
Sprint 1:      EM ANDAMENTO
  Onda 1 ✓    T-1-001 — Schema MOD-WORKSPACE + RLS (workspaces, workspace_members, workspace_api_keys)
  Onda 2 ✓    T-1-002 (MOD-LAUNCH), T-1-004 (MOD-IDENTITY x5), T-1-010 (MOD-COST), T-1-012 (MOD-AUDIT)
  Migrations: aplicadas no Supabase (supabase db push) — 5 migrations (0001..0012)
  Onda 3:     T-1-003, T-1-006, T-1-007, T-1-009, T-1-011, T-1-013 (próxima)
Repo Git:      https://github.com/sudomenna/globaltracker (privado, branch main)
Próximo passo: Sprint 1 — Onda 3
```

### Ondas Sprint 1 — status

| Onda | T-IDs | Status |
|---|---|---|
| 1 | T-1-001 | ✓ DONE |
| 2 | T-1-002, T-1-004, T-1-010, T-1-012 | ✓ DONE |
| 3 | T-1-003, T-1-006, T-1-007, T-1-009, T-1-011, T-1-013 | próxima |
| 4 | T-1-005, T-1-008, T-1-014 | pendente |
| 5 | T-1-015 | pendente |
| 6 | T-1-016–T-1-020 | pendente |
| 7 | T-1-021, T-1-022 | pendente |

### Pendências antes de Sprint 2

| Pendência | Detalhe |
|---|---|
| OQ-004 (bot mitigation) | Bloqueia `/v1/lead` em produção. Recomendação: honeypot+timing. Ver [OQ-004](docs/90-meta/03-open-questions-log.md). |
| FK `ad_spend_daily.launch_id` | Sem FK por ora (paralelo). Adicionar em T-1-005 ou migration separada. |

### Secrets — onde estão

- `.env.local` na raiz (fora do git): `LEAD_TOKEN_HMAC_SECRET`, `PII_MASTER_KEY_V1`, `DATABASE_URL`, chaves Supabase, IDs Cloudflare
- `apps/edge/.dev.vars`: vazio — preencher com valores de `.env.local` antes de `wrangler dev`
- Produção: `wrangler secret put LEAD_TOKEN_HMAC_SECRET` + `wrangler secret put PII_MASTER_KEY_V1` (ainda não feito)

### Hyperdrive — pendente

Configurar após Sprint 1 (precisa do Supabase connection pooler URL). Por enquanto `apps/edge` não conecta ao DB.

### Como retomar em nova sessão

1. Ler este §5 + `git log -5` + `git status`
2. Abrir `docs/80-roadmap/01-sprint-1-fundacao-dados-contratos.md`
3. Identificar Onda 1 do Sprint 1 e despachar subagents

### Decisões já tomadas (não reabrir)

- OQ-007 FECHADA: `lead_token` **stateful** (tabela `lead_tokens`) — LGPD/SAR exige revogação granular
- ADR-001 a ADR-023 em `docs/90-meta/04-decision-log.md`

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `0d0d42b` — Sprint 0 foundations |
| Supabase project | `kaxcmhfaqrxwnpftkslj` (globaltracker, sa-east-1, org CNE) |
| Cloudflare account | `118836e4d3020f5666b2b8e5ddfdb222` (cursonovaeconomia@gmail.com) |
| CF KV (prod) | `c92aa85488a44de6bdb5c68597881958` |
| CF KV (preview) | `59d0cf1570ca499eb4597fc5218504c2` |
| CF Queues | `gt-events`, `gt-dispatch` |
| Wrangler | 4.87.0 (global, pnpm) |
| Supabase CLI | 2.90.0 (logado na conta CNE) |
| Node | 20 LTS |
| pnpm | 10.x |
| Routine agendada | `trig_01EANpqAPYZh3f4GY3ADgpyX` — review pré-flight UX specs em 2026-05-08 12:00 UTC |

## Política de uso

- `MEMORY.md` é volátil — pode ser limpa entre sessões.
- Decisões importantes migram para `docs/90-meta/04-decision-log.md` (ADR).
- OQs migram para `docs/90-meta/03-open-questions-log.md`.
- Não duplique aqui o que já está em ADR/OQ — referencie.
