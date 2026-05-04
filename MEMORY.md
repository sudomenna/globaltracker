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
| Sprint 9 | **completed** (2026-05-04, commit ded8fd2) | `docs/80-roadmap/09-sprint-9-funil-ux-hardening.md` |
| Sprint 10 | **completed** (2026-05-04, commit ac93148) | `docs/80-roadmap/10-sprint-10-funil-templates-scaffolding.md` |
| Sprint 11 | **completed** (2026-05-04, commit 165855c) | `docs/80-roadmap/11-sprint-11-funil-webhook-guru.md` |
| Sprint 12 | **planned** (realocado) | `docs/80-roadmap/12-sprint-12-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 11 COMPLETO (2026-05-04)
Último commit: 165855c (branch main, não pushado)
Branch:        main
Verificação:   typecheck ✓ (só pré-existentes CP) | test 1508/1509 ✓ (1 pré-existente)
DB Supabase:   migrations 0000–0029 aplicadas ✓ (sem migration nova no Sprint 11)
DEV_WORKSPACE: 74860330-a528-4951-bf49-90f0b5c72521 (Outsiders Digital)
Próxima ação:  SPRINT 12 — Webhooks Hotmart/Kiwify/Stripe
                Ver docs/80-roadmap/12-sprint-12-webhooks-hotmart-kiwify-stripe.md
```

### Plano canônico de sprints restantes

- **Sprint 12** — Webhooks Hotmart/Kiwify/Stripe. Ver [`12-sprint-12-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/12-sprint-12-webhooks-hotmart-kiwify-stripe.md).

### O que foi entregue nos Sprints 9 e 10

**Sprint 9 (T-FUNIL-001..007):**
- UI de criação de launch com type/objective/dates
- Page role defaults + EventConfig schema (`{ canonical, custom }`)
- Tab Eventos no launch detail com GET /v1/events?launch_id + autorefresh
- Auditoria corrigiu: launch_id aceita slug (não UUID), campo `lead_id` na resposta

**Sprint 10 (T-FUNIL-010..017):**
- Migration 0029: tabela `funnel_templates` + `launches.funnel_blueprint` + `launches.funnel_template_id`
- 4 presets globais (`lancamento_gratuito_3_aulas`, `lancamento_pago_workshop_com_main_offer`, `lancamento_pago_workshop_apenas`, `evergreen_direct_sale`)
- `GET /v1/funnel-templates` + `GET /v1/funnel-templates/:slug`
- `funnel-scaffolder.ts`: `scaffoldLaunch()` — pages + audiences em transação, idempotente
- `POST /v1/launches` aceita `funnel_template_slug` → scaffold via `waitUntil`
- `PATCH /v1/launches/:id` — atualiza `funnel_blueprint`
- `GET /v1/launches` agora inclui `funnel_blueprint`
- `raw-events-processor`: cache de blueprint (60s TTL) + `matchesStageFilters()` + fallback hardcoded
- CP: seletor de template (4 cards) no form de criação + tab Funil + `/funnel` editor de stages

### Pendências técnicas (não bloqueiam Sprint 11)

| Item | Detalhe |
|---|---|
| `tracker.js` CDN | Servir `apps/tracker/dist/tracker.js` via CF Worker dedicado |
| `auth-cp.ts` JWT | `DEV_WORKSPACE_ID` hardcoded em dev. Prod precisa JWT validation |
| GA4 `no_client_id` | GA4 requer `_ga` cookie — leads sem browser não têm client_id. OQ-012 aberta |
| TS pré-existentes CP | 3 erros em `layout.tsx` / `use-workspace.ts` (Supabase relation type inference) |

### Pendências operacionais

| Item | Status |
|---|---|
| Secrets produção (todos os sprints) | não deployados — ver lista completa na última sessão |
| Migration 0029 Supabase | ✅ aplicada (supabase db push 2026-05-04) |

### Notas técnicas invariantes

- `DATABASE_URL ?? HYPERDRIVE?.connectionString ?? ''` — padrão obrigatório em todas as rotas
- Duas pastas de migrations: `packages/db/migrations/0NNN_*.sql` E `supabase/migrations/20260502000NNN_*.sql`
- RLS dual-mode: `NULLIF(current_setting('app.current_workspace_id', true), '')::uuid OR public.auth_workspace_id()`
- Biome varre `.claude/worktrees/` — limpar com `git worktree remove -f <path>` após uso
- `<dialog open>` nativo (não `div role="dialog"`) nos componentes CP
- OXC parse error em type aliases multi-linha → usar `Record<string, unknown>`

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-025 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto
- OQ-013 FECHADA → ADR-025: dispatch-replay cria novo job filho

### Como retomar em nova sessão

```
1. Ler este §5
2. git log -5 + git status (confirmar branch main + commit ac93148)
3. Abrir docs/80-roadmap/11-sprint-11-funil-webhook-guru.md
4. pnpm typecheck && pnpm test (verde exceto 1 pré-existente)
5. Decompor Sprint 11 por onda, conforme CLAUDE.md §3
```

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Último commit | `ac93148` |
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
