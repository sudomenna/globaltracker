# Sprint 12 — Funil Pago Workshop: Realinhamento E2E ao Fluxo Operacional Real

## Duração estimada
3–5 dias.

## Objetivo
Realinhar o template `lancamento_pago_workshop_com_main_offer` (e o launch real `wkshop-cs-jun26` em produção) com o fluxo operacional descoberto durante o E2E usability test. O template atual diverge do fluxo real em **stages, pages e event_config**: assume múltiplas aulas (`watched_class_1/2/3`) quando o workshop é evento único; espera `InitiateCheckout` client-side quando o IC só é capturável via Guru webhook (a investigar); não prevê stages de `survey_responded` nem page de aula separada; e tem event_config defasado (faltam `Lead` na captura, `Contact` + `survey_responded` na thankyou).

Esta entrega fecha o gap, atualiza o template canônico, realinha o launch existente em produção, produz body scripts Framer canônicos versionados e valida E2E real com Tiago como usuário operando o lançamento `wkshop-cs-jun26`.

## Pré-requisitos
- Sprint 11 completo (webhook Guru com `funnel_role` injetado, mapping `prod_id ↔ launch + funnel_role` cadastrado).
- Launch `wkshop-cs-jun26` ativo em produção (Edge Worker + tracker.js R2 + pages Framer instaladas).
- Mapping Guru já cadastrado para os 2 produtos (workshop + main_offer) — confirmado pelo operador.
- Página da aula ainda não definida quanto à plataforma; MVP usa botão "Já assisti" como proxy binário (decisão do operador, evolução futura possível para Zoom webhook attendance ou heartbeat Vimeo).

## Decisões fechadas (operador, sessão de 2026-05-04)

| ID | Decisão | Implicação |
|---|---|---|
| D1 | `InitiateCheckout` virá do Guru (load do checkout ou webhook intermediário, **a investigar pós-sprint**) | IC fica fora dos stages de funil neste sprint; entra como input futuro para dispatcher Meta CAPI |
| D2 | Após Purchase do workshop, lead é redirecionado para `obrigado-workshop` que é página de **pesquisa** + botão WhatsApp | `obrigado-workshop` muda papel: pesquisa primeiro, botão wpp ao final |
| D3 | Aula em page separada `aula-workshop` (role=`webinar`); MVP binário com botão "Já assisti" | Page nova no template; evolução para Zoom/Vimeo planejada pós-sprint |
| D4 | Tracking da aula = **binário** (`custom:watched_workshop`) | 1 stage só; sem `_25/_50/_90` por enquanto |
| D5 | Click "Quero Comprar" antes da popup vira stage `clicked_buy_workshop` via `custom:click_buy_workshop` | Custom event client-side; iOS funciona via first-party fetch ao Edge Worker |
| D6 | `oferta-principal` **sem popup**; `clicked_buy_main` vem de `custom:click_buy_main` no botão da page main | Page main perde Lead do event_config; ganha custom event de intent |

Documentado em `docs/90-meta/04-decision-log.md` como ADR-026 (a criar em T-FUNIL-037).

## Critério de aceite global

