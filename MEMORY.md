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
- **TEMPLATE-paid-workshop-v3-event-config-purge**: migration 0034 manteve `Purchase` e `Contact` em `event_config.canonical` da page `obrigado-workshop`, mas pela arquitetura v3 ambos são server-side (Purchase via webhook Guru, Contact via webhook SendFlow). Próxima migration deve deixar canonical=[PageView], custom=[click_wpp_join, survey_responded]. Aplicado runtime em wkshop-cs-jun26 via UI do CP (2026-05-05), template global ainda divergente. Mesma correção provavelmente cabe em outras pages (workshop tem `Purchase`? — verificar).

- **CP-DOUBLE-STRINGIFY-event-config**: o save handler do CP grava `event_config` como **string JSON** dentro do JSONB (double-encoded), em vez de objeto JSONB cru. Detectado nas pages `workshop` e `obrigado-workshop` que foram editadas via UI (`jsonb_typeof(event_config)='string'`). As 3 pages que vieram só da migration 0034 estão como `object` ✓. UPDATE manual aplicado em 2026-05-05 (`event_config = (event_config #>> '{}')::jsonb`). **Pendência**: encontrar e corrigir o save handler que está rodando `JSON.stringify` antes do Drizzle. Sub-T-ID `T-13-013` (Sprint 13).

- **EDGE-event-config-schema-mismatch (RESOLVIDO 2026-05-05)**: Edge `getPageConfig` em `apps/edge/src/index.ts` lia `ec.allowed_event_names` (campo inexistente — o schema canônico usa `{canonical, custom}`). Resultado: `/v1/config` sempre retornava `allowed_event_names: []` → todos eventos client-side bloqueados. Fix deployado: agora monta `allowedEventNames = [...canonical, ...custom.map(c => 'custom:' + c)]` + parse defensivo string→object pra cobrir rows double-stringified. Worker version `dff44d61-fdca-4f6a-ab3e-f066a07d23d7`.

- **TRACKER-init-race-zera-leadToken (RESOLVIDO 2026-05-05)**: `init()` async do tracker chamava `setLeadToken(readLeadTokenCookie())` incondicionalmente. Quando snippet roda primeiro no DOMContentLoaded e chama `Funil.identify(token)` (token de localStorage), init posteriormente lia cookie vazio e zerava o state. Resultado: PageView (logo após identify) ia com lead_token, mas tracks subsequentes ficavam anônimos. Fix: `if (leadToken) setLeadToken(leadToken)` em apps/tracker/src/index.ts:175. Tracker rebuilt + reuploaded R2. Snippet também ganhou re-identify defensivo no listener de click.

- **SNIPPET-name-reserved-wp-query-var (RESOLVIDO 2026-05-05)**: WordPress reserva `?name=` como query var pra lookup de post por slug. URLs com `?name=...` em pages que não têm post com esse slug retornam 404. Fix no snippet `obrigado-workshop.html`: trocar key da URL pra `lead_name` (mantém `body.name` no schema do `/v1/lead`). Documentado no header do snippet — qualquer page nova deve evitar `name` cru.

- **PHONE-normalizer-9-prefix-BR**: `normalizePhone` em `apps/edge/src/lib/lead-resolver.ts:67` não reconcilia mobiles BR sem o "9" extra (mandato de 2014). Sistemas legados como SendFlow enviam phone sem o 9 → `phone_hash` divergente do que o form do site gera com 9. Tracking de T-13-014 (Sprint 13). Após implementação, atualizar `docs/50-business-rules/BR-IDENTITY.md` BR-IDENTITY-002 + nova INV-IDENTITY-008 (mobile canônico = 13 dígitos `+55DD9XXXXXXXX`).

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
| Sprint 13 | **planned** (refocado 2026-05-05 — funil B foundation: phone normalizer BR + SendFlow inbound + cleanups S12) | `docs/80-roadmap/13-sprint-13-webhooks-hotmart-kiwify-stripe.md` |
| Sprint 14 | **planned** (separado de 13 em 2026-05-05 — webhook adapters Hotmart/Kiwify/Stripe) | `docs/80-roadmap/14-sprint-14-webhooks-hotmart-kiwify-stripe.md` |

## §5 Ponto atual de desenvolvimento

