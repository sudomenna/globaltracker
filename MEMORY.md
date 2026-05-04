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
Estado:        E2E USABILITY TEST EM ANDAMENTO (2026-05-04)
               Sprint 12 PAUSADO — Tiago testa Sprint 0–11 ponta-a-ponta
               como usuário. Pipeline Guru E2E está funcional (bugs corrigidos nesta sessão).
Último commit: ver §7 — working tree inteira commitada nesta sessão
Branch:        main
DB Supabase:   migrations 0000–0030 aplicadas ✓ (0030 = chk_events_event_source + webhook:guru)
DEV_WORKSPACE: 74860330-a528-4951-bf49-90f0b5c72521 (Outsiders Digital)
Servidores:    Wrangler dev :8787 + Next.js dev :3000
Próxima ação:  Fase 0 do teste E2E — disparar eventos via curl; ver §7
```

### Plano canônico de sprints restantes

- **Sprint 12** — Webhooks Hotmart/Kiwify/Stripe. Ver [`12-sprint-12-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/12-sprint-12-webhooks-hotmart-kiwify-stripe.md).

### O que foi entregue no Sprint 11

**Sprint 11 (T-FUNIL-020..026):**
- `guru-launch-resolver.ts`: 3 estratégias de resolução (mapping → last_attribution → none) + safeLog
- `PATCH /v1/workspace/config`: merge seguro JSONB + fallback `db.insert(auditLog)` em produção
- `webhooks/guru.ts`: integração do resolver → `launch_id` + `funnel_role` injetados no raw_event.payload
- CP: painel "Mapeamento Guru" na tab Overview do launch detail (`<dialog>` nativo, CRUD)
- 30 novos testes (unit + integration fase-3)
- 4 docs atualizados (guru-webhook, api-contracts, mod-funnel, mod-workspace)

### Bugs corrigidos no E2E usability test (sessão anterior + esta sessão)

| # | Bug | Status |
|---|---|---|
| B1 | `GET /v1/pages/:id/status` retorna 404 | ✅ FALSO — retorna 200 (token_status=expired para pages scaffoldadas sem token) |
| B2 | `OPTIONS /v1/events` retorna 401 | ✅ CORRIGIDO — `authPublicToken` passa OPTIONS sem autenticar |
| B3 | Header da page detail mostra slug | pendente (polish) |
| B4 | Tracker `EDGE_BASE_URL = ''` | ✅ CORRIGIDO — lê `data-edge-url` do script tag |
| B5 | Snippet apontava para CDN inexistente | ✅ CORRIGIDO (R2 público) |
| B6 | Phone Guru: `normalizePhone("999999999")` inválido | ✅ CORRIGIDO — composição `+${localCode}${number}` em `guru-raw-events-processor.ts` |
| B7 | `chk_events_event_source` não incluía `webhook:guru` | ✅ CORRIGIDO — migration `0030_add_guru_event_source.sql` aplicada |
| B8 | `workspace.config` gravado como JSONB string em vez de object | ✅ CORRIGIDO — `(config #>> '{}')::jsonb` + parsing defensivo em edge + CP |
| B9 | `GET /v1/events` bloqueado por CORS (Aba "Eventos" mostrava "Endpoint indisponível") | ✅ CORRIGIDO — middleware method-dispatch em `index.ts`: OPTIONS/GET usam admin CORS; POST usa public CORS |

### Pendências técnicas (não bloqueiam Sprint 12)

| Item | Detalhe |
|---|---|
| `tracker.js` CDN | Servir `apps/tracker/dist/tracker.js` via CF Worker dedicado |
| `auth-cp.ts` JWT | `DEV_WORKSPACE_ID` hardcoded em dev. Prod precisa JWT validation |
| GA4 `no_client_id` | GA4 requer `_ga` cookie — leads sem browser não têm client_id. OQ-012 aberta |
| TS pré-existentes CP | 2 erros em `layout.tsx` / `use-workspace.ts` (Supabase relation type inference) |
| TS pré-existentes edge | 5 erros pré-existentes (HYPERDRIVE?, guru null types, events.ts launch_id var) |
| Secrets produção | Não deployados — bloqueia prod |

### Notas técnicas invariantes

- `DATABASE_URL ?? HYPERDRIVE?.connectionString ?? ''` — padrão obrigatório em todas as rotas
- Duas pastas de migrations: `packages/db/migrations/0NNN_*.sql` E `supabase/migrations/20260502000NNN_*.sql`
- RLS dual-mode: `NULLIF(current_setting('app.current_workspace_id', true), '')::uuid OR public.auth_workspace_id()`
- Biome varre `.claude/worktrees/` — limpar com `git worktree remove -f <path>` após uso
- `<dialog open>` nativo (não `div role="dialog"`) nos componentes CP
- OXC parse error em type aliases multi-linha → usar `Record<string, unknown>`
- JSONB no driver Cloudflare Workers Postgres pode chegar como string → sempre parsear defensivamente
- `/v1/events` é dual-mode: POST = tracker.js (public auth+CORS), GET = CP (admin CORS, Bearer auth no handler)

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-025 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto
- OQ-013 FECHADA → ADR-025: dispatch-replay cria novo job filho

### Como retomar em nova sessão