- [ ] Template `lancamento_pago_workshop_com_main_offer` no DB atualizado para a nova forma (8 stages, 5 pages, 6 audiences) — ver §Forma canônica.
- [ ] Launch `wkshop-cs-jun26` realinhado: `funnel_blueprint` snapshot atualizado, pages atualizadas/criadas, audiences scaffoldadas via mesmo blueprint.
- [ ] 4 body scripts Framer canônicos versionados em `apps/tracker/snippets/paid-workshop/` + page `aula-workshop` nova.
- [ ] Verificação E2E real: lead percorre os 8 stages; `lead_stages` populada na ordem esperada; audiences segmentam corretamente.
- [ ] Doc-sync: `funil-templates-plan.md`, `06-mod-funnel.md`, `02-mod-launch.md`, `03-mod-page.md` refletem a nova forma do template.
- [ ] ADR-026 registra D1–D6.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` verdes.

## Forma canônica (alvo do realinhamento)

### Stages (8) — `lancamento_pago_workshop_com_main_offer` v2

| ordem | slug | label | source_events | source_event_filters | is_recurring |
|---|---|---|---|---|---|
| 1 | `clicked_buy_workshop` | Clicou comprar workshop | `["custom:click_buy_workshop"]` | — | true |
| 2 | `lead_workshop` | Lead identificado (workshop) | `["Lead"]` | — | false |
| 3 | `purchased_workshop` | Comprou workshop | `["Purchase"]` | `{"funnel_role":"workshop"}` | false |
| 4 | `survey_responded` | Respondeu pesquisa | `["custom:survey_responded"]` | — | false |
| 5 | `wpp_joined` | Entrou no WhatsApp | `["Contact"]` | — | false |
| 6 | `watched_workshop` | Assistiu workshop | `["custom:watched_workshop"]` | — | false |
| 7 | `clicked_buy_main` | Clicou comprar oferta principal | `["custom:click_buy_main"]` | — | true |
| 8 | `purchased_main` | Comprou oferta principal | `["Purchase"]` | `{"funnel_role":"main_offer"}` | false |

> **Reorder cronológico (refinamento pós-ADR-026, 2026-05-04).** Em fluxo real, o lead clica `Quero Comprar` antes do form de captura — `clicked_buy_workshop` é entrada de funil; `lead_workshop` segue após preenchimento do form. Reorder aplicado via migration `0032_reorder_stages_paid_workshop_v2.sql` (idempotente, espelhada em `supabase/migrations/`). Nenhuma das 6 audiences do template usa `stage_gte` com `lead_workshop`/`clicked_buy_workshop`, então sem regressão funcional. T-FUNIL-040 (DSL canônica de `stage_gte`) preserva semântica.

### Pages (5)

| public_id | role | suggested_funnel_role | event_config.canonical | event_config.custom |
|---|---|---|---|---|
| `workshop` | `sales` | `workshop` | `["PageView","Lead"]` | `["click_buy_workshop"]` |
| `obrigado-workshop` | `thankyou` | `workshop` | `["PageView","Purchase","Contact"]` | `["survey_responded"]` |
| `aula-workshop` | `webinar` | `workshop` | `["PageView"]` | `["watched_workshop"]` |
| `oferta-principal` | `sales` | `main_offer` | `["PageView","ViewContent"]` | `["click_buy_main"]` |
| `obrigado-principal` | `thankyou` | `main_offer` | `["PageView","Purchase"]` | `[]` |

### Audiences (6)

| slug | nome | platform | query_template |
|---|---|---|---|
| `compradores_workshop_aquecimento` | Compradores workshop — aquecimento | meta | `{"stage_eq":"purchased_workshop","stage_not":"purchased_main"}` |
| `respondeu_pesquisa_sem_comprar_main` | Respondeu pesquisa, sem comprar main | meta | `{"stage_eq":"survey_responded","stage_not":"purchased_main"}` |
| `engajados_workshop` | Engajados no workshop | meta | `{"stage_gte":"watched_workshop"}` |
| `abandono_main_offer` | Abandono oferta principal | meta | `{"stage_eq":"clicked_buy_main","stage_not":"purchased_main"}` |
| `compradores_main` | Compradores oferta principal | meta | `{"stage_eq":"purchased_main"}` |
| `nao_compradores_workshop_engajados` | Engajados workshop, sem compra | meta | `{"stage_gte":"watched_workshop","stage_not":"purchased_main"}` |

> **Diferenças vs blueprint atual** (template `lancamento_pago_workshop_com_main_offer` em `0029_funnel_templates.sql`):
> - Removidos: `watched_class_1/2/3` (substituídos por `watched_workshop` único).
> - Removidos: stages `clicked_buy_workshop` (IC) e `clicked_buy_main` (IC) — versões IC esperavam `InitiateCheckout` que não temos client-side; substituídos por custom events de intent.
> - Adicionado: `survey_responded`.
> - Pages: `oferta-principal` perde `InitiateCheckout` do event_config (vai vir do Guru); `workshop` ganha `Lead`; `obrigado-workshop` ganha `Contact` + `custom:survey_responded`; **page nova `aula-workshop`** (role=`webinar`); `obrigado-principal` confirmado como page do template (não estava sendo criada na prática).
> - Audiences: removida `compradores_apenas_workshop` (duplicata de `compradores_workshop_aquecimento`); adicionada `respondeu_pesquisa_sem_comprar_main`; `engajados_workshop` migra de `watched_class_1` para `watched_workshop`; adicionada `nao_compradores_workshop_engajados`.

---

## T-IDs — decomposição completa

> `parallel-safe=yes` = pode rodar em paralelo na mesma onda (ownership disjunto).

### Tabela mestre

| T-ID | Tipo | Título | Onda | parallel-safe | Deps | Agente |
|---|---|---|---|---|---|---|
| T-FUNIL-030 | schema | Migration `0031_funnel_template_paid_workshop_v2.sql` — UPDATE template + UPSERT pages + UPDATE launch wkshop-cs-jun26 + audiences | 1 | **no** | Sprint 11 | schema-author |
| T-FUNIL-031 | tracker | Body scripts Framer canônicos das 4 pages existentes (`workshop`, `obrigado-workshop`, `oferta-principal`, `obrigado-principal`) | 1 | yes | — | tracker-author |
| T-FUNIL-032 | tracker | Body script Framer + setup da page nova `aula-workshop` (role=webinar) | 1 | yes | T-FUNIL-030 (page criada) | tracker-author |
| T-FUNIL-033 | test | Testes integration: cada custom event (`click_buy_workshop`, `survey_responded`, `watched_workshop`, `click_buy_main`) cria stage correto via processor | 2 | yes | T-FUNIL-030 | test-author |
| T-FUNIL-034 | test | Teste integration: `engajados_workshop` audience usa `watched_workshop` (não `watched_class_*`); `respondeu_pesquisa_sem_comprar_main` exclui leads que compraram main | 2 | yes | T-FUNIL-030 | test-author |
| T-FUNIL-035 | docs-sync | Atualizar `06-mod-funnel.md`, `02-mod-launch.md`, `03-mod-page.md`, `funil-templates-plan.md` com forma v2 do template | 2 | yes | T-FUNIL-030 | docs-sync |
| T-FUNIL-036 | docs-sync | ADR-026 em `04-decision-log.md` documentando D1–D6 + atualizar `MEMORY.md §2` removendo entradas resolvidas | 2 | yes | — | docs-sync |
| T-FUNIL-037 | e2e-real | Verificação E2E real no `wkshop-cs-jun26` em produção — Tiago como operador percorre os 8 stages | 3 | **no** | T-FUNIL-030..036 | (humano + Claude assistindo via SQL/CP) |
| T-FUNIL-038 | br-auditor | Auditoria pré-merge final — BRs aplicáveis citadas em código, INV-FUNNEL-001..004 íntegros | 4 | **no** | T-FUNIL-030..037 | br-auditor |

---

## Plano de ondas

> Verificação `pnpm typecheck && pnpm lint && pnpm test` entre cada onda.

### Onda 1 — Migration + body scripts (3 em paralelo, com 1 dep ordenada)

> Ownership: T-FUNIL-030 = `packages/db/migrations/`, `supabase/migrations/`, `packages/db/src/schema/`. T-FUNIL-031 = `apps/tracker/snippets/paid-workshop/` (arquivos novos, sem conflito). T-FUNIL-032 = mesmo diretório, mas arquivo distinto da page nova; depende de T-FUNIL-030 ter criado a row da page no DB para o `data-page-public-id` ser válido.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-030** | `packages/db/migrations/0031_funnel_template_paid_workshop_v2.sql`, `supabase/migrations/20260504000031_funnel_template_paid_workshop_v2.sql` (espelhar — convenção do projeto) | (1) `UPDATE funnel_templates SET blueprint = ...` para slug `lancamento_pago_workshop_com_main_offer` com a forma canônica de §Forma canônica (8 stages, 5 pages, 6 audiences). Validar contra `FunnelBlueprintSchema` antes de aplicar (rodar `pnpm tsx scripts/validate-blueprint.ts` ou inline). (2) `UPDATE launches SET funnel_blueprint = (mesmo objeto)` para o launch com `public_id = 'wkshop-cs-jun26'` AND `workspace_id = '74860330-a528-4951-bf49-90f0b5c72521'`. (3) `INSERT ... ON CONFLICT DO UPDATE` em `pages` para os 5 public_ids (`workshop`, `obrigado-workshop`, `aula-workshop`, `oferta-principal`, `obrigado-principal`) do launch `wkshop-cs-jun26` com role + event_config alinhados; criar token (page_token) novo para `aula-workshop` e `oferta-principal`/`obrigado-principal` se ainda não existirem (ver `page_tokens` table). (4) `INSERT ... ON CONFLICT DO UPDATE` em `audiences` para os 6 slugs filtrados pelo launch. (5) NÃO apagar `lead_stages` históricos (não interferir com dados de teste anteriores). (6) Migration idempotente (re-run não duplica). |
| **T-FUNIL-031** | `apps/tracker/snippets/paid-workshop/workshop.html`, `obrigado-workshop.html`, `oferta-principal.html`, `obrigado-principal.html` (novos arquivos) | Cada arquivo contém: (a) snippet `<head>` com tracker.js + atributos `data-*` (template de tokens — preencher com tokens reais do `wkshop-cs-jun26` em produção). (b) snippet `<body>` com handlers específicos. **`workshop.html`**: form selector atual (`.framer-150ieha`), inputs `[name="Name"]` e `[name="Phone"]`. Listener no botão "Quero Comprar" antes da popup → `Funil.track('custom:click_buy_workshop')`. Submit do form → POST `/v1/lead` (com `credentials: 'include'`) → ao retornar, `localStorage.setItem('__gt_ftk', token)` + `Funil.identify(token)` + `Funil.track('Lead')`. Dedup `firing` flag por 3s. **`obrigado-workshop.html`**: lê `__gt_ftk` do localStorage → `Funil.identify(token)` → `Funil.page()` (envia PageView+Purchase quando aplicável). Submit do form de pesquisa → `Funil.track('custom:survey_responded', { responses: ... })`. Click no botão WhatsApp final → `Funil.track('Contact')`. **`oferta-principal.html`**: PageView + ViewContent automáticos (via auto_page_view + tracker default). Listener no botão "Quero Comprar" → `Funil.track('custom:click_buy_main')`. Sem popup. **`obrigado-principal.html`**: lê `__gt_ftk` → `Funil.identify(token)` → `Funil.page()` (Purchase chega via webhook Guru, page só registra PageView). Cada arquivo tem comentário no topo explicando uso e tokens. |
| **T-FUNIL-032** | `apps/tracker/snippets/paid-workshop/aula-workshop.html` (novo) | (a) snippet `<head>` com tracker.js + `data-page-public-id="aula-workshop"`. (b) snippet `<body>`: lê `__gt_ftk` → `Funil.identify(token)` → `Funil.page()`. Botão "Já assisti" → `Funil.track('custom:watched_workshop')`. Comentário no topo explicando MVP binário e como evoluir para Zoom/Vimeo no futuro. **Dependência**: a row em `pages` table com `public_id='aula-workshop'` deve existir (criada em T-FUNIL-030) para que o page_token usado no snippet seja válido. |

**Verificação após onda 1:**
```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm db:generate     # confirma diff zero (migration já aplicada manualmente em prod)
```
Aplicar migration na cloud Supabase via `pnpm db:push:cloud` (ou comando equivalente do projeto). Verificar que `funnel_templates` e `launches.funnel_blueprint` têm a forma esperada (`SELECT blueprint FROM funnel_templates WHERE slug = 'lancamento_pago_workshop_com_main_offer'`).

---

### Onda 2 — Testes + docs (4 em paralelo)

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-033** | `tests/integration/funil/paid-workshop-v2/custom-events.test.ts` | Vitest. Cenários: (1) `custom:click_buy_workshop` em raw_events → `lead_stages` row com `stage='clicked_buy_workshop'` (matching exato no processor, sem normalização de prefixo). (2) `custom:survey_responded` → `survey_responded`. (3) `custom:watched_workshop` → `watched_workshop`. (4) `custom:click_buy_main` → `clicked_buy_main`. (5) Custom event não mapeado (ex.: `custom:foo`) NÃO cria stage. Mínimo 5 testes verdes. |
| **T-FUNIL-034** | `tests/integration/funil/paid-workshop-v2/audiences.test.ts` | (1) Lead com `watched_workshop` aparece em audience `engajados_workshop` (e não em `engajados_workshop` baseado no schema antigo `watched_class_1`). (2) Lead com `survey_responded` aparece em `respondeu_pesquisa_sem_comprar_main`; após Purchase main_offer ele sai dessa audience no próximo sync. (3) Lead com `purchased_workshop` AND `watched_workshop` AND NOT `purchased_main` aparece em `nao_compradores_workshop_engajados`. (4) Audience `compradores_apenas_workshop` **não existe mais** após migration (foi removida). Mínimo 4 testes verdes. |
| **T-FUNIL-035** | `docs/20-domain/06-mod-funnel.md`, `docs/20-domain/02-mod-launch.md`, `docs/20-domain/03-mod-page.md`, `docs/80-roadmap/funil-templates-plan.md` | Atualizar: (1) `06-mod-funnel.md` — bloco "Templates pré-existentes" reflete novo schema do `lancamento_pago_workshop_com_main_offer` v2; tabela de stages atualizada; nota explicando que IC virá do Guru webhook (futuro) e por enquanto stages são via custom events client-side. (2) `02-mod-launch.md` — exemplo do `funnel_blueprint` atualizado se referenciar este template. (3) `03-mod-page.md` — incluir role `webinar` na lista de exemplos (já existe no enum, mas não estava destacado); adicionar exemplo de page de aula com `custom:watched_workshop`. (4) `funil-templates-plan.md` — seção "Funil B" reflete forma v2; nota de "evolução pós-Sprint 12" listando: Zoom webhook, Vimeo heartbeat, IC do Guru. |
| **T-FUNIL-036** | `docs/90-meta/04-decision-log.md`, `MEMORY.md §2` | Criar ADR-026 com título "Realinhamento template paid_workshop com fluxo operacional real (Sprint 12)". Bullet points D1–D6 da §Decisões fechadas. Listar implicações pendentes (IC via Guru, Zoom/Vimeo). Em `MEMORY.md §2`, remover entradas que se tornaram obsoletas com este sprint (verificar quais; provavelmente nenhuma direta, mas confirmar). |

**Verificação após onda 2:**
```bash
pnpm typecheck && pnpm lint && pnpm test
```
Mínimo 9 novos testes verdes (5 + 4).

---

### Onda 3 — E2E real em produção (serial, humano-in-the-loop)

| T-ID | Critério de aceite |
|---|---|
| **T-FUNIL-037** | Tiago, como operador real do `wkshop-cs-jun26`, cola os snippets de Onda 1 nas pages Framer correspondentes; cria a page Framer nova `aula-workshop` (URL real a definir, ex.: `cneeducacao.com/aula-workshop`); e percorre o fluxo completo num device de teste, simulando 1 lead real do início ao fim. Claude acompanha em sessão e verifica via SQL: (1) PageView na page workshop → registrado em `events`. (2) Click "Quero Comprar" → `custom:click_buy_workshop` em `events`; lead anônimo. (3) Submit form → `Lead` em `events` + `lead_stages` row `lead_workshop`. (4) Compra Guru workshop → webhook recebido com `funnel_role=workshop` → `purchased_workshop` em `lead_stages`. (5) Redirect para obrigado-workshop → PageView + identify funciona via localStorage. (6) Submit pesquisa → `custom:survey_responded` → stage `survey_responded`. (7) Click WhatsApp → `Contact` → stage `wpp_joined`. (8) Acesso a `aula-workshop` → click "Já assisti" → `custom:watched_workshop` → stage `watched_workshop`. (9) Acesso a `oferta-principal` → click comprar → `custom:click_buy_main` → stage `clicked_buy_main`. (10) Compra Guru main → webhook com `funnel_role=main_offer` → stage `purchased_main`. (11) Audience sync rodado: `compradores_main` inclui o lead; `respondeu_pesquisa_sem_comprar_main` exclui (porque agora comprou main). Documentar timing de cada stage e quaisquer atritos UX descobertos em `MEMORY.md §7` para iteração pós-sprint. |

---

### Onda 4 — Auditoria pré-merge (serial)

| T-ID | Critério de aceite |
|---|---|
| **T-FUNIL-038** | Auditor verifica: (1) Migration `0031` é idempotente e não destrói dados (re-run = noop). (2) `funnel_blueprint` atualizado bate com `FunnelBlueprintSchema` (Zod). (3) Custom events (`custom:*`) não vazam PII no payload — apenas stage descriptors. (4) BR-EVENT-001..NNN aplicáveis a custom events estão honradas (ex.: rate limit, validação de event_name). (5) BR-WEBHOOK-001..004 ainda íntegras no Guru webhook (sem regressão). (6) BR-IDENTITY-005 (cookie/localStorage) honrada nos novos body scripts. (7) INV-FUNNEL-001..004 íntegros (template seed mantém `is_system=true`, `workspace_id=NULL`, slug único). Relatório de OK/missing/gaps. |

---

## Grafo de dependências

```
Onda 1 (1 sequencial + 2 paralelos):
  T-FUNIL-030 (schema, serial — base de tudo)
       ├── T-FUNIL-031 (tracker, paralelo)
       └── T-FUNIL-032 (tracker, paralelo)

