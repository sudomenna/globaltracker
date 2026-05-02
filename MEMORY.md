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

- `POST /v1/dispatch-jobs/:id/replay`: contrato em `docs/30-contracts/05-api-server-actions.md` especifica 202 + `{ new_job_id, status: 'queued' }` + body `{ justification }`, mas implementação em `apps/edge/src/routes/dispatch-replay.ts` retorna 200 + `{ queued, job_id, destination }` + body `{ reason }`. Correção planejada antes da onda 3 ou como T-ID isolada.

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
| Sprint 7 | **completed** (2026-05-02, commit bd44b7f) | `docs/80-roadmap/07-sprint-7-orchestrator.md` |
| Sprint 8 | planned | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |
| Sprint 9 | planned | `docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 7 — COMPLETO (todas as 5 ondas)
Último commit: bd44b7f (branch main) — Sprint 7 onda 5 (BR audit fixes)
Verificação:   typecheck ✓  lint ✓  1297 testes passando
DB Supabase:   migrations 0000–0024 aplicadas ✓ | 0025_orchestrator PENDENTE de apply
```

### Sprint 7 — progresso por onda

| Onda | T-IDs | Status | Commit |
|---|---|---|---|
| 0 | T-7-000 | ✓ | fee6142 |
| 1 | T-7-001, T-7-002, T-7-003 | ✓ | fee6142 |
| 2 | T-7-004, T-7-005, T-7-006 | ✓ | 81e8388 |
| 3 | T-7-007, T-7-008, T-7-009 | ✓ | 292fdec |
| 4 | T-7-010 | ✓ | 2ebaf3a |
| 5 | T-7-011 | ✓ | bd44b7f |

### O que foi entregue (histórico completo)

**Onda 0 — T-7-000**
- `docs/30-contracts/05-api-server-actions.md` — 6 contratos do Orchestrator API
- `docs/30-contracts/01-enums.md` — WorkflowName, WorkflowStatus, LpDeploymentStatus, CampaignProvisionStatus

**Onda 1 — T-7-001/002/003**
- `packages/db/src/schema/orchestrator.ts` — 3 tabelas: `workflow_runs`, `lp_deployments`, `campaign_provisions`
- `packages/db/migrations/0025_orchestrator.sql` + `supabase/migrations/20260502000025_orchestrator.sql`
- `apps/orchestrator/` — Trigger.dev 3.3.17, trigger.config.ts, 4 task stubs
- `apps/lp-templates/` — Astro 4.x output:static, template capture, `_headers` CF Pages

**Onda 2 — T-7-004/005/006**
- `apps/edge/src/routes/orchestrator.ts` — 4 endpoints (trigger, status, approve, rollback) + mount
- `tests/integration/routes/orchestrator.test.ts` — 15 testes
- `apps/orchestrator/src/tasks/setup-tracking.ts` — impl real (INV-LAUNCH-003, INV-PAGE-004, INV-PAGE-006)
- `apps/orchestrator/src/tasks/deploy-lp.ts` — impl real (CF Pages API, lp_deployments)

**Onda 3 — T-7-007/008/009**
- `apps/orchestrator/src/tasks/provision-campaigns.ts` — cria Meta Ad Set paused + Google (mock); wait.for(72h); ativa após resume; idempotente via rollback_payload
- `apps/orchestrator/src/tasks/rollback-provisioning.ts` — idempotent DELETE Meta Ad Set; Google mock; status rolled_back
- `apps/control-plane/src/app/(app)/orchestrator/` — 3 telas: lista, detalhe ([run_id]), novo; sidebar entry "Workflows" (GitBranch icon)

### Próxima onda (onda 4) — T-7-010

| T-ID | Tipo | Subagent | Ownership |
|---|---|---|---|
| T-7-010 | test | globaltracker-test-author | `tests/unit/orchestrator/**`, `tests/integration/orchestrator/**` |

**Critério:** ≥30 novos testes cobrindo: transitions de status em workflow_runs, campaign_provisions state machine, rollback idempotência, audit entries. `pnpm test` verde.

