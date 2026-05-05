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

- **CONSTRAINT-guru-api-token-length** (RESOLVIDO via migration 0033): formalizada via `0033_relax_guru_api_token_constraint.sql` (aplicada 2026-05-05).

- **DUPLICATE-EVENTS bug** (parcialmente resolvido): tabela `events` é `PARTITIONED BY RANGE (received_at)`, forçando UNIQUE constraint a incluir `received_at` (`uq_events_workspace_event_id (workspace_id, event_id, received_at)`). Retries de webhook (Guru manda 2x para `approved`) chegam com `received_at` diferente, então `INSERT ... ON CONFLICT` não dispara → duplicatas. Fix runtime aplicado em `guru-raw-events-processor.ts`: SELECT prévio por `(workspace_id, event_id)` antes do INSERT. **Pendência**: replicar o mesmo padrão em `raw-events-processor.ts` (tracker) — bug latente. Sub-T-ID `T-13-008` (a criar em Sprint 13).

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
| Sprint 12 | **in progress** — Onda 3 parcial: passos 1-4 do E2E validados (2026-05-05) | `docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md` |
| Sprint 13 | **planned** (realocado de 12, +3 T-IDs cleanup herdadas de S12) | `docs/80-roadmap/13-sprint-13-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 12 — Onda 3 EM ANDAMENTO (2026-05-05). Passos 1-4 do
               §Verificação E2E final do roadmap 12 VALIDADOS em produção
               com lead real (74f1d1bf-3666-49ac-a7c9-5f155e7895b6 — compra
               R$2 cartão crédito, transação Guru a1b4333f-6244-4885-9ef4-5bf4a59f42b5).
Branch:        main (working tree GRANDE pronto pra commit)
DB Supabase:   migrations 0000–0033 aplicadas ✓
               0031 = funnel template paid_workshop v2 + reset
               0032 = reorder stages (clicked_buy_workshop antes de lead_workshop)
               0033 = relax guru_api_token constraint (40 → 16-200 chars)
DEV_WORKSPACE: 74860330-a528-4951-bf49-90f0b5c72521 (Outsiders Digital)
Edge prod:     https://globaltracker-edge.globaltracker.workers.dev
               Last deploy ID 17e3ecce-cc23-4ada-839d-4c820531ac1a (2026-05-05)
               com pre-insert dedup em guru processor + pptc/utm preprocess
Tracker CDN:   https://pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js
Lead E2E:      lead 74f1d1bf — `lead_workshop` (03:54:28) + `purchased_workshop` (03:57:31)
               eventos `lead_identify`, `Lead`, `custom:click_buy_workshop`, `Purchase` ✓
Próxima ação:  Continuar Onda 3 — passos 5-13 do §Verificação E2E final:
               5. PageView identificado em obrigado-workshop (precisa snippets head+body Framer)
               6. survey_responded (precisa form de pesquisa no Framer)
               7. Contact (click WhatsApp final) → wpp_joined stage
               8. PageView aula-workshop (criar page Framer)
               9. custom:watched_workshop (botão "Já assisti")
               10. PageView + ViewContent oferta-principal (criar page Framer)
               11. custom:click_buy_main (botão Comprar Oferta Principal)
               12. Compra main via Guru → purchased_main stage
               13. Audience sync valida segmentação
```

### Plano canônico de sprints restantes