Onda 2 (4 paralelos, deps de onda 1):
  T-FUNIL-033 (test, ← T-030)
  T-FUNIL-034 (test, ← T-030)
  T-FUNIL-035 (docs, ← T-030)
  T-FUNIL-036 (docs ADR, sem deps técnicas)

Onda 3 (serial humano):
  T-FUNIL-037 (E2E real, ← T-030..036)

Onda 4 (serial auditor):
  T-FUNIL-038 (br-auditor, ← T-030..037)
```

---

## Notas técnicas

### Idempotência da migration (T-FUNIL-030)

A migration deve poder ser executada múltiplas vezes sem efeito colateral. Padrão:

```sql
-- Template
UPDATE funnel_templates
   SET blueprint = $json$ ... $json$::jsonb,
       updated_at = now()
 WHERE slug = 'lancamento_pago_workshop_com_main_offer'
   AND workspace_id IS NULL;

-- Launch (snapshot)
UPDATE launches
   SET funnel_blueprint = (SELECT blueprint FROM funnel_templates WHERE slug = 'lancamento_pago_workshop_com_main_offer' AND workspace_id IS NULL)
 WHERE public_id = 'wkshop-cs-jun26'
   AND workspace_id = '74860330-a528-4951-bf49-90f0b5c72521';