**Contexto para T-7-010:**
- Tasks implementadas: setup-tracking, deploy-lp, provision-campaigns, rollback-provisioning
- Edge routes: `apps/edge/src/routes/orchestrator.ts` (trigger, status, approve, rollback)
- Schema: `packages/db/src/schema/orchestrator.ts`
- Testes existentes (não duplicar): `tests/integration/routes/orchestrator.test.ts` (15 testes)

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Migration 0025_orchestrator | **não aplicada** | `supabase db push` ou aplicar manualmente no Supabase dashboard |
| Smoke E2E (T-1-021) | escrita, não executada | `wrangler dev` com `localConnectionString` |
| Secrets produção (base) | não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET PII_MASTER_KEY_V1 TURNSTILE_SECRET_KEY` |
| Secrets Sprint 4 (cost/google/ga4) | não deployados | `META_ADS_ACCOUNT_ID META_ADS_ACCESS_TOKEN GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_CURRENCY GA4_MEASUREMENT_ID GA4_API_SECRET FX_RATES_PROVIDER` |
| Secrets Sprint 5 (audience) | não deployados | `META_CUSTOM_AUDIENCE_TOKEN META_DEFAULT_AD_ACCOUNT_ID` |
| Secrets Sprint 7 (orchestrator) | não deployados | `TRIGGER_SECRET_KEY DATABASE_URL CF_PAGES_API_TOKEN CF_ACCOUNT_ID` |
| dispatch-replay shape | SYNC-PENDING | Alinhar implementação com contrato (ver §2) |

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-024 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto no checkout (não bloqueia Sprint 7)

### Notas técnicas

**Trigger.dev 3.x (Sprint 7)**
- SDK 3.3.17 instalado em `apps/orchestrator/`
- `trigger.config.ts` com `project: 'globaltracker'`, `dirs: ['./src/tasks']`, `maxDuration: 300`
- Tasks conectam ao DB via `DATABASE_URL` env var (não Hyperdrive — tasks rodam em Node.js, não CF Workers)
- Aprovação humana: task usa `wait.for({ event: ... })`; edge `/approve` envia evento via Trigger.dev Management API (`POST https://api.trigger.dev/api/v1/runs/{triggerRunId}/...`)

**CF Pages (Sprint 7)**
- Deploy via CF Pages REST API (`POST /client/v4/accounts/{account_id}/pages/projects`)
- Graceful fallback quando `CF_PAGES_API_TOKEN`/`CF_ACCOUNT_ID` ausentes (retorna URL mock para dev/testes)
- Template `apps/lp-templates/src/templates/capture/index.astro` injeta tracker.js via `<script data-page-id data-workspace-id>`

**OXC + Biome (para subagents de teste)**
`typeof import('long/path')` em type aliases multi-linha → parse error no OXC.
Fix: `Record<string, unknown>` como cast intermediário em `vi.mock` factories.

**Dois diretórios de migrations**
Ao criar em `packages/db/migrations/0NNN_*.sql`, copiar para `supabase/migrations/20260502000NNN_*.sql`.

**A11y nos componentes CP**
Padrão de `<dialog open>` nativo (não `div role="dialog"`) estabelecido na Sprint 6. Overlay `aria-hidden` com biome-ignore `useKeyWithClickEvents`. Usar `<output>` no lugar de `div role="status"`.

**Biome scanning worktrees**
Biome varre `.claude/worktrees/` se deixado. Remover worktrees com `git worktree remove -f -f <path>` após extrair arquivos. Se locked, usar `-f -f` (duplo force).

### Como retomar em nova sessão

```
1. Ler este §5 (estado sprint + próxima onda)
2. git log -5 + git status (confirmar branch main + commit 81e8388)
3. Abrir docs/80-roadmap/07-sprint-7-orchestrator.md (tabela mestre + critérios onda 3)
4. Despachar T-7-007, T-7-008, T-7-009 em paralelo (ver "Próxima onda" acima)
5. Verificar pnpm typecheck && pnpm lint && pnpm test antes de continuar
```

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `292fdec` — Sprint 7 onda 3 |
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