```
Estado:        SPRINT 12 — Onda 4 PARCIALMENTE FECHADA (2026-05-05 manhã).
               MIGRAÇÃO PLATAFORMA: Funil B Framer → WordPress + Elementor Pro 4.0
               (contratosnovaeconomia.com.br). Template v3 ativo no DB (migration
               0034). 2/5 pages WordPress 100% funcionais. Pages aula-workshop,
               oferta-principal e obrigado-principal ADIADAS pro lançamento real
               de junho (decisão Tiago: foco em SendFlow/T-13-011 antes).

               COLD PATH (cross-device identity via Guru redirect) IMPLEMENTADO E
               VALIDADO E2E. obrigado-workshop agora lê email/phone/utms da URL,
               cria/resolve lead via /v1/lead, identifica e strippa PII da URL.
Branch:        main (working tree pronto pra commit — 3 files: edge, tracker, snippet)
DB Supabase:   migrations 0000–0034 aplicadas ✓
               event_config das 5 pages NORMALIZADO nesta sessão (era double-
               stringified em 2 rows — workshop, obrigado-workshop — bug do CP
               save handler — ver §2)
DEV_WORKSPACE: 74860330-a528-4951-bf49-90f0b5c72521 (Outsiders Digital)
Edge prod:     https://globaltracker-edge.globaltracker.workers.dev
               (REDEPLOYADO 2026-05-05 — version dff44d61 — fix event_config
               schema mismatch canonical/custom + parse defensivo string)
Tracker CDN:   https://pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js
               (REBUILT + REUPLOADED 2026-05-05 — fix race init→identify
               que zerava state.leadToken em browsers sem cookie __ftk)
WP plugin:     WPCode Lite (pra snippets per-page com Smart Conditional Logic).
               Wordfence bloqueia POST com <script> — usar "Allowlist This Action"
               ao salvar (1× por padrão de request).
URL canônica:  obrigado-workshop = /wk-obg/ (renomeado nesta sessão de
               /wk-societario-obrigado/ — slug menor pra caber no limite de
               caracteres do redirect Guru).

Pages WP completas (workshop + obrigado-workshop):
  workshop          → https://contratosnovaeconomia.com.br/wk-societarios-1/
                      • CTA dentro de #checkout: <div id="gt-btn-buy-workshop1"> (ID com sufixo "1")
                      • Click → custom:click_buy_workshop → abre popup Elementor (id 342)
                        via window.elementorProFrontend.modules.popup.showPopup()
                      • Popup #342 = "GT — Workshop — Form de captura" com form atomic
                        id=gt-form-workshop, inputs name=name|email|phone
                      • Submit → POST /v1/lead → __gt_ftk localStorage → Lead event
                        → redirect Guru com query (name, email, phone, utms)
                      • URL Guru: https://clkdmg.site/pay/wk-contratos-societarios
  obrigado-workshop → https://contratosnovaeconomia.com.br/wk-obg/  (renomeado
                      nesta sessão pra economizar caracteres no redirect Guru)
                      • Botão WhatsApp → SendFlow (https://sndflw.com/i/3bhG8XexRRKwLxF4SGtk)
                      • CSS ID widget: gt-btn-wpp-join → click dispara
                        custom:click_wpp_join (NÃO `Contact` — Contact virá do
                        webhook SendFlow em Sprint 13/T-13-011)
                      • COLD PATH ATIVO: snippet lê params da URL (email, phone,
                        lead_name, utm_source/medium/campaign/content/term),
                        strippa PII via history.replaceState, e POST /v1/lead
                        pra resolver lead cross-device.

Guru "URL Aprovada" (configurada nesta sessão — limite de chars do Guru aceitou
apenas 5 params: phone + email + 3 utms):
  contratosnovaeconomia.com.br/wk-obg/
    ?phone=[contact_phone_full_number]
    &utm_source=[utm_source]
    &utm_campaign=[utm_campaign]
    &utm_content=[utm_content]
    &email=[contact_email]
  NOTA: snippet aceita também `lead_name` (Contato → Nome) e `utm_medium`/`utm_term`
  se Guru permitir aumentar a URL no futuro. NÃO usar `name` puro — query var
  reservado do WP (gera 404).

Leads E2E desta sessão (sintéticos — fluxo validado, sem compra real):
  • lead 2b8f0cda-188b-4d69-bf0d-3b18a4a6822c (HOT path — sessão anterior, ainda
    vivo no DB; usado em testes de regressão hoje)
  • lead 979bc579-7aa0-4e50-bf81-cf7e5671accc (COLD path — Guru-style URL
    com lead_name explícito, validado em 2026-05-05 08:06)
  • lead 1404da92-a86a-43ba-98be-cfdc96016856 (COLD path — Guru-style URL real
    do Tiago: phone+email+utm_source/campaign/content, sem lead_name —
    validado E2E em 2026-05-05 08:16:
      lead_identify → PageView → custom:click_wpp_join
    todos com lead_id resolvido no DB)

  Lead 74f1d1bf-3666-49ac-a7c9-5f155e7895b6 (Framer) — obsoleto.

Pages WP pendentes (3): aula-workshop, oferta-principal, obrigado-principal.
  ADIADAS — lançamento real é só em junho. Foco agora: SendFlow webhook
  (T-13-011) pra fechar o circuito Contact server-side, depois Trilha A
  (Purchase real via Guru cartão).

Próxima ação:  Tiago decidiu priorizar SendFlow (T-13-011 — webhook inbound
  que dispara Contact event quando lead efetivamente entra no grupo WhatsApp).
  Pendência crítica antes de começar: doc do payload do webhook SendFlow
  (URL outbound, payload schema, auth method, identifier — phone? lead_token via
  query no link de convite?). Tiago precisa fornecer.

  Trilha A (Purchase real) destravada também — pode ser feita em paralelo
  ou depois do SendFlow. Trilhas anteriores:
  TRILHA A — Validar Purchase + Contact server-side (server fluxo completo):
    1. Comprar workshop via Guru com cartão real → webhook deve disparar
       Purchase → stage purchased_workshop preenchido no DB
    2. Após compra, ir pra obrigado-workshop, clicar no botão SendFlow,
       entrar no grupo. Verificar webhook SendFlow chegar no Edge
       (Sprint 13 / T-13-011 — adapter ainda não implementado).
       NOTA: SendFlow webhook ainda NÃO está implementado, então Contact
       não vai chegar — só a parte client (custom:click_wpp_join) está OK.
       T-13-011 deve ser priorizado.
  TRILHA B — Construir as 3 pages WP restantes (aula, oferta-principal, obrigado-principal)
    Mesma metodologia: editor Elementor → CSS IDs estáveis nos elementos
    chave → 2 snippets WPCode (HEAD + FOOTER) per page → URL no CP.
```