```
1. Ler este §5 + §7 inteiro
2. git log -5 + git status (confirmar branch main, working tree limpa)
3. curl localhost:8787/health + curl localhost:3000 (relevantar servidores se necessário)
4. Próxima ação concreta: Fase 0 do teste E2E (§7) — disparar eventos via curl
5. Pipeline Guru E2E está funcional — testar com curl antes de instalar snippet real
```

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
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

## §7 E2E Usability Test — Lançamento real `wkshop-cs-jun26` [EM ANDAMENTO]

### Por que existe esse teste

Tiago decidiu **pausar Sprint 12** e validar o sistema como usuário real antes de seguir. Objetivo duplo:

1. **Funcional**: provar que o pipeline ponta-a-ponta funciona — captura → identidade → stages → audiences → dispatch (Meta CAPI / GA4 / Google Ads) → webhook (Guru).
2. **Usabilidade**: a cada atrito que aparece (campo confuso, fluxo travado, copy ruim, falta de validação), corrigir antes de seguir. O teste é também um exercício de UX hardening.

### Estado do lançamento sob teste

- **Launch**: `wkshop-cs-jun26` ("CS Junho 26") — id `d0a4e10e-b1bd-437a-98e6-266d61accd04`
- **Template aplicado**: `lancamento_pago_workshop_com_main_offer` (workshop pago + oferta principal)
- **Pages scaffoldadas (4)**: `workshop` (sales/workshop), `obrigado-workshop` (thankyou/workshop), `oferta-principal` (sales/main_offer), `obrigado-principal` (thankyou/main_offer).
- **Stages no funnel_blueprint (9)**: `lead_workshop` → `clicked_buy_workshop` (recurring) → `purchased_workshop` → `wpp_joined` → `watched_class_1..3` → `clicked_buy_main` (recurring) → `purchased_main`
- **Audiences scaffoldadas (5)**: compradores_workshop_aquecimento, engajados_workshop, abandono_main_offer, compradores_main, compradores_apenas_workshop
- **Webhook Guru**: pipeline E2E funcional — `purchased_workshop` stage criado com sucesso no DB
- **GuruMappingPanel**: produto mapeado em `workspace.config.integrations.guru.product_launch_map` (CRUD funcionando)
- **Aba "Eventos"**: `GET /v1/events` funcionando com CORS admin (Authorization header permitido)

### O que foi corrigido nesta sessão especificamente

1. **Phone Guru** (`guru-raw-events-processor.ts`): Guru envia `phone_number` e `phone_local_code` separados. `normalizePhone("999999999")` falhava. Fix: compor `+${localCode}${number}` antes de passar para o resolver.

2. **constraint `chk_events_event_source`** (`packages/db/migrations/0030_add_guru_event_source.sql`): constraint não incluía `webhook:guru`. Criada migration e aplicada via Supabase CLI.

3. **JSONB string** em `workspace.config`: UPDATE anterior havia criado array JSONB inválido. Corrigido com `UPDATE workspaces SET config = (config #>> '{}')::jsonb`. Adicionado parsing defensivo em:
   - `apps/edge/src/routes/workspace-config.ts` (SELECT → deepMerge → UPDATE)
   - `apps/control-plane/.../page.tsx` (loadMappings)

4. **CORS `GET /v1/events`** (`apps/edge/src/index.ts`): Aba "Eventos" mostrava "Endpoint indisponível" porque OPTIONS preflight retornava headers públicos (sem `Authorization`). Fix: middleware method-dispatch — OPTIONS de origem admin usa cpCors, OPTIONS de outra origem usa publicCors, GET usa cpCors, POST usa chain pública completa.

### Plano de teste em 3 fases

**Fase 0 — Mock total via curl** *(PRÓXIMA AÇÃO)*

Sem instalar snippet ainda. Testa 80% do pipeline:

1. Verificar que as 4 pages têm `url` e `event_config` configurados (via UI Pages tab)
2. Disparar eventos via `curl POST /v1/events` simulando o tracker:
   - `PageView` em `workshop` → vê PageView na Aba Eventos
   - `Lead` (popup workshop) → resolver de identidade cria lead, `lead_workshop` stage
   - `InitiateCheckout` → `clicked_buy_workshop` (recurring)
   - Webhook Guru real `Purchase` → `purchased_workshop`
   - Repetir para main_offer
3. Validar:
   - Lead progride pelos 9 stages na timeline
   - Audiences populam
   - Dispatchers disparam (logs do worker)
   - Webhook Guru resolve `launch_id` + `funnel_role` corretamente

**Fase 1 — Captura client-side real (Cloudflared Tunnel)**

Quando Fase 0 estiver verde: instalar snippet via cloudflared tunnel.

**Fase 2 — Validação completa**

Compra Guru real → confirmar pipeline completo end-to-end.

### Preferências do operador (Tiago) durante este teste

- Atua como par, prefere debate antes de código grande
- Quer ver UX issues escaladas explicitamente, não silenciadas
- Prefere caminho recomendado quando há trade-off claro
- Aceita "começar mais simples e subir" (Fase 0 antes de Fase 1)
- Quer credenciais reais validadas (não mockar dispatchers)

## Política de uso

- `MEMORY.md` é volátil — pode ser limpa entre sessões.
- Decisões importantes migram para `docs/90-meta/04-decision-log.md` (ADR).
- OQs migram para `docs/90-meta/03-open-questions-log.md`.
- Não duplique aqui o que já está em ADR/OQ — referencie.
