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
| Sprint 6 | **completed** (2026-05-02, commit e613140) | `docs/80-roadmap/06-sprint-6-control-plane.md` |
| Sprint 7 | **completed** (2026-05-02, commit bd44b7f) | `docs/80-roadmap/07-sprint-7-orchestrator.md` |
| Sprint 8 | **completed** (2026-05-02, commit 4c72732) | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |
| Sprint 9 | planned | `docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 8 COMPLETO + todas pendências §2 fechadas (2026-05-03)
Último commit: c146eaa (branch main) — docs(contract): token_hash algorithm
Branch:        main (~26 commits à frente de origin/main — não pushado)
Verificação:   typecheck ✓ (db/shared/edge)  1352 testes passando [+2 novos] (1 falha pré-existente em integrations-test .strict())
DB Supabase:   migrations 0000–0027 aplicadas ✓ (0027: workspaces.config jsonb)
DEV_WORKSPACE: 74860330-a528-4951-bf49-90f0b5c72521 (Outsiders Digital)
Próxima ação:  SPRINT 9 — docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md
```

### Pendências técnicas identificadas em sessão de teste (2026-05-03)

| Item | Status | Detalhe |
|---|---|---|
| `tracker.js` CDN — Cloudflare Worker dedicado | **pendente** | Servir `apps/tracker/dist/tracker.js` via CF Worker com cache headers corretos. URL atual no snippet usa R2 público. Solução elegante: Worker próprio. |
| `POST /v1/pages` — persistência no DB | ✅ **implementado (2026-05-03)** | `routes/pages.ts` persiste em `pages` + `page_tokens` via Drizzle + `DATABASE_URL`. |
| `POST /v1/launches` — persistência no DB | ✅ **implementado (2026-05-03)** | `routes/launches.ts` persiste em `launches` via Drizzle + `DATABASE_URL`. |
| `GET/PATCH /v1/onboarding/state` — persistência no DB | ✅ **implementado (2026-05-03)** | `routes/onboarding-state.ts` persiste em `workspaces.onboarding_state` via Drizzle + `DATABASE_URL`. Merge feito em JS (não SQL). |
| auth-cp.ts — middleware JWT Supabase | **pendente produção** | Opção B ativa: `DEV_WORKSPACE_ID` hardcoded em `wrangler.toml` (local dev). Opção A para prod: criar `auth-cp.ts` que valida JWT Supabase → extrai `sub` → `SELECT workspace_id FROM workspace_members WHERE user_id = $sub`. Remover fallback `DEV_WORKSPACE_ID` nas rotas. |
| Bugs corrigidos em sessão — COMMITADOS | ✅ **commit 0a6c3ca (2026-05-03)** | Tudo commitado. |
| `.dev.vars` — `DATABASE_URL` correto | ✅ **corrigido (2026-05-03)** | Senha `//` → `%2F%2F` (URL-encode); scheme `postgresql://` → `postgres://`. Necessário porque `postgres.js` CF bundle usa `new URL()` para parse — falha com `//` literal em senha. Nota: `.dev.vars` não entra no git (gitignored). |
| `docs/30-contracts/05-api-server-actions.md` | ✅ **atualizado (2026-05-03)** | Adicionado `POST /v1/launches`, `GET /v1/launches`, `POST /v1/pages` (eram contratos não documentados). |
| Persistência creds wizard → dispatchers | ✅ **commit 3cb3c0a (2026-05-03)** | `workspaces.config.integrations.{meta,ga4}` alimentado pelo wizard step='complete'. Dispatchers leem com fallback env vars. migration 0027 aplicada. |

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Migration 0025_orchestrator | ✅ aplicada (2026-05-02) | — |
| Migration 0026_test_mode_replay | ✅ aplicada (2026-05-02) | — |
| Smoke E2E (T-1-021) | escrita, não executada | `wrangler dev` com `localConnectionString` |
| Secrets produção (base) | não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET PII_MASTER_KEY_V1 TURNSTILE_SECRET_KEY` |
| Secrets Sprint 4 (cost/google/ga4) | não deployados | `META_ADS_ACCOUNT_ID META_ADS_ACCESS_TOKEN GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_CURRENCY GA4_MEASUREMENT_ID GA4_API_SECRET FX_RATES_PROVIDER` |
| Secrets Sprint 5 (audience) | não deployados | `META_CUSTOM_AUDIENCE_TOKEN META_DEFAULT_AD_ACCOUNT_ID` |
| Secrets Sprint 7 (orchestrator) | não deployados | `TRIGGER_SECRET_KEY DATABASE_URL CF_PAGES_API_TOKEN CF_ACCOUNT_ID` |
| Secret Sprint 8 (test mode) | não deployado | `META_CAPI_TEST_EVENT_CODE` |

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-025 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto no checkout (não bloqueia Sprint 9)
- OQ-013 FECHADA → ADR-025: dispatch-replay cria novo job filho

### Sprint 8 — entregas (referência rápida)

| T-ID | Entregável |
|---|---|
| T-8-001 | schema: `events.is_test boolean` + `dispatch_jobs.replayed_from_dispatch_job_id uuid`; migration 0026 |
| T-8-002 | `apps/edge/src/lib/test-mode.ts` — KV TTL 1h, header `X-GT-Test-Mode`, cookie `__gt_test` |
| T-8-003 | `POST/GET /v1/workspace/test-mode` + audit log |
| T-8-004 | Propagação `events.is_test` via rawPayload no ingestion |
| T-8-005 | Dispatchers: Meta usa `test_event_code`; GA4 usa debug endpoint; Google Ads faz skip |
| T-8-006 | 54 novos testes (1351 total) |
| T-8-007 | Live Event Console — Supabase Realtime + TanStack Virtual, rolling 100 eventos |
| T-8-008 | Test Mode Toggle UI — AlertDialog + countdown + filtro `is_test=true` |
| T-8-009 | dispatch-replay refatorado (ADR-025): cria job filho, retorna 202 |
| T-8-010 | `ReplayModal.tsx` — justificativa obrigatória, badge REPLAY |

### Notas técnicas relevantes para Sprint 9

**Test Mode (Sprint 8)**
- KV key: `workspace_test_mode:<workspace_id>`, TTL 1h
- Edge detecta `X-GT-Test-Mode: 1` header ou `__gt_test=1` cookie
- CP: `/launches/[launch_public_id]/events/live` — Live Console
- Google Ads e Enhanced Conversions fazem skip com `reason='test_mode'` (sem sandbox nessas APIs)

**Trigger.dev 3.x (Sprint 7)**
- SDK 3.3.17 instalado em `apps/orchestrator/`
- Tasks conectam ao DB via `DATABASE_URL` env var (não Hyperdrive — Node.js, não CF Workers)
- Tests devem ficar em `apps/orchestrator/src/tasks/__tests__/` (pnpm não hoist `@trigger.dev/sdk/v3`)

**CF Pages (Sprint 7)**
- Deploy via CF Pages REST API
- Template `apps/lp-templates/src/templates/capture/index.astro` injeta tracker.js

**Dois diretórios de migrations**
- Ao criar em `packages/db/migrations/0NNN_*.sql`, copiar para `supabase/migrations/20260502000NNN_*.sql`

**A11y nos componentes CP**
- Padrão de `<dialog open>` nativo (não `div role="dialog"`)
- Usar `<output>` no lugar de `div role="status"`

**OXC + Biome**
- `typeof import('long/path')` em type aliases multi-linha → parse error no OXC. Fix: `Record<string, unknown>`
- Biome varre `.claude/worktrees/` — remover worktrees com `git worktree remove -f -f <path>` após uso

**`*.tsbuildinfo`**
- Adicionado ao `.gitignore` raiz em a616726 — não commitar

### Notas técnicas — DB no CF Worker (local dev)

- `c.env.HYPERDRIVE.connectionString` em `wrangler dev` local retorna URL proxy inválida para `postgres.js` (não é PostgreSQL real)
- Usar `c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString` em todas as rotas CP
- `DATABASE_URL` em `.dev.vars`: esquema `postgres://` (não `postgresql://`), senha com `%2F%2F` em vez de `//`
- JSONB merge via SQL `||` com Drizzle sql template tem bug de encoding (parâmetro vira string scalar → array no DB). Fix: SELECT → merge JS → UPDATE com objeto plano.

### Como retomar em nova sessão

```
1. Ler este §5 (estado atual)
2. git log -5 + git status (confirmar branch main + commit a616726)
3. Abrir docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md (próximo sprint)
4. Verificar pnpm typecheck && pnpm test antes de iniciar
5. Decompor Sprint 9 conforme protocolo de paralelização (CLAUDE.md §3)
```

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `a616726` — chore: .gitignore tsbuildinfo |
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