### Plano canônico de sprints restantes

- **Sprint 12** — Realinhamento template `lancamento_pago_workshop_com_main_offer` v3 (popup Lead, custom events de intent, page aula-workshop, click_wpp_join, survey_responded). Migração Framer → WordPress + Elementor + WPCode em andamento. Ver [`12-sprint-12-funil-paid-workshop-realinhamento.md`](docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md).
- **Sprint 13** (refocado 2026-05-05) — Funil B foundation: **phone normalizer BR-aware** (T-13-014, bloqueia tudo abaixo), **SendFlow inbound** (T-13-011), **survey form** (T-13-012, novo), **CP double-stringify fix** (T-13-013), **identity/Guru cleanups** (T-13-008/-009/-010), **cleanups S12** (T-13-005/-006). Ver [`13-sprint-13-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/13-sprint-13-webhooks-hotmart-kiwify-stripe.md). T-13-001..004 + T-13-007 migrados pro Sprint 14.
- **Sprint 14** (separado de 13 em 2026-05-05) — Webhook adapters Hotmart/Kiwify/Stripe (T-14-001..004) + cleanup Stripe signature off-by-one (T-14-005). Ver [`14-sprint-14-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/14-sprint-14-webhooks-hotmart-kiwify-stripe.md).

### O que foi entregue nesta sessão (Onda 4 — migração Framer → WordPress)

Decisões fechadas (D1-D4 da sessão, ver §8 também):
- D1: stage do click WhatsApp = `clicked_wpp_join` (custom:click_wpp_join)
- D2: `Contact` event NÃO é client — virá do webhook SendFlow (T-13-011)
- D3: ferramenta de grupos WhatsApp = SendFlow (`reference_sendflow.md`)
- D4: stage `survey_responded` mantido como placeholder paralelo a `wpp_joined`,
       audience `respondeu_pesquisa_sem_comprar_main` mantida; form de pesquisa
       virá em T-13-012 (Sprint 13)

Migration 0034 aplicada na cloud:
- Template global v3: 9 stages (clicked_wpp_join inserido entre purchased_workshop
  e wpp_joined). Sem mais campos `Purchase`/`Contact` no canonical da page
  obrigado-workshop (mas migration ainda mantém — corrigir runtime via CP, ver §2)
- Reset launch wkshop-cs-jun26: 5 pages com url=NULL, status=draft, event_config
  v3, tokens novos gerados (revogados antigos via run_reset_wkshop.mjs)

