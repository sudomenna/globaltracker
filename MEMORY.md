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
Estado:        PLANO FUNIS APROVADO (2026-05-03 sessão 3) — aguardando início de implementação
Último commit: 0b4a7e4 (branch main)
Branch:        main (não pushado)
Verificação:   typecheck ✓ (edge/control-plane nas mudanças anteriores)
DB Supabase:   migrations 0000–0028 aplicadas ✓ (0028 = RLS auth_workspace_id)
DEV_WORKSPACE: 74860330-a528-4951-bf49-90f0b5c72521 (Outsiders Digital)
Próxima ação:  IMPLEMENTAR Fase 1 do plano em docs/80-roadmap/funil-templates-plan.md (T-FUNIL-001..004)
                Após Fase 1, seguir para Fase 2 (templates + scaffolding) e Fase 3 (webhook Guru contextualizado).
                Sprint 9 (webhooks Hotmart/Kiwify/Stripe) fica para depois desta entrega.
```

### Plano canônico desta entrega

Ver [docs/80-roadmap/funil-templates-plan.md](docs/80-roadmap/funil-templates-plan.md) — plano em 3 fases para suportar Funil A (Lançamento Gratuito 3 Aulas) e Funil B (Lançamento Pago Workshop low ticket + Main Offer high ticket), com templates reutilizáveis, stages customizáveis por launch e webhook Guru contextualizado por launch + funnel_role.

### Mudanças entregues nesta sessão (2026-05-03 sessão 2)

| Área | Entrega |
|---|---|
| **Wizard onboarding** | Step 6 "Capturar leads do formulário" — client-only, gera script `<body>` com inferência automática de campos email/name/phone |
| **Page detail UI** | Card de snippet do body + persistência de `page_token` em `localStorage` (`gt:token:<page_public_id>`) — usuário acessa snippet com token real após onboarding sem rotacionar |
| **Launch lifecycle** | Auto-promoção `draft→configuring` em `pages.ts` (POST page) e `configuring→live` em `events.ts` (via `c.executionCtx.waitUntil`) — idempotente |
| **Launches list** | Agora faz GET real (era `useState([])`); itens clicáveis |
| **Launch detail page** | Nova rota `/launches/[launch_public_id]/page.tsx` com header + status + botão "Eventos ao vivo" + lista de pages |
| **RLS fix sistêmico** | Migration 0028 — função `public.auth_workspace_id()` SECURITY DEFINER + 30 policies reescritas (GUC OR auth-derived). Antes: `app.current_workspace_id` nunca era setado, supabase-js no control-plane via `authenticated` retornava 0 rows. Agora: control-plane Server Components funcionam com RLS real |
| **Live Events Console acessível** | Página `/launches/:id/events/live` agora carrega (Realtime Supabase OK). Bug raiz era a RLS, não a página |
| **Dependência faltando** | `@tanstack/react-virtual` instalado em `apps/control-plane` (era importado em EventConsole.tsx) |

### Pipeline E2E — status verificado em testes locais (2026-05-03)

| Etapa | Status |
|---|---|
| `POST /v1/lead` → 202 + lead_token | ✅ funcionando |
| `raw_events` insert + `processing_status: processed` | ✅ funcionando |
| Queue consumer `gt-events` → `processRawEvent` | ✅ funcionando |
| `events.launch_id` linkado ao launch | ✅ funcionando |
| `events.consent_snapshot.ad_user_data = 'granted'` | ✅ funcionando |
| `leads.email_hash` populado | ✅ funcionando |
| Meta CAPI dispatch | ✅ `succeeded` |
| GA4 dispatch | ✅ `skipped/no_client_id` (esperado sem browser — requer cookie `_ga`) |

### Bugs corrigidos em sessão de teste E2E (2026-05-03) — COMMITADOS

| Bug | Fix | Commit |
|---|---|---|
| `events.ts` raw_events nunca inserido | inline DB insert + raw_event_id no send | 4c482fa |
| `lead.ts` raw_events nunca inserido | inline DB insert + raw_event_id no send | 4c482fa |
| `lead.ts` resolveLeadByAliases nunca chamado | effectiveDb pattern (DATABASE_URL \|\| HYPERDRIVE) | 4c482fa |
| queueHandler sem routing gt-events | roteia por shape `'raw_event_id' in body` | 4c482fa |
| processRawEvent não criava dispatch_jobs | lê workspaces.config.integrations, chama createDispatchJobs | 4c482fa |
| queueHandler usa HYPERDRIVE direto (URL inválida em dev) | DATABASE_URL ?? HYPERDRIVE.connectionString | abbd77f |
| lead.ts payload sem event_name/event_time | constrói processablePayload com campos obrigatórios | abbd77f |
| lead.ts launch_public_id não resolvido para UUID | query launches → launch_id incluído no payload | abbd77f |
| lead.ts consent booleans não normalizados | marketing → ad_user_data/ad_personalization/customer_match = 'granted' | abbd77f |
| lead-resolver.ts email_hash nunca salvo no leads | popula emailHash/phoneHash no INSERT e UPDATE | abbd77f |

### Pendências técnicas

| Item | Status | Detalhe |
|---|---|---|
| `tracker.js` CDN — Cloudflare Worker dedicado | **pendente** | Servir `apps/tracker/dist/tracker.js` via CF Worker com cache headers corretos. |
| `auth-cp.ts` — middleware JWT Supabase | **pendente produção** | `DEV_WORKSPACE_ID` hardcoded ativo em dev. Prod precisa de JWT validation. RLS já está pronta para o caminho via JWT (auth_workspace_id). |
| GA4 dispatch — `no_client_id` em leads via formulário | **design gap** | GA4 requer cookie `_ga` do browser. Leads via formulário sem cookie anterior não têm client_id. OQ-012 aberta. |
| Endpoint manual de transição de status do launch | **gap** | Auto-promoção cobre draft→configuring→live; transições para `ended`/`archived` ainda não têm endpoint nem UI. |
| Erros pré-existentes em `launches/page.tsx` (3x TS18048/TS2345) | **pendente** | Função `useAccessToken` quebra type narrowing. Não bloqueia runtime. |

### Pendências operacionais antes de produção

| Item | Status | Ação necessária |
|---|---|---|
| Secrets produção (base) | não deployados | `wrangler secret put LEAD_TOKEN_HMAC_SECRET PII_MASTER_KEY_V1 TURNSTILE_SECRET_KEY` |
| Secrets Sprint 4 (cost/google/ga4) | não deployados | `META_ADS_ACCOUNT_ID META_ADS_ACCESS_TOKEN GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_CURRENCY GA4_MEASUREMENT_ID GA4_API_SECRET FX_RATES_PROVIDER` |
| Secrets Sprint 5 (audience) | não deployados | `META_CUSTOM_AUDIENCE_TOKEN META_DEFAULT_AD_ACCOUNT_ID` |
| Secrets Sprint 7 (orchestrator) | não deployados | `TRIGGER_SECRET_KEY DATABASE_URL CF_PAGES_API_TOKEN CF_ACCOUNT_ID` |
| Secret Sprint 8 (test mode) | não deployado | `META_CAPI_TEST_EVENT_CODE` |

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-025 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto no checkout (não bloqueia Sprint 9)
- OQ-013 FECHADA → ADR-025: dispatch-replay cria novo job filho

### Como retomar em nova sessão

```
1. Ler este §5 (estado atual)
2. git log -5 + git status (confirmar branch main + commit abbd77f)
3. Abrir docs/80-roadmap/09-sprint-9-webhooks-hotmart-kiwify-stripe.md (próximo sprint)
4. Verificar pnpm typecheck && pnpm test antes de iniciar
5. Decompor Sprint 9 conforme protocolo de paralelização (CLAUDE.md §3)
```

### Notas técnicas relevantes para Sprint 9

**Pipeline E2E (esta sessão)**
- `DATABASE_URL ?? HYPERDRIVE.connectionString` — padrão obrigatório em TODAS as rotas e handlers
- `processablePayload` em `lead.ts`: enriquece payload com `event_name`, `event_time`, `launch_id` UUID, consent normalizado
- `leads.email_hash` e `leads.phone_hash` são denormalizações populadas pelo `lead-resolver.ts` — necessárias para eligibility no dispatcher

**Test Mode (Sprint 8)**
- KV key: `workspace_test_mode:<workspace_id>`, TTL 1h
- Edge detecta `X-GT-Test-Mode: 1` header ou `__gt_test=1` cookie

**Trigger.dev 3.x (Sprint 7)**
- SDK 3.3.17 instalado em `apps/orchestrator/`
- Tasks conectam ao DB via `DATABASE_URL` env var (não Hyperdrive — Node.js, não CF Workers)

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
- Adicionado ao `.gitignore` raiz — não commitar

### Notas técnicas — DB no CF Worker (local dev)

- `c.env.HYPERDRIVE.connectionString` em `wrangler dev` local retorna URL proxy inválida para `postgres.js`
- Usar `DATABASE_URL ?? HYPERDRIVE.connectionString` em TODAS as rotas e handlers
- `DATABASE_URL` em `.dev.vars`: esquema `postgres://` (não `postgresql://`), senha com `%2F%2F` em vez de `//`
- JSONB merge via SQL `||` com Drizzle sql template tem bug de encoding. Fix: SELECT → merge JS → UPDATE com objeto plano.

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `0ff85ab` |
| Supabase project | `kaxcmhfaqrxwnpftkslj` (globaltracker, sa-east-1, org CNE) |
| Cloudflare account | `118836e4d3020f5666b2b8e5ddfdb222` (cursonovaeconomia@gmail.com) |
| CF KV (prod) | `c92aa85488a44de6bdb5c68597881958` |
| CF KV (preview) | `59d0cf1570ca499eb4597fc5218504c2` |
| CF Queues | `gt-events`, `gt-dispatch` |
| Hyperdrive | config `globaltracker-db`, id `39156b974a274f969ca96d4e0c32bce1` |
| Wrangler | 4.87.0 (via npx) |
| Supabase CLI | 2.90.0 (logado na conta CNE) |
| Node | 24.x (v24.10.0) |
| pnpm | 10.x |

## Política de uso

- `MEMORY.md` é volátil — pode ser limpa entre sessões.
- Decisões importantes migram para `docs/90-meta/04-decision-log.md` (ADR).
- OQs migram para `docs/90-meta/03-open-questions-log.md`.
- Não duplique aqui o que já está em ADR/OQ — referencie.