- **Sprint 12** — Realinhamento template `lancamento_pago_workshop_com_main_offer` v2 (popup Lead, custom events de intent, page aula-workshop, pesquisa na thankyou). Ver [`12-sprint-12-funil-paid-workshop-realinhamento.md`](docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md).
- **Sprint 13** — Webhooks Hotmart/Kiwify/Stripe (era Sprint 12, realocado). Ver [`13-sprint-13-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/13-sprint-13-webhooks-hotmart-kiwify-stripe.md).

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
| Tracker dedup events | `raw-events-processor.ts` (tracker) tem mesmo bug latente do guru-processor: events partitioned exige pre-insert dedup. Replicar fix do guru. Sub-T-ID T-13-008. |
| Guru `source.utm_*` | Nos webhooks recebidos, `source.utm_source/medium/campaign/...` vêm `null` mesmo quando o checkout abriu com UTMs preservados. Investigar config Guru: cookie de atribuição / passagem por iframe / domínio. Sub-T-ID T-13-009. |
| Guru `dates.confirmed_at` | Webhook `approved` chega 2x (autorização + settlement). Idempotency dedupa, mas se 1º a chegar tem `confirmed_at:null`, esse fica gravado. `update_if_newer` baseado em `dates.updated_at` seria mais correto. Sub-T-ID T-13-010. |
| Pages `workshop` `status=draft` | DB tem status `draft` mesmo a page já estando em produção. Toggle pra `active` (apenas cosmético — não bloqueia tracker). |

### Ambiente operacional desta sessão (não mudar sem motivo)

- Worker name: `globaltracker-edge`
- Worker URL: `https://globaltracker-edge.globaltracker.workers.dev`
- Subdomain CF: `globaltracker.workers.dev` (registrado nesta sessão)
- R2 bucket: `gt-tracker-cdn`, public URL `pub-e224c543d78644699af01a135279a5e2.r2.dev`
- Wrangler OAuth token em `~/Library/Preferences/.wrangler/config/default.toml` (expira 2026-05-04T18:36:08Z — renovar com `npx wrangler login`)
- Page tokens ativos (5 pages do `wkshop-cs-jun26` Funil B v2 — **rotacionados 2026-05-04 via reset_funnel script**):
  - workshop: `f919d6b137cdf39b6334cae3bd6b4b7cad5598950552caf9470878271afd80d5` (rotacionado pelo CP em 23:43; token anterior `4ae3c000…` ainda em status=`rotating`)
  - obrigado-workshop: `ec866ba774c3f5279dbba1725bb43c6a048bcafe4cb00cee7e76c3899950113b`
  - aula-workshop: `5f376c162fba3577268325b0aa25e6af3baafbda853e7b73c87e41bd19c93aaf`
  - oferta-principal: `7e10e3e260a09cc69b4407867b4d3645f1bb124529fe8f5cb93fbb802e265849`
  - obrigado-principal: `04e8724b77005b79c8dcd62f8e65140b422f23cbeb1f307abd31a14940492793`
  - **Tokens antigos revogados** (pages anteriores foram DELETE-ada no reset, ON DELETE RESTRICT garantiu cleanup atômico). Tiago precisa recolar **5 snippets** no Framer (incluindo workshop + obrigado-workshop que já estavam em produção).

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-025 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto
- OQ-013 FECHADA → ADR-025: dispatch-replay cria novo job filho

### Como retomar em nova sessão

```
1. Ler §5 + §7 + §8 inteiros (estado Onda 3 + decisões + bugs encontrados).
2. git log -5 + git status (deve estar limpo — última sessão commitou tudo).
3. Edge prod já está rodando — não precisa subir wrangler dev local.
   Verificar saúde: curl https://globaltracker-edge.globaltracker.workers.dev/health
4. Reabrir CP local quando precisar:
     cd apps/control-plane && pnpm dev
   Wrangler tail (auto-reconnect) em outro shell:
     cd apps/edge && (while true; do npx wrangler tail --format pretty 2>&1 | tee -a /tmp/wrangler-tail.log; sleep 2; done)
5. Próxima ação: continuar Onda 3 a partir do passo 5 do §Verificação E2E final
   do roadmap 12 (instalar snippets das 4 pages restantes no Framer e validar
   o flow ponta-a-ponta com lead identificado de teste).
6. Snippets versionados em apps/tracker/snippets/paid-workshop/ (5 arquivos)
   — todos com tokens reais atualizados desta sessão. Body para captura-v1
   foi gerado via "Detection script" do CP (Tier 1 form-detector + custom
   events + checkout URL com UTMs); fluxo replicar para outras pages.
```

## §8 Checkpoint Sprint 12 — Realinhamento template paid_workshop (2026-05-04)

> Decisões já fechadas com Tiago. **Não re-debater** ao retomar — partir direto para execução.

### Decisões D1–D6 (alvo de ADR-026 em T-FUNIL-036)

| ID | Decisão | Implicação técnica |
|---|---|---|
| D1 | IC do workshop e do main vêm do **Guru** (load do checkout ou webhook intermediário, **investigar pós-sprint**) | Stages de IC ficam **fora** do template Sprint 12. Stages de "clicou comprar" são custom events client-side. Investigação Guru = potencial Sprint 14. |
| D2 | `obrigado-workshop` muda de papel: vira **página de pesquisa** + botão WhatsApp ao final | Fluxo: Purchase → redirect → preencher pesquisa (`custom:survey_responded`) → botão wpp (`Contact`). |
| D3 | Aula em page nova `aula-workshop` (role=`webinar`); MVP **binário** com botão "Já assisti" | Evolução planejada: Zoom webhook attendance OU Vimeo heartbeat. Backlog. |
| D4 | Tracking aula = binário (`custom:watched_workshop`) | 1 stage. Sem `_25/_50/_90`. |
| D5 | Click "Quero Comprar" antes da popup vira `custom:click_buy_workshop` | Custom client-side. iOS funciona via first-party fetch ao Edge (cookie `__ftk` cross-origin já resolvido SameSite=None). |
| D6 | `oferta-principal` **sem popup**; `clicked_buy_main` via `custom:click_buy_main` no botão | Page main perde Lead do event_config. |

### Forma canônica v2 (alvo)

**Stages (8)**: `lead_workshop` (Lead) → `clicked_buy_workshop` (custom:click_buy_workshop) → `purchased_workshop` (Purchase + funnel_role=workshop) → `survey_responded` (custom:survey_responded) → `wpp_joined` (Contact) → `watched_workshop` (custom:watched_workshop) → `clicked_buy_main` (custom:click_buy_main) → `purchased_main` (Purchase + funnel_role=main_offer)

**Pages (5)**:
- `workshop` (sales/workshop): canonical `[PageView, Lead]` + custom `[click_buy_workshop]`
- `obrigado-workshop` (thankyou/workshop): canonical `[PageView, Purchase, Contact]` + custom `[survey_responded]`
- `aula-workshop` (webinar/workshop) **NOVA**: canonical `[PageView]` + custom `[watched_workshop]`
- `oferta-principal` (sales/main_offer): canonical `[PageView, ViewContent]` + custom `[click_buy_main]`
- `obrigado-principal` (thankyou/main_offer): canonical `[PageView, Purchase]`

**Audiences (6)**: `compradores_workshop_aquecimento`, `respondeu_pesquisa_sem_comprar_main`, `engajados_workshop` (gte=watched_workshop), `abandono_main_offer`, `compradores_main`, `nao_compradores_workshop_engajados`. Removidas: `compradores_apenas_workshop` (duplicata), `watched_class_1/2/3` (substituídos).

### T-IDs Sprint 12 — execução

```
Onda 1 (CONCLUÍDA 2026-05-04):
  T-FUNIL-030 schema migration 0031 ✓  (aplicada na cloud)
  T-FUNIL-031 body scripts 4 pages    ✓
  T-FUNIL-032 snippet aula-workshop   ✓

Onda 2 (CONCLUÍDA 2026-05-04):
  T-FUNIL-033 test custom events           ✓ (6/6 verdes)
  T-FUNIL-034 test audiences               ✓ (4/4 verdes)
  T-FUNIL-035 docs-sync módulos            ✓
  T-FUNIL-036 ADR-026 + MEMORY §2 cleanup  ✓
  T-FUNIL-039 fix legacy cookie tests      ✓ (extra; -4 falhas BR-IDENTITY-005)

Sub-T-IDs blockers de Onda 3 (CONCLUÍDAS 2026-05-04):
  T-FUNIL-040 fix audience DSL vocabulary  ✓ (stage_eq/_not/_gte canônicos + alias legacy)
  T-FUNIL-041 fix guru.ts dual signature    ✓ (-25 falhas)
  T-FUNIL-042 docs DSL audience canon       ✓ (09-mod-audience + BR-AUDIENCE)

Sub-T-IDs criadas durante Onda 3 (2026-05-05):
  T-FUNIL-043 reorder stages + ADR-026 addendum + 06-mod-funnel/funil-templates  ✓
  T-FUNIL-044 detect-form bookmarklet (CP gera detection script p/ DevTools)    ✓
  T-FUNIL-045 Tier1 custom-event card (CP wires seletor → click track listener) ✓
  T-FUNIL-046 checkout URL field + redirect com UTMs preservados                ✓
  T-FUNIL-047 pre-insert dedup em guru-raw-events-processor (events particionados) ✓

Migrations criadas/aplicadas durante Onda 3:
  0032 reorder stages canonical (clicked_buy_workshop antes lead_workshop)      ✓
  0033 relax guru_api_token constraint (length 16-200 — formato moderno)        ✓

Onda 3 (EM ANDAMENTO — humano-in-the-loop):
  T-FUNIL-037 E2E real wkshop-cs-jun26 ponta-a-ponta
    Passos 1-4 ✓ (PageView anon → click_buy_workshop → Lead → Purchase + stages)
    Passo 5+ ⏳ (obrigado-workshop, aula, oferta-principal — instalar snippets Framer)

Onda 4 (após Onda 3):
  T-FUNIL-038 br-auditor pré-merge
```

### Bugs encontrados e corrigidos durante Onda 3 (2026-05-05)

| # | Bug | Solução | Estado |
|---|---|---|---|
| O3-1 | Funnel order errado: `lead_workshop` antes de `clicked_buy_workshop` (cronologia real é inversa) | Reorder via SQL ad-hoc + migration 0032 + docs sync (T-FUNIL-043) | ✓ |
| O3-2 | CP não exibia event_config porque `GET /v1/pages` não retornava `event_config` | Adicionado `eventConfig: pages.eventConfig` no SELECT do edge endpoint + propagar no `page.tsx` (server) | ✓ |
| O3-3 | Hydration mismatch no CP: `pageToken` lido de localStorage no `useState` initializer divergia entre SSR e CSR | Mover leitura para `useEffect` após mount | ✓ |
| O3-4 | CP fazia fetch para `localhost:8787` mesmo com edge prod configurado: `api-client.ts` usava `EDGE_WORKER_URL` (server-only) no client | Usar `NEXT_PUBLIC_EDGE_WORKER_URL` com fallback p/ server var | ✓ |
| O3-5 | Snippet do head no CP não incluía `data-edge-url` nem `async` | `buildHeadSnippet` recebe `edgeUrl` + adicionado `async` no `<script>` (page-detail-client + step-install) | ✓ |
| O3-6 | Detection script gerado pelo CP chamava `Funil.identify({name, phone})` — INV-TRACKER-008 rejeita silenciosamente (só aceita `{lead_token}`) | Reescrever script para fazer POST `/v1/lead` direto, persistir token em localStorage, depois `Funil.identify({lead_token})` + `Funil.track('Lead')` | ✓ |
| O3-7 | POST `/v1/lead` retornava 401 — exige header `X-Funil-Site` com page_token | Detection script + workshop.html lêem `data-site-token` do `<script>` do head e enviam como `X-Funil-Site`. Workshop.html canônico também atualizado. | ✓ |
| O3-8 | POST `/v1/lead` retornava 400 — schema exige `event_id`, `schema_version: 1`, `attribution`, `consent` | Detection script + workshop.html geram esses campos no body | ✓ |
| O3-9 | Webhook Guru retornava 401 (token DB diferente do que Guru envia no payload) | Token correto: `8pwDJLwIY7EdP4Y0MQbhw4OPcQyguTiH8MG1ABJb` (40 chars, "API Token" da conta Guru — NÃO confundir com REST Bearer token `<uuid>\|<key>`). Constraint formal relaxada via migration 0033. | ✓ |
| O3-10 | Webhook Guru aceito (202) mas processamento downstream falhava — schema Zod do mapper rejeitava `source.pptc: []` (Guru envia array vazio quando não tem valor) | `z.preprocess((v) => Array.isArray(v) ? null : v, z.string().nullish())` em todos os campos do `source` | ✓ |
| O3-11 | Duplicata de event `Purchase` no DB: webhook Guru manda `approved` 2x (autorização + settlement); UNIQUE constraint inclui `received_at` (tabela particionada), então `INSERT ... ON CONFLICT` não dispara → 2 rows com mesmo `event_id` | Pre-insert SELECT por `(workspace_id, event_id)` em `guru-raw-events-processor.ts` antes do INSERT (T-FUNIL-047). Mesmo padrão precisa replicar em `raw-events-processor.ts` (tracker). | ✓ (parcial — tracker pendente) |
| O3-12 | Snippet do form de captura ignorava UTMs no redirect ao checkout | Novo input "URL do checkout" no card de captura. Se preenchido, snippet captura UTMs canônicos da `location.search` e redireciona via `window.location.href = checkoutUrl + ?<utms>`. Guru repropaga no payload do webhook. | ✓ |
| O3-13 | Token `data-site-token` antigo (`e5ebb594…`) ficou inválido após reset funil B-full | Snippets locais e CP atualizados com tokens novos pós-reset; workshop foi rotacionado pelo CP (status `rotating` → novo `active`) | ✓ |

Detalhe completo em [`12-sprint-12-funil-paid-workshop-realinhamento.md`](docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md).

### Verificação técnica feita nesta sessão (não re-fazer)

- `raw-events-processor.ts:330` faz match exato por `event_name` — body scripts devem chamar `Funil.track('custom:click_buy_workshop')` com prefixo. Sem normalização.
- `funnel_template` schema (Drizzle) em `packages/db/src/schema/funnel_template.ts`; blueprint Zod em `packages/shared/src/schemas/funnel-blueprint.ts`. Suporta `source_event_filters` (já usado por workshop/main_offer atual).
- Migration `0029_funnel_templates.sql` usa `ON CONFLICT DO NOTHING` — re-rodar não atualiza. Sprint 12 cria `0031` com `UPDATE`.
- Webhook Guru já injeta `funnel_role` no payload (Sprint 11). Mapping product_id→launch+funnel_role já cadastrado pelo Tiago.
- Custom events (`custom:foo`) existem desde Sprint 10 (template original tem `watched_class_1` etc).

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