Tokens novos das 5 pages do `wkshop-cs-jun26` (DB só guarda hash):
- workshop:           `4beab6557f55b6fa0e0ee9c092fed94a2673eb7853ce502f486576e91a574093`
- obrigado-workshop:  `998909a7c3d7847565565f6aeea5d49e6d302badf1a81715a19e8a629b117d61`
- aula-workshop:      `2fff0549b63755594cac7b12e64369641faa87edcd4f690f4d10131f0178c77f`
- oferta-principal:   `1d8cace4ced117bfa9b252cb9dadd306b6b1c96f654580d03ec9c3f070e46413`
- obrigado-principal: `3d47f79b47f3de94589f3a7a44475ced06cdd1947a93bd67cb3889dbe1459993`

WordPress site de produção:
- Domínio: `contratosnovaeconomia.com.br`
- Stack: Hello Elementor + Elementor Pro 4.0 + WPCode Lite + WP Rocket + Wordfence
- Plugins decisões:
  - **PixelYourSite**: a desligar (Tiago confirmou opção A — GlobalTracker
    assume Meta CAPI server-side; mantê-lo causaria dedup hell)
  - **WPCode Lite**: instalado nesta sessão pra inserir snippets per-page
    com Smart Conditional Logic
  - **Wordfence**: bloqueia POST com `<script>` (proteção XSS) — usar
    "I am certain this is a false positive" → "Allowlist This Action"
    1× por padrão de request

Snippets canônicos atualizados em `apps/tracker/snippets/paid-workshop/`:
- `workshop.html` — popup Elementor + form atomic + redirect Guru com query
  (name, email, phone, utms)
- `obrigado-workshop.html` — drop survey form, drop Contact wire (vem de webhook)

E2E real validado em produção (sintético):
- Lead 2b8f0cda-188b-4d69-bf0d-3b18a4a6822c (workshop)
- 4 eventos `accepted`: PageView, custom:click_buy_workshop, lead_identify, Lead
- Redirect Guru: ?name=Teste+Tiago+E2E&email=teste-e2e@globaltracker.dev&phone=+5511988887777
- Sem completar Purchase real ainda — Trilha A da próxima sessão

Ambiente operacional sem mudanças (Edge prod / Tracker CDN / DB / etc.)

### Workaround importante (Elementor 4.0 + popup)

Tentativa frustrada: usar URL nativa `#elementor-action:action=popup:open&settings=...`
no link do botão. Elementor 4.0 (atomic) **strippa** essa URL no save (campo
fica vazio no DOM frontal).

**Caminho que funcionou (Opção C)**: snippet WPCode FOOTER hookar click via JS,
chamar `window.elementorProFrontend.modules.popup.showPopup({id: 342})`.
Robusto e funciona com qualquer popup Elementor.

(Histórico de bugs pré-migração — Edge hardening, CORS, cookies — preservado
abaixo)

Deploy operacional (sessões anteriores):
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
- Page tokens ATIVOS (5 pages do `wkshop-cs-jun26`, rotacionados 2026-05-05 via run_reset_wkshop.mjs após migration 0034):
  - workshop: `4beab6557f55b6fa0e0ee9c092fed94a2673eb7853ce502f486576e91a574093`
  - obrigado-workshop: `998909a7c3d7847565565f6aeea5d49e6d302badf1a81715a19e8a629b117d61`
  - aula-workshop: `2fff0549b63755594cac7b12e64369641faa87edcd4f690f4d10131f0178c77f` (page existe no DB, não no WP ainda)
  - oferta-principal: `1d8cace4ced117bfa9b252cb9dadd306b6b1c96f654580d03ec9c3f070e46413` (page existe no DB, não no WP ainda)
  - obrigado-principal: `3d47f79b47f3de94589f3a7a44475ced06cdd1947a93bd67cb3889dbe1459993` (page existe no DB, não no WP ainda)
- Tokens anteriores (Framer) revogados nesta sessão. Snippets do Framer obsoletos.

### Decisões já tomadas (não reabrir)

- ADR-001 a ADR-025 em `docs/90-meta/04-decision-log.md`
- OQ-012 ABERTA: GA4 client_id para comprador direto
- OQ-013 FECHADA → ADR-025: dispatch-replay cria novo job filho

### Como retomar em nova sessão

