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

- **CONTRACT-api-events-v1**: `event-payload.ts` agora aceita `user_data`, `attribution.nullish()` e consent string-or-bool. Doc canônica em `docs/30-contracts/05-api-server-actions.md` ainda descreve a forma antiga. Atualizar antes do próximo sprint.
- **CONTRACT-api-config-v1**: response inclui `event_config.auto_page_view`. Não estava na doc. Atualizar.
- **BR-IDENTITY-005**: cookie `__ftk` mudou de `HttpOnly; SameSite=Lax` para `SameSite=None; Secure` sem HttpOnly (tracker lê via JS para propagar identidade cross-page). Atualizar BR e ADR.
- **CORS público**: quando `pages.allowed_domains` está vazio, libera todas as origens (security via page token). Atualizar `docs/10-architecture/06-auth-rbac-audit.md`.

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
Estado:        E2E USABILITY TEST EM PRODUÇÃO REAL (2026-05-04)
               Sprint 12 PAUSADO. Edge Worker DEPLOYED em Cloudflare
               Workers; tracker.js no R2 público; LP Framer real
               (cneeducacao.com) instrumentada e capturando leads.
               Pipeline ponta-a-ponta validado.
Branch:        main (ahead com commits desta sessão pendentes)
DB Supabase:   migrations 0000–0030 aplicadas ✓
DEV_WORKSPACE: 74860330-a528-4951-bf49-90f0b5c72521 (Outsiders Digital)
Edge prod:     https://globaltracker-edge.globaltracker.workers.dev
Tracker CDN:   https://pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js
Próxima ação:  Aplicar template de funil no launch wkshop-cs-jun26
               para que eventos virem stages.
```

### Plano canônico de sprints restantes

- **Sprint 12** — Webhooks Hotmart/Kiwify/Stripe. Ver [`12-sprint-12-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/12-sprint-12-webhooks-hotmart-kiwify-stripe.md).

### O que foi entregue nesta sessão (E2E hardening real)

Deploy operacional:
- Worker Cloudflare deployado em `globaltracker-edge.globaltracker.workers.dev`
- Subdomínio workers.dev `globaltracker` registrado no account `118836e4d3020f5666b2b8e5ddfdb222`
- Tracker.js rebuildado e republicado no R2 com `credentials: 'include'`

Bugs corrigidos no Edge (ver §7 para detalhe):
1. CORS bloqueava todas origens quando `pages.allowed_domains` vazio → liberada por padrão (security é page token)
2. `/v1/config` era stub — wired real `getPageConfig` que lê DB; resposta inclui `auto_page_view`
3. `EventPayloadSchema` não aceitava `user_data`, `attribution null`, consent string → adicionados
4. `/v1/events` validava HMAC mas não extraía `lead_id` do token → `leadIdFromToken` flui pro raw_events
5. `LEAD_TOKEN_SECRET` (events) ≠ `LEAD_TOKEN_HMAC_SECRET` (lead) → unificado com fallback dev
6. `AttributionPayloadSchema` no processor rejeitava `null` → trocado para `.nullish()`
7. CORS faltava `Access-Control-Allow-Credentials` → adicionado
8. Cookie `__ftk` era `HttpOnly; SameSite=Lax` (tracker não lê, cross-origin não envia) → trocado para `SameSite=None; Secure` sem HttpOnly

Cross-page identity propagation:
- Decidido usar **localStorage** ao invés de cookie cross-origin (workers.dev ≠ cneeducacao.com)
- Body script de page sales armazena `__gt_ftk` em localStorage após `/v1/lead`
- Body script de thankyou lê `__gt_ftk` e chama `Funil.identify` antes de `Funil.page()`

E2E validado em produção real (2026-05-04 19:37-19:38 UTC):
- captura-v1: PageView (anon) → submit → lead_identify (lead 683d6833) → Lead (lead 683d6833) ✅
- obrigado-workshop: navega → reads localStorage → wpp_joined com lead 683d6833 ✅

### Pendências técnicas (não bloqueiam Sprint 12)

| Item | Detalhe |
|---|---|
| `tracker.js` CDN | OK por enquanto via R2 público; considerar Worker dedicado para CDN headers |
| `auth-cp.ts` JWT | `DEV_WORKSPACE_ID` hardcoded em dev. Prod precisa JWT validation |
| GA4 `no_client_id` | OQ-012 aberta |
| `lead-token-validate` middleware | Não wired em index.ts. Atualmente `lead_id` resolve só via `payload.lead_token` (HMAC) |
| Secrets produção | `LEAD_TOKEN_HMAC_SECRET` usa fallback dev — definir secret real antes de prod-real |
| TS pré-existentes CP | 2 erros em `layout.tsx` / `use-workspace.ts` |
| TS pré-existentes edge | Vários erros pré-existentes |
| Doc-sync | §2 lista contratos atualizados que precisam refletir no doc canônico |