-- Pages: UPSERT por (launch_id, public_id)
INSERT INTO pages (...)
VALUES (...)
ON CONFLICT (launch_id, public_id) DO UPDATE
   SET role = EXCLUDED.role,
       event_config = EXCLUDED.event_config,
       updated_at = now();
```

### Page tokens novos

Pages criadas neste sprint (`aula-workshop` se nova, `oferta-principal` e `obrigado-principal` se ainda não tinham token) precisam de `page_token` correspondente. Verificar `page_tokens` table — gerar via `crypto.randomBytes(32).toString('hex')` e inserir. Tiago precisa dos tokens em hand para colar no `data-site-token` do Framer.

### Custom event matching

O processor (`raw-events-processor.ts:330`) faz match exato por `event_name`. Body scripts devem chamar `Funil.track('custom:click_buy_workshop')` com prefixo. Testar isso explicitamente em T-FUNIL-033.

### Cross-page identity (localStorage)

Já implementado em `__gt_ftk`. Body scripts precisam ler/escrever consistentemente. Em iOS Safari, ITP pode reduzir TTL do localStorage para 7 dias se o domínio não for visitado — para o flow do workshop (sessão curta de minutos a horas), funciona; para fluxo cross-week (compra workshop hoje, assiste aula em 3 dias, compra main em 7 dias), risco baixo mas presente. Mitigação futura: alguns providers (CleverTap, Segment) usam fingerprinting para sobreviver à expiração — fora do escopo deste sprint.

### Sobre IC do Guru (D1 — investigação pós-sprint)

A captura do `InitiateCheckout` do Guru fica como **work pendente** após este sprint. Hipóteses a investigar:
- Guru tem evento `CHECKOUT_INITIATED` ou similar no webhook? Verificar docs Digital Manager Guru.
- Possibilidade de injetar pixel próprio (Meta Pixel custom + JS) na página de checkout do Guru? Depende do plano e da custom domain feature.
- Alternativa: reverse-proxy do checkout via Cloudflare Worker (intercepta load) — complexo, não MVP.

Documentar resultado da investigação em ADR separado (ADR-027 ou seguinte) e potencialmente Sprint 14.

### Sobre tracking da aula (D3/D4 — evolução pós-MVP)

MVP binário com botão "Já assisti" funciona, mas tem viés (operador clica sem assistir). Evolução planejada:
1. **Zoom Webinar/Meeting**: webhook `webinar.participant_joined`/`participant_left` com `duration` por participante. Match por email do lead. Cria stages `attended_workshop_5min`, `attended_workshop_30min` etc. — granularidade configurável.
2. **Vimeo Live + heartbeat**: player embedded; heartbeat a cada 30s via `Funil.track('custom:watched_heartbeat', { sec: N })`. Stages calculados pelo processor (ou job batch) somando heartbeats.

Nenhuma destas é MVP — Sprint 12 entrega binário, evoluções ficam em backlog.

---

## Verificação E2E final (consolidação T-FUNIL-037)

Cenário canônico do Funil B v2, ponta-a-ponta em produção real (`wkshop-cs-jun26`):

1. Lead anônimo abre `cneeducacao.com/captura-v1` (page `workshop`).
   - Esperado: `events.event_name=PageView`.
2. Lead clica botão "Quero Comprar".
   - Esperado: `events.event_name='custom:click_buy_workshop'`. Lead ainda anônimo (sem `lead_id`).
3. Popup abre; lead preenche Nome + WhatsApp; submit.
   - Esperado: POST `/v1/lead` retorna `lead_token`; `events.event_name=Lead` com `lead_id=<X>`; `lead_stages` row `(lead_id=X, stage=lead_workshop)`. Stage `clicked_buy_workshop` registrado retroativamente NÃO acontece (não é o comportamento atual; o evento anônimo permanece sem `lead_id`, mas isso é OK para a audience — apenas o stage do lead identificado conta para o funil).
4. Lead redirecionado para checkout Guru; preenche; compra workshop.
   - Esperado: webhook Guru chega com `product.id` mapeado para `funnel_role=workshop`; `events.event_name=Purchase`, `payload.funnel_role=workshop`; `lead_stages` row `(lead_id=X, stage=purchased_workshop)`.
5. Guru redireciona para `cneeducacao.com/obrigado-workshop`.
   - Esperado: tracker.js carrega; `__gt_ftk` no localStorage usado para identify; `events.event_name=PageView` com `lead_id=X`.
6. Lead preenche pesquisa; submete.
   - Esperado: `events.event_name='custom:survey_responded'` com `lead_id=X`; `lead_stages` row `(lead_id=X, stage=survey_responded)`.
7. Lead clica botão WhatsApp ao final da pesquisa.
   - Esperado: `events.event_name=Contact`; `lead_stages` row `(lead_id=X, stage=wpp_joined)`.
8. Lead acessa `cneeducacao.com/aula-workshop`.
   - Esperado: `events.event_name=PageView` com `lead_id=X`.
9. Lead clica botão "Já assisti".
   - Esperado: `events.event_name='custom:watched_workshop'`; `lead_stages` row `(lead_id=X, stage=watched_workshop)`.
10. Lead acessa `cneeducacao.com/oferta-principal`.
    - Esperado: `events` PageView + ViewContent com `lead_id=X`.
11. Lead clica botão "Comprar Oferta Principal".
    - Esperado: `events.event_name='custom:click_buy_main'`; `lead_stages` row `(lead_id=X, stage=clicked_buy_main)`.
12. Lead redirecionado para checkout Guru main; compra.
    - Esperado: webhook Guru com `funnel_role=main_offer`; `lead_stages` row `(lead_id=X, stage=purchased_main)`.
13. Audience sync manual.
    - Esperado:
      - `compradores_main` inclui lead X.
      - `compradores_workshop_aquecimento` NÃO inclui (tem purchased_main).
      - `respondeu_pesquisa_sem_comprar_main` NÃO inclui (tem purchased_main).
      - `engajados_workshop` inclui (tem watched_workshop).
      - `nao_compradores_workshop_engajados` NÃO inclui (tem purchased_main).

Validação SQL canônica:
```sql
-- Estados do lead X após o fluxo completo
SELECT stage, created_at FROM lead_stages WHERE lead_id = '<X>' ORDER BY created_at;
-- Esperado (em ordem):
--   lead_workshop, purchased_workshop, survey_responded, wpp_joined, watched_workshop, clicked_buy_main, purchased_main
-- (Nota: ordem cronológica; clicked_buy_workshop não aparece por estar no anônimo pré-Lead.)
```

---

## Referências

- [`docs/80-roadmap/funil-templates-plan.md`](funil-templates-plan.md) — plano original do template (Fase 2).
- [`docs/80-roadmap/11-sprint-11-funil-webhook-guru.md`](11-sprint-11-funil-webhook-guru.md) — webhook Guru com `funnel_role` (pré-requisito).
- [`docs/20-domain/06-mod-funnel.md`](../20-domain/06-mod-funnel.md) — domínio do funil.
- [`docs/30-contracts/03-timeline-event-catalog.md`](../30-contracts/03-timeline-event-catalog.md) — eventos canônicos + custom.
- [`docs/40-integrations/13-digitalmanager-guru-webhook.md`](../40-integrations/13-digitalmanager-guru-webhook.md) — webhook Guru.
- [`packages/db/migrations/0029_funnel_templates.sql`](../../packages/db/migrations/0029_funnel_templates.sql) — seed atual a sobrescrever.
- [`packages/shared/src/schemas/funnel-blueprint.ts`](../../packages/shared/src/schemas/funnel-blueprint.ts) — schema canônico do blueprint.
- `MEMORY.md §7` — estado do E2E test e bugs corrigidos da sessão de 2026-05-04.