```
1. Ler §5 + §8 (estado Onda 4 + checkpoint Sprint 12 v3).
2. git log -5 + git status (working tree GRANDE pronto pra commit, ver §5).
3. Edge prod sem mudanças nesta sessão. Sanidade:
     curl https://globaltracker-edge.globaltracker.workers.dev/health
4. CP local quando precisar:
     cd apps/control-plane && pnpm dev
5. Próxima ação: escolher TRILHA A (Purchase via Guru cartão real + Contact via
   webhook SendFlow [T-13-011 ainda não implementado]) ou TRILHA B (construir
   3 pages WP restantes). Ver §5 "Próxima ação" detalhe.
6. Snippets canônicos versionados em apps/tracker/snippets/paid-workshop/:
     workshop.html          — atualizado (popup Elementor + form atomic + Guru redirect)
     obrigado-workshop.html — atualizado (drop survey, button #gt-btn-wpp-join)
     aula-workshop.html, oferta-principal.html, obrigado-principal.html — Framer-era,
       precisarão ser reescritos quando criarmos as pages WP correspondentes.
7. Para criar nova page WP no Sprint 12 (TRILHA B), padrão repetível:
   a) Editor Elementor → setar CSS ID estável nos elementos chave (botões/forms)
   b) WPCode Lite → 2 snippets (HEAD: tracker.js tag; FOOTER: bootstrap+wires)
       com Smart Conditional Logic = "page URL contém /<slug>/"
   c) Wordfence: ao salvar com <script>, allowlist a action específica
   d) WP Rocket: Limpar cache após cada update
   e) URL no CP local: http://localhost:3000/launches/wkshop-cs-jun26/pages/<public_id>
   f) E2E: navegar page → checar tracker carrega → simular click/submit →
      validar no DB (events + leads + lead_stage_history)
8. URL Guru workshop: https://clkdmg.site/pay/wk-contratos-societarios
   (URLs Guru das outras pages — main offer — Tiago vai fornecer próxima sessão)
9. Wordfence: usar "Allowlist This Action" 1× por padrão de request quando
   Wordfence bloquear. NÃO allowlistar IP (over-permissivo).
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

Onda 3 (CONCLUÍDA com lead 74f1d1bf — Framer):
  T-FUNIL-037 E2E real wkshop-cs-jun26 ponta-a-ponta — passos 1-4 ✓
              (passo 5+ não chegou a executar antes da decisão de migrar pra WP)

Onda 4 (EM ANDAMENTO 2026-05-05 madrugada — migração Framer → WordPress):
  Decisões da sessão (D1-D4 sprint-paid v3 — alvo de ADR-026 addendum):
    D1: stage clicked_wpp_join (custom:click_wpp_join)
    D2: Contact event vem do webhook SendFlow (T-13-011), NÃO client-side
    D3: ferramenta SendFlow registrada (memória ~/reference_sendflow.md)
    D4: survey_responded mantido como placeholder paralelo a wpp_joined
  T-FUNIL-048 migration 0034 paid_workshop v3                              ✓
  T-FUNIL-049 reset launch wkshop-cs-jun26 (run_reset_wkshop.mjs)           ✓
  T-FUNIL-050 atualizar snippets canônicos (workshop.html + obrigado-workshop.html) ✓
  T-FUNIL-051 page workshop WP — Elementor + popup + 2 snippets WPCode + E2E ✓
              (lead E2E 2b8f0cda-188b-4d69-bf0d-3b18a4a6822c)
  T-FUNIL-052 page obrigado-workshop WP — botão SendFlow + 2 snippets + E2E ✓
              (custom:click_wpp_join validado em DB)
  T-FUNIL-053 URL workshop preenchida no CP                                ✓
  T-FUNIL-054 page aula-workshop WP                                        ⏳ (lançamento jun)
  T-FUNIL-055 page oferta-principal WP                                     ⏳ (lançamento jun)
  T-FUNIL-056 page obrigado-principal WP                                   ⏳ (lançamento jun)
  T-FUNIL-057 Trilha A — Purchase via Guru cartão real                     ⏳ (destravado)

Sub-T-IDs criadas durante Onda 4 — sessão 2026-05-05 manhã (cold path validation):
  T-FUNIL-058 Edge fix event_config schema mismatch (ler canonical+custom em
              vez de allowed_event_names, parse defensivo string→object)        ✓
  T-FUNIL-059 Tracker fix race init→identify (init não zera state.leadToken
              quando cookie __ftk vazio, preserva o que identify setou)         ✓
  T-FUNIL-060 Snippet obrigado-workshop COLD PATH — lê params da URL,
              strippa PII via history.replaceState, POST /v1/lead defensivo
              cross-device, re-identify defensivo no click                      ✓
              (validado E2E com lead 1404da92 via URL Guru-style)
  T-FUNIL-061 DB normalize event_config double-stringified rows
              (workshop, obrigado-workshop)                                     ✓
  T-FUNIL-062 Renomear page obrigado-workshop slug /wk-obg/ + URL no CP        ✓

Onda 5 (após Onda 4):
  T-FUNIL-038 br-auditor pré-merge
```