### Ambiente operacional desta sessão (não mudar sem motivo)

- Worker name: `globaltracker-edge`
- Worker URL: `https://globaltracker-edge.globaltracker.workers.dev`
- Subdomain CF: `globaltracker.workers.dev` (registrado nesta sessão)
- R2 bucket: `gt-tracker-cdn`, public URL `pub-e224c543d78644699af01a135279a5e2.r2.dev`
- Wrangler OAuth token em `~/Library/Preferences/.wrangler/config/default.toml` (expira 2026-05-04T18:36:08Z — renovar com `npx wrangler login`)
- Page tokens ativos:
  - workshop: `e5ebb594e9f1169165c08169edfbaa49cf3ddc923549bcd57d4f61e6136f576a`
  - obrigado-workshop: `bfed23ef8117c7b9cf89b77c67ccff3814c15542b370d99e505eca97a16adc27`

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-025 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto
- OQ-013 FECHADA → ADR-025: dispatch-replay cria novo job filho

### Como retomar em nova sessão

```
1. Ler §5 + §7 inteiro
2. git log -5 + git status (working tree limpa nesta sessão pós-commit)
3. Edge prod já está rodando — não precisa subir wrangler dev local
4. Verificar saúde: curl https://globaltracker-edge.globaltracker.workers.dev/health
5. Próxima ação: aplicar template de funil em wkshop-cs-jun26 OU configurar
   pages oferta-principal/obrigado-principal seguindo a mesma receita.
6. Body scripts canônicos (Framer) estão no §7.
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
| Worker prod | `globaltracker-edge.globaltracker.workers.dev` |
| R2 bucket | `gt-tracker-cdn` (público) |
| Wrangler | 4.87.0 (via npx) |
| Supabase CLI | 2.90.0 |
| Node | 24.x (v24.10.0) |
| pnpm | 10.x |

## §7 E2E Usability Test — Lançamento real `wkshop-cs-jun26` [EM ANDAMENTO]

### Por que existe esse teste

Tiago decidiu **pausar Sprint 12** e validar o sistema como usuário real antes de seguir. Objetivo duplo:

1. **Funcional**: provar que o pipeline ponta-a-ponta funciona — captura → identidade → stages → audiences → dispatch (Meta CAPI / GA4 / Google Ads) → webhook (Guru).
2. **Usabilidade**: a cada atrito que aparece (campo confuso, fluxo travado, copy ruim, falta de validação), corrigir antes de seguir. O teste é também um exercício de UX hardening.

### Estado atual do lançamento sob teste

- **Launch**: `wkshop-cs-jun26` ("CS Junho 26") — id `d0a4e10e-b1bd-437a-98e6-266d61accd04`
- **Pages com URL real e snippet instalado:**
  - `workshop` (sales/workshop) → `https://cneeducacao.com/captura-v1` (status: draft, mas event_config ativo com `auto_page_view: true`)
  - `obrigado-workshop` (thankyou/workshop) → `https://cneeducacao.com/obrigado-workshop` (status: active, `auto_page_view: false`)
- **Pages ainda sem URL/snippet:**
  - `oferta-principal` (sales/main_offer)
  - `obrigado-principal` (thankyou/main_offer)
- **Funnel blueprint**: foi limpo na sessão anterior — **template novo ainda não foi aplicado** (próxima ação)
- **Audiences**: scaffoldadas anteriormente, ainda não testadas com eventos reais
- **Webhook Guru**: pipeline E2E funcional desde sessão anterior (`product_launch_map` em `workspace.config`)

### Snippets canônicos (Framer) instalados nas pages

**Page workshop — `<head>`:**
```html
<script
  src="https://pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js"
  data-site-token="e5ebb594e9f1169165c08169edfbaa49cf3ddc923549bcd57d4f61e6136f576a"
  data-launch-public-id="wkshop-cs-jun26"
  data-page-public-id="workshop"
  data-edge-url="https://globaltracker-edge.globaltracker.workers.dev"
  async
></script>
```

**Page workshop — `<body>`:** (form selector `.framer-150ieha`, inputs `[name="Name"]`, `[name="Phone"]`)
- Captura submit/click do form, POST `/v1/lead` com `credentials:'include'`
- Armazena `lead_token` em `localStorage('__gt_ftk')`
- Chama `Funil.identify(token)` + `Funil.track('Lead')`
- Dedup: flag `firing` por 3s

**Page obrigado-workshop — `<head>`:**
```html
<script
  src="https://pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js"
  data-site-token="bfed23ef8117c7b9cf89b77c67ccff3814c15542b370d99e505eca97a16adc27"
  data-launch-public-id="wkshop-cs-jun26"
  data-page-public-id="obrigado-workshop"
  data-edge-url="https://globaltracker-edge.globaltracker.workers.dev"
  async
></script>
```

