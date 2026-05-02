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

- `POST /v1/dispatch-jobs/:id/replay`: OQ-013 **FECHADA** → ADR-025 (Opção A). Route refatorada para criar job filho em T-8-009. SYNC resolvido.

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
| Sprint 8 | **completed** (2026-05-02, commit pendente) | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |
| Sprint 9 | planned | `docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 8 COMPLETO — commit feito, migration 0026 aplicada
Último commit: 62e5659 (branch main) — Sprint 7 completed (Sprint 8 não commitado ainda)
Branch:        main (17 commits à frente de origin/main — não pushado)
Verificação:   typecheck ✓  lint ✓  1351 testes passando (82 test files)
DB Supabase:   migrations 0000–0026 aplicadas ✓
```

### Sprint 8 — estado das T-IDs

| T-ID | Status | Descrição |
|---|---|---|
| T-8-001 | ✅ done | schema: events.isTest + dispatch_jobs.replayedFromDispatchJobId + migration 0026 |
| T-8-002 | ✅ done | lib/test-mode.ts (helpers KV + detecção header/cookie) |
| T-8-003 | ✅ done | routes POST/GET /v1/workspace/test-mode + audit log |
| T-8-004 | ✅ done | propagação is_test no events.ts + raw-events-processor |
| T-8-005 | ✅ done | dispatchers: Meta test_event_code, GA4 debug, Google Ads skip(test_mode) |
| T-8-006 | ✅ done | 54 novos testes (detection, kv, routes, propagation) |
| T-8-007 | ✅ done | Live Event Console UI (Supabase Realtime + TanStack Virtual) |
| T-8-008 | ✅ done | Test Mode Toggle UI (AlertDialog + countdown + filtro is_test) |
| T-8-009 | ✅ done | dispatch-replay refatorado → cria job filho (ADR-025) |
| T-8-010 | ✅ done | Replay modal UI no CP (ReplayModal.tsx) |

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Migration 0025_orchestrator | ✅ aplicada (2026-05-02) | — |
| Smoke E2E (T-1-021) | escrita, não executada | `wrangler dev` com `localConnectionString` |
| Secrets produção (base) | não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET PII_MASTER_KEY_V1 TURNSTILE_SECRET_KEY` |
| Secrets Sprint 4 (cost/google/ga4) | não deployados | `META_ADS_ACCOUNT_ID META_ADS_ACCESS_TOKEN GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_CURRENCY GA4_MEASUREMENT_ID GA4_API_SECRET FX_RATES_PROVIDER` |
| Secrets Sprint 5 (audience) | não deployados | `META_CUSTOM_AUDIENCE_TOKEN META_DEFAULT_AD_ACCOUNT_ID` |
| Secrets Sprint 7 (orchestrator) | não deployados | `TRIGGER_SECRET_KEY DATABASE_URL CF_PAGES_API_TOKEN CF_ACCOUNT_ID` |
| Migration 0026 (Sprint 8) | ✅ aplicada (2026-05-02) | — |
| dispatch-replay shape | ✅ OQ-013 → ADR-025 | T-8-009 concluída — cria job filho |

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-025 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto no checkout (não bloqueia Sprint 8)

### Notas técnicas

**Trigger.dev 3.x (Sprint 7)**
- SDK 3.3.17 instalado em `apps/orchestrator/`
- `trigger.config.ts` com `project: 'globaltracker'`, `dirs: ['./src/tasks']`, `maxDuration: 300`
- Tasks conectam ao DB via `DATABASE_URL` env var (não Hyperdrive — tasks rodam em Node.js, não CF Workers)
- Aprovação humana: task usa `wait.for({ seconds: 72*3600 })`; edge `/approve` envia evento via Trigger.dev Management API

**CF Pages (Sprint 7)**
- Deploy via CF Pages REST API (`POST /client/v4/accounts/{account_id}/pages/projects`)
- Graceful fallback quando `CF_PAGES_API_TOKEN`/`CF_ACCOUNT_ID` ausentes (retorna URL mock)
- Template `apps/lp-templates/src/templates/capture/index.astro` injeta tracker.js via `<script data-page-id data-workspace-id>`

**Testes em apps/orchestrator (aprendizado Sprint 7)**
- Tests devem ficar em `apps/orchestrator/src/tasks/__tests__/` (não root `tests/`) — pnpm não hoist `@trigger.dev/sdk/v3`
- `vi.mock('@trigger.dev/sdk/v3', () => ({ task: (config) => config, ... }))` — task mock retorna config diretamente para expor `.run`
- `vi.hoisted()` obrigatório para mocks usados dentro de `vi.mock()` factories
- `process.env.X = undefined` em Node.js vira string `"undefined"` — usar `process.env.X = ""` para unset
- `Object.assign(Promise.resolve(result), { limit: vi.fn()... })` para chains Drizzle que terminam em `.where()` ou `.limit()`
- `biome-ignore` deve estar na linha DIRETAMENTE acima da linha com a violação (não funciona em statements multi-linha)

**OXC + Biome**
- `typeof import('long/path')` em type aliases multi-linha → parse error no OXC. Fix: `Record<string, unknown>`
- Biome varre `.claude/worktrees/` — remover worktrees com `git worktree remove -f -f <path>` após uso

**Dois diretórios de migrations**
- Ao criar em `packages/db/migrations/0NNN_*.sql`, copiar para `supabase/migrations/20260502000NNN_*.sql`

**A11y nos componentes CP**
- Padrão de `<dialog open>` nativo (não `div role="dialog"`)
- Overlay `aria-hidden` com `biome-ignore useKeyWithClickEvents`
- Usar `<output>` no lugar de `div role="status"`

### Como retomar em nova sessão

```
1. Ler este §5 (estado atual)
2. git log -5 + git status (confirmar branch main — Sprint 8 não commitado ainda)
3. Aplicar migration 0026 no Supabase antes de qualquer deploy
4. Verificar pnpm typecheck && pnpm test (deve estar verde: 1351 testes)
5. Sprint 9 planejado em docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md
```

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `62e5659` — MEMORY.md Sprint 7 completed |
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