### Bugs encontrados e workarounds durante Onda 4 (migração WP — 2026-05-05 madrugada)

| # | Bug | Solução |
|---|---|---|
| O4-1 | Elementor 4.0 (atomic) **strippa** `#elementor-action:action=popup:open&settings=...` no save → href fica vazio | Opção C (JS direto): snippet WPCode FOOTER chama `window.elementorProFrontend.modules.popup.showPopup({id})` ao click. Robusto e funciona com qualquer popup. |
| O4-2 | Elementor 4.0 popup trigger "Ao clicar" não tem campo selector específico — só conta cliques globais | Não usar trigger nativo. JS direto + showPopup() (mesma solução O4-1). |
| O4-3 | Wordfence bloqueia POSTs do admin com `<script>` (proteção XSS WAF) → 403 ao salvar snippet WPCode | Allowlist da action específica (NÃO IP) via tela de bloqueio: marca "I am certain this is a false positive" + "Allowlist This Action". 1× por padrão de request. |
| O4-4 | "Ações após o envio = E-mail" no atomic form atomic dispara email automatico, conflita com submit handler do GT | Desligar a ação no painel do form. Nosso JS toma o submit. |
| O4-5 | Atomic form: `name` dos inputs mutável via campo "ID" (não óbvio — mesmo nome do "CSS ID") | Renomear pra `name`/`email`/`phone`. |
| O4-6 | CSS ID do widget Botão Elementor vai pro **wrapper DIV**, não no `<a>` interno | Selector compatível: `#gt-btn-buy-workshop1 a, #gt-btn-buy-workshop1`. |
| O4-7 | Page workshop tinha 5 CTAs externos `#checkout` (scroll only) + 1 dentro de #checkout. Decisão D5: só o de dentro de #checkout é o intent | CTAs externos sem listener (só scroll UX). 1 botão `#gt-btn-buy-workshop1` = `custom:click_buy_workshop` + abre popup. |
| O4-8 | `/v1/config` retornava `allowed_event_names: []` mesmo com event_config populado no DB → todos eventos client-side eram rejeitados pelo Edge | Schema mismatch: Edge lia `ec.allowed_event_names` mas DB usa `{canonical, custom}`. Fix em `apps/edge/src/index.ts:248-282`: monta lista a partir de canonical + `custom:`-prefixed, com parse defensivo string→object. Deploy `dff44d61`. |
| O4-9 | event_config das pages `workshop` e `obrigado-workshop` armazenado como **string JSON dentro do JSONB** (double-stringify), enquanto outras 3 pages estão como objeto. Causa: bug no save handler do CP. | UPDATE manual: `event_config = (event_config #>> '{}')::jsonb WHERE jsonb_typeof(event_config)='string'`. Edge fix (O4-8) também tem parse defensivo p/ proteção. Bug do save handler virou T-13-013 (Sprint 13). |
| O4-10 | Tracker `init()` zerava `state.leadToken` que o snippet acabou de setar via `Funil.identify(token)` (token de localStorage). PageView levava token, mas custom events 25s+ depois iam anônimos. | Race init/snippet: snippet roda no DOMContentLoaded, init é async (fetch /v1/config). Fix em `apps/tracker/src/index.ts:175`: `if (leadToken) setLeadToken(leadToken)` — preserva o que identify setou quando cookie está vazio. + re-identify defensivo no click handler do snippet. |
| O4-11 | URL `/wk-obg/?name=foo` retorna 404 do WP. `name` é query var reservado do WordPress (lookup de post por slug). | Snippet usa `lead_name` na URL, mantém `body.name` no schema do `/v1/lead`. Documentado no header do snippet — qualquer page nova evitar `name` cru. |
| O4-12 | Limite de chars do redirect Guru: aceita só ~5 params. | Configurar prioridade: phone + email + utm_source/campaign/content. Snippet aceita todos os 8 keys, mas degrada graciosamente se Guru mandar subconjunto. |

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