**Page obrigado-workshop — `<body>`:** (link selector `a.framer-17w9gs4[href*="whatsapp"]`)
- Lê `localStorage('__gt_ftk')` → `Funil.identify(token)` → `Funil.page()`
- No clique do link WhatsApp → `Funil.track('wpp_joined')`

### Bugs corrigidos nesta sessão (timeline da onda)

| # | Bug | Arquivo | Status |
|---|---|---|---|
| C1 | Worker not deployed (only wrangler dev) | wrangler.toml + register subdomain | ✅ deployed em `globaltracker-edge.globaltracker.workers.dev` |
| C2 | CORS bloqueia todas origens (allowed_domains vazio) | middleware/cors.ts | ✅ permissivo se vazio |
| C3 | `/v1/config` retornava stub fallback | routes/config.ts + index.ts | ✅ wired real getPageConfig |
| C4 | `auto_page_view` ausente da response /v1/config | config.ts schema/buildResponseBody | ✅ incluído |
| C5 | EventPayloadSchema rejeita `user_data` (strict + unknown) | schemas/event-payload.ts | ✅ UserDataSchema aceito |
| C6 | EventPayloadSchema rejeita `null` em attribution | schemas/event-payload.ts | ✅ `.nullish()` |
| C7 | EventPayloadSchema rejeita consent string ('granted') | schemas/event-payload.ts | ✅ union+transform |
| C8 | RawEventPayloadSchema rejeita `null` em attribution | lib/raw-events-processor.ts | ✅ `.nullish()` |
| C9 | `/v1/events` 401 — `LEAD_TOKEN_SECRET` ausente | routes/events.ts | ✅ aceita `LEAD_TOKEN_HMAC_SECRET` + dev fallback |
| C10 | `/v1/events` 500 race condition (submit+click paralelos) | client body script | ✅ flag `firing` por 3s |
| C11 | `lead_id` não fluía do `payload.lead_token` para events row | routes/events.ts | ✅ `leadIdFromToken` injetado em raw_payload |
| C12 | Cross-page identity não funcionava (cookie cross-origin bloqueado) | lib/cookies.ts + tracker + body scripts | ✅ localStorage como mecanismo |
| C13 | Tracker fetch sem `credentials:'include'` | apps/tracker/src/api-client.ts | ✅ adicionado, rebuild + R2 |
| C14 | CORS sem `Access-Control-Allow-Credentials` | middleware/cors.ts | ✅ adicionado |

### Notas técnicas invariantes (atualizadas)

- `DATABASE_URL ?? HYPERDRIVE.connectionString ?? ''` — padrão obrigatório em todas as rotas
- Duas pastas de migrations: `packages/db/migrations/0NNN_*.sql` E `supabase/migrations/20260502000NNN_*.sql`
- RLS dual-mode: `NULLIF(current_setting('app.current_workspace_id', true), '')::uuid OR public.auth_workspace_id()`
- Biome varre `.claude/worktrees/` — limpar com `git worktree remove -f <path>` após uso
- `<dialog open>` nativo (não `div role="dialog"`) nos componentes CP
- OXC parse error em type aliases multi-linha → usar `Record<string, unknown>`
- JSONB no driver Cloudflare Workers Postgres pode chegar como string → sempre parsear defensivamente
- `/v1/events` é dual-mode: POST = tracker.js (public auth+CORS), GET = CP (admin CORS, Bearer auth no handler)
- **NEW**: tracker.js dist é gitignored — após mudar `apps/tracker/src/`, rebuild com `node build.config.js` e upload `npx wrangler r2 object put gt-tracker-cdn/tracker.js --remote --file=./dist/tracker.js --content-type=application/javascript`
- **NEW**: redeploy edge com `cd apps/edge && npx wrangler deploy` (NÃO da raiz do monorepo)
- **NEW**: tracker dedupa event_id por nome de evento via sessionStorage (TTL 5min) — segundo Lead/PageView na mesma sessão é `event_duplicate_accepted` (esperado)

### Preferências do operador (Tiago) durante este teste

- Atua como par, prefere debate antes de código grande
- Quer ver UX issues escaladas explicitamente, não silenciadas
- Prefere caminho recomendado quando há trade-off claro
- Aceita "começar mais simples e subir"
- Quer credenciais reais validadas (não mockar dispatchers)

## Política de uso

- `MEMORY.md` é volátil — pode ser limpa entre sessões.
- Decisões importantes migram para `docs/90-meta/04-decision-log.md` (ADR).
- OQs migram para `docs/90-meta/03-open-questions-log.md`.
- Não duplique aqui o que já está em ADR/OQ — referencie.
