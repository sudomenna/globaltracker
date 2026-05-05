# Plano: Funis configuráveis para infoprodutos

## Contexto

Você opera o GlobalTracker para rodar lançamentos de infoprodutos. Hoje o sistema permite criar `launch` + `pages`, mas a UI esconde 80% do domínio que já existe (page.role, event_config, lead_stages, audience DSL). E falta o conceito de "funil" como blueprint reutilizável: cada lançamento novo é setup manual de pages + audiences + mapeamento de eventos para estágios.

Você descreveu dois fluxos canônicos que precisa rodar repetidamente:

**Funil A — Lançamento Gratuito (3 aulas)**
1. Anúncios/orgânico convidam para 3 aulas gratuitas
2. Captura → page de captura → form (evento Lead)
3. Lead entra no grupo WhatsApp (evento Contact)
4. Remarketing de aquecimento (lembretes, contagem regressiva)
5. Aulas acontecem ao vivo; clicks em links/contagem de presença (ViewContent / custom:watched_class_N)
6. Page de vendas do produto principal → click "Comprar" (InitiateCheckout)
7. Checkout no Guru → Purchase do produto principal (high ticket)

**Funil B — Lançamento Pago (workshop low ticket + main offer)**
1. Anúncios convidam para WORKSHOP PAGO (low ticket — "pé na porta")
2. Page de captura paga → checkout do workshop (3 possibilidades: direto Guru / checkout no domínio próprio com nosso script / popup intermediário de Lead)
3. Compra do workshop = **primeiro Purchase (low ticket)**
4. Comprador entra no grupo WhatsApp do workshop
5. Remarketing de aquecimento e workshop acontece (mesma estrutura de aulas)
6. ViewContent durante as aulas
7. **AO FINAL**: page de vendas do produto principal (high ticket) → InitiateCheckout
8. **Segundo Purchase via Guru** — main offer

A diferença essencial: Funil A tem 1 venda final; Funil B tem 2 vendas (workshop low ticket como qualificador + main offer high ticket no fim). O sistema precisa distinguir Purchase de produtos diferentes mesmo vindo do mesmo Guru.

Esta entrega cobre 3 fases que, juntas, transformam GlobalTracker em uma ferramenta onde você (1) escolhe um template de funil ao criar lançamento, (2) tem pages + audiences scaffoldadas automaticamente, (3) edita estágios/eventos pela UI sem mexer em código, (4) recebe webhooks do Guru já contextualizados ao launch correto **e ao papel do produto no funil**.

Decisões já travadas com você:
- Escopo: Fases 1 + 2 + 3 (entregar tudo)
- Stages: customizáveis por launch (template = ponto de partida, edições ficam no launch sem afetar template)
- Guru: mapeamento explícito product_id↔launch + funnel_role do produto + fallback heurístico last_attribution
- Funil B: suportar 3 variantes de checkout (direto Guru, checkout próprio com script, popup intermediário) E 2 variantes de funil (apenas workshop / workshop + main offer)
- Nomenclatura: campo `type` (não `kind`)

---

## Fase 1 — UX Hardening (sem schema novo)

### O que entrega

Você consegue construir Funil A e Funil B manualmente, com a UI expondo todo o domínio existente (page.role, event_config, launch.config.type). Tabs no detail do launch (Pages, Eventos, Audiences, Performance) conforme prometido em `docs/70-ux/02-information-architecture.md`.

### Arquivos modificados

- [apps/control-plane/src/app/(app)/launches/page.tsx](apps/control-plane/src/app/(app)/launches/page.tsx) — adicionar campo `type` ao form (radio: `lancamento_gratuito` / `lancamento_pago` / `evergreen` / `outro`). Persistir em `launches.config.type` (jsonb, sem migration). Adicionar `objective` (texto livre) e `start_date` / `end_date` em `config.timeline`.
- [apps/control-plane/src/app/(app)/launches/[launch_public_id]/pages/new/page.tsx](apps/control-plane/src/app/(app)/launches/%5Blaunch_public_id%5D/pages/new/page.tsx) — expor seletor de `role` (capture/sales/thankyou/webinar/checkout/survey, já é coluna). Pré-popular `event_config` com defaults baseados no role escolhido (ex: capture → PageView+Lead; sales → PageView+ViewContent+InitiateCheckout; checkout → PageView+InitiateCheckout; thankyou → PageView+Purchase).
- [apps/control-plane/src/app/(app)/launches/[launch_public_id]/page.tsx](apps/control-plane/src/app/(app)/launches/%5Blaunch_public_id%5D/page.tsx) — refatorar para shell com tabs. Mover conteúdo atual para tab "Overview". Adicionar tabs: Pages (lista atual + chip de role visível), Eventos (timeline filtrada por launch_id), Audiences (lista filtrada), Performance (métricas básicas).
- [apps/control-plane/src/app/(app)/launches/[launch_public_id]/pages/[page_public_id]/page-detail-client.tsx](apps/control-plane/src/app/(app)/launches/%5Blaunch_public_id%5D/pages/%5Bpage_public_id%5D/page-detail-client.tsx) — adicionar painel "Configuração de eventos" para editar `event_config` (lista checkbox dos eventos canônicos + textarea para custom events).

### Arquivos novos

- [apps/control-plane/src/lib/page-role-defaults.ts](apps/control-plane/src/lib/page-role-defaults.ts) — mapa `role → defaultEventConfig` reutilizável entre form de criação e tela de detalhe.

### Reuso

- Validação Zod do `event_config` já existe na Edge — espelhar em `packages/shared/` (verificar se pacote existe; se não, criar).
- Componentes de Tabs em `apps/control-plane/src/components/ui/` (shadcn).
- Endpoint `GET /v1/events?launch_id=` — verificar se existe; se não, criar como parte desta fase.

### Verificação E2E

1. Criar launch "Funil A Maio 2026" com type=lancamento_gratuito; confirmar que `launches.config.type` persistiu.
2. Criar 4 pages com roles distintos (capture, sales, thankyou, webinar). UI mostra chip de role na lista.
3. Tab "Eventos" do launch detail mostra eventos chegando agrupados por canônico.
4. Editar `event_config` da page sales removendo InitiateCheckout, salvar, confirmar que tracker ignora esse evento na próxima visita.

---

## Fase 2 — Funnel Templates + Scaffolding

### O que entrega

Ao criar launch, escolhe um de 4 presets (Lançamento Gratuito 3 Aulas, Lançamento Pago Workshop + Main Offer, Lançamento Pago Apenas Workshop, Evergreen). Sistema scaffolda pages + audiences + mapeamento event→stage automaticamente. Stages são editáveis por launch (cópia do template, não mutação).

### Schema (migration nova)

[supabase/migrations/20260503000028_funnel_templates.sql](supabase/migrations/20260503000028_funnel_templates.sql) e [packages/db/migrations/0029_funnel_templates.sql](packages/db/migrations/0029_funnel_templates.sql) (espelhar — convenção do projeto):

```sql
CREATE TABLE funnel_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NULL REFERENCES workspaces(id),  -- NULL = preset global
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  blueprint jsonb NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_funnel_templates_slug
  ON funnel_templates(coalesce(workspace_id::text,'_global'), slug);

ALTER TABLE launches
  ADD COLUMN funnel_template_id uuid NULL REFERENCES funnel_templates(id),
  ADD COLUMN funnel_blueprint jsonb NULL;  -- cópia editável do blueprint
```

RLS: pattern dual-mode da migration `0028` (GUC OR `auth_workspace_id()`); presets globais (workspace_id NULL) leitura pública para `authenticated`.

### Forma do blueprint

```ts
{
  type: 'lancamento_gratuito' | 'lancamento_pago' | 'evergreen',
  has_main_offer: boolean,           // Funil B: true = workshop + main offer; false = apenas workshop
  has_workshop: boolean,             // true para Funil B; false para A e evergreen
  checkout_variant?: 'direto_guru' | 'checkout_proprio' | 'com_popup',  // configurável por page tipo checkout
  stages: [
    { slug, label, is_recurring, source_events, source_event_filters? }
  ],
  pages: [
    { role, suggested_public_id, event_config, suggested_funnel_role? }
  ],
  audiences: [
    { slug, name, platform, query_template }
  ]
}
```

`source_event_filters` permite distinguir Purchase do workshop vs Purchase do main offer:
```ts
{
  slug: 'purchased_workshop',
  source_events: ['Purchase'],
  source_event_filters: { funnel_role: 'workshop' }
},
{
  slug: 'purchased_main_offer',
  source_events: ['Purchase'],
  source_event_filters: { funnel_role: 'main_offer' }
}
```

O `funnel_role` é injetado pelo mapping Guru (Fase 3) no payload do raw_event antes de ser enfileirado. O processor lê o filter e seleciona o stage correto.

### 4 Presets (seed na migration)

**1. `lancamento_gratuito_3_aulas`** (Funil A)
- `has_workshop: false`, `has_main_offer: true` (a main_offer é o produto principal vendido no fim)
- Stages: `lead_identified`, `wpp_joined`, `watched_class_1`, `watched_class_2`, `watched_class_3`, `clicked_buy_main`, `purchased_main`
- Pages: capture + sales + thankyou_main
- Audiences:
  - `aquecimento_cadastrados_sem_compra` (stage=lead_identified AND NOT stage=purchased_main)
  - `engajados_aula_2` (stage=watched_class_2)
  - `abandono_checkout_main` (stage=clicked_buy_main AND NOT stage=purchased_main)
  - `compradores_main` (stage=purchased_main)

**2. `lancamento_pago_workshop_com_main_offer`** (Funil B completo) — **v2 (Sprint 12)**
- `has_workshop: true`, `has_main_offer: true`
- Stages (8, em ordem cronológica): `clicked_buy_workshop`, `lead_workshop`, `purchased_workshop`, `survey_responded`, `wpp_joined`, `watched_workshop`, `clicked_buy_main`, `purchased_main`
  - `clicked_buy_workshop` (recorrente): `source_events: ['custom:click_buy_workshop']` — clique no botão "Quero Comprar" antes do form de captura (entrada do funil); via custom event client-side (D5 da ADR-026).
  - `lead_workshop`: `source_events: ['Lead']` — após preenchimento do form de captura, lead identificado.
  - `purchased_workshop`: `source_events: ['Purchase']`, `source_event_filters: { funnel_role: 'workshop' }`
  - `survey_responded`: `source_events: ['custom:survey_responded']` — pesquisa na page `obrigado-workshop` (D2).
  - `wpp_joined`: `source_events: ['Contact']` — botão WhatsApp ao final da pesquisa.
  - `watched_workshop`: `source_events: ['custom:watched_workshop']` — MVP binário via botão "Já assisti" na page `aula-workshop` (D3/D4).
  - `clicked_buy_main` (recorrente): `source_events: ['custom:click_buy_main']` — `oferta-principal` sem popup (D6).
  - `purchased_main`: `source_events: ['Purchase']`, `source_event_filters: { funnel_role: 'main_offer' }`
- Pages (5): `workshop` (sales) + `obrigado-workshop` (thankyou — pesquisa+wpp) + `aula-workshop` (webinar — page nova) + `oferta-principal` (sales — sem popup) + `obrigado-principal` (thankyou)
- Audiences (6):
  - `compradores_workshop_aquecimento` (stage_eq=purchased_workshop AND stage_not=purchased_main)
  - `respondeu_pesquisa_sem_comprar_main` (stage_eq=survey_responded AND stage_not=purchased_main)
  - `engajados_workshop` (stage_gte=watched_workshop)
  - `abandono_main_offer` (stage_eq=clicked_buy_main AND stage_not=purchased_main)
  - `compradores_main` (stage_eq=purchased_main)
  - `nao_compradores_workshop_engajados` (stage_gte=watched_workshop AND stage_not=purchased_main)

> **Diferenças vs v1 (seed original 0029):** removidos `watched_class_1/2/3` (substituídos por `watched_workshop` único — D4); IC removido como stage (D1 — virá do Guru no futuro); adicionado `survey_responded` (D2); page nova `aula-workshop` (role=`webinar`); `oferta-principal` sem popup (D6); audience `compradores_apenas_workshop` arquivada (duplicata).

> **Refinamento cronológico (2026-05-04, migration 0032).** Ordem dos stages 1 e 2 trocada: `clicked_buy_workshop` antes de `lead_workshop`. Cronologicamente o lead clica "Quero Comprar" antes de preencher o form de captura — `clicked_buy_workshop` é entrada de funil; `lead_workshop` segue após o form. Aplicado via `0032_reorder_stages_paid_workshop_v2.sql` (idempotente, espelhado em `supabase/migrations/`). Sem regressão: nenhuma das 6 audiences usa `stage_gte` com `lead_workshop`/`clicked_buy_workshop`. Detalhe em ADR-026 §Refinamento pós-implementação.

> **Evolução pós-Sprint 12** (não escopo deste sprint, mas mapeado):
> - **InitiateCheckout via Guru** (D1): investigar webhook `CHECKOUT_INITIATED` ou pixel/proxy no checkout Guru. Hoje IC fica fora dos stages do funil; entrará como input futuro do dispatcher Meta CAPI. Decisão definitiva via ADR separado (ADR-027+) e potencial Sprint 14.
> - **Zoom Webinar/Meeting webhook** (D3): `webinar.participant_joined`/`participant_left` com duração por participante. Match por email do lead. Substitui MVP binário por stages granulares (`attended_workshop_5min`, `attended_workshop_30min`, etc.).
> - **Vimeo Live + heartbeat** (D3 alternativa): player embedded enviando heartbeat a cada 30s via `Funil.track('custom:watched_heartbeat', { sec: N })`. Stages calculados pelo processor (ou job batch) somando heartbeats. Mais complexo, mas independe de plataforma de webinar.
> - Detalhe completo: `docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md` §Notas técnicas.

**3. `lancamento_pago_workshop_apenas`** (Funil B simplificado)
- `has_workshop: true`, `has_main_offer: false`
- Stages até `purchased_workshop` apenas
- Pages: capture (paga, role=sales) + thankyou_workshop
- Audiences: `visitantes_sem_compra_workshop`, `compradores_workshop`

**4. `evergreen_direct_sale`**
- `has_workshop: false`, `has_main_offer: true`
- Stages: `clicked_buy_main`, `purchased_main`
- Pages: sales + checkout + thankyou_main
- Audiences: `visitantes_sem_compra`, `compradores`

### Arquivos novos

- [packages/db/src/schema/funnel_template.ts](packages/db/src/schema/funnel_template.ts) — Drizzle schema; atualizar barrel `packages/db/src/schema/index.ts`.
- [packages/shared/src/schemas/funnel-blueprint.ts](packages/shared/src/schemas/funnel-blueprint.ts) — Zod schema do blueprint, compartilhado entre Edge e control-plane.
- [apps/edge/src/routes/funnel-templates.ts](apps/edge/src/routes/funnel-templates.ts) — `GET /v1/funnel-templates` (lista presets globais + workspace), `GET /v1/funnel-templates/:slug` (detalhe).
- [apps/edge/src/lib/funnel-scaffolder.ts](apps/edge/src/lib/funnel-scaffolder.ts) — `scaffoldLaunch({ template, launchId, workspaceId, db })` que cria pages + audiences + popula `launches.funnel_blueprint` em transação. Idempotente (se page com `public_id` já existe, skip).
- [apps/control-plane/src/app/(app)/launches/[launch_public_id]/funnel/page.tsx](apps/control-plane/src/app/(app)/launches/%5Blaunch_public_id%5D/funnel/page.tsx) — UI de edição de stages do launch (CRUD em `launches.funnel_blueprint.stages`).

### Arquivos modificados (críticos)

- [apps/edge/src/routes/launches.ts](apps/edge/src/routes/launches.ts) POST handler — aceitar `funnel_template_slug` opcional; quando presente, chamar `scaffoldLaunch` após criar launch.
- [apps/edge/src/lib/raw-events-processor.ts](apps/edge/src/lib/raw-events-processor.ts) linhas 165-168 e 481-506 — substituir `LEAD_STAGE_IDENTIFY_EVENT_NAMES` hardcoded por lookup `launches.funnel_blueprint.stages[*].source_events` + `source_event_filters`. Cache em memória por `launch_id` com TTL 60s. Fallback: comportamento atual se launch sem blueprint.
- [apps/control-plane/src/app/(app)/launches/page.tsx](apps/control-plane/src/app/(app)/launches/page.tsx) — passo extra "Escolha um template" antes do form de criação. Default "Em branco" preserva fluxo da Fase 1.

### Reuso

- Audience query DSL e validador Zod já existentes.
- `insertLeadStageIgnoreDuplicate` em `apps/edge/src/lib/lead-stage-resolver.ts`.
- Lifecycle promotion (draft→configuring→live) já tratado na sessão anterior.

### Trade-offs

- **Stages customizáveis por launch** = blueprint copiado para `launches.funnel_blueprint`. Edição não afeta template. Sem perda de performance (lookup já é via `launches`).
- **Hot path do processor**: lookup por launch a cada raw_event. Mitigação: cache 60s.
- **Mudar template depois de criar launch**: NÃO suportar v1. Apenas duplicar launch.
- **Distinção Purchase workshop vs main offer**: depende do mapping Guru (Fase 3) injetar `funnel_role` no payload. Sem Fase 3, ambos viram o mesmo stage genérico `purchased`. Por isso Fase 3 é obrigatória para Funil B funcionar corretamente.

### Verificação E2E

1. Migration aplica; `GET /v1/funnel-templates` retorna 4 presets.
2. `POST /v1/launches` com `funnel_template_slug=lancamento_pago_workshop_com_main_offer` cria launch + 4 pages + 5 audiences. `launches.funnel_blueprint` populado.
3. Disparar evento `custom:watched_class_2` → `lead_stages` row criada com stage=`watched_class_2`.
4. Editar stage `watched_class_1` na UI de funil (renomear), salvar, disparar evento mapeado, confirmar que stage usado é o renomeado.

---

## Fase 3 — Webhook Guru contextualizado por launch + funnel_role

### O que entrega

Webhook do Guru chega já sabendo a qual launch pertence E qual papel desempenha no funil (workshop / main_offer / outro). Resolve o gap de carrinho-abandonado e Purchase associarem ao funil correto e ao stage correto.

### Estratégia

- **Mapeamento explícito (primário)**: `workspace.config.integrations.guru.product_launch_map`:
  ```json
  {
    "prod_workshop_xyz": { "launch_public_id": "lcm-maio-2026", "funnel_role": "workshop" },
    "prod_main_xyz": { "launch_public_id": "lcm-maio-2026", "funnel_role": "main_offer" },
    "prod_evergreen_abc": { "launch_public_id": "evergreen-cs", "funnel_role": "main_offer" }
  }
  ```
- **Heurística (fallback)**: se `product.id` não está no map, consultar `lead_attribution` mais recente do lead e copiar `launch_id`. `funnel_role` fica null nesse caso (stage cai no genérico).
- **Audit trail**: `audit_log` registra qual estratégia resolveu cada webhook (`mapping` / `last_attribution` / `none`).

### Arquivos modificados

- [apps/edge/src/routes/webhooks/guru.ts](apps/edge/src/routes/webhooks/guru.ts) — após resolver workspace e antes de inserir raw_event, chamar `resolveLaunchForGuruEvent({ workspaceId, productId, leadHints, db })`. Injetar `launch_id` E `funnel_role` no payload.
- [apps/control-plane/src/app/(app)/launches/[launch_public_id]/page.tsx](apps/control-plane/src/app/(app)/launches/%5Blaunch_public_id%5D/page.tsx) — adicionar painel "Mapeamento Guru" na tab Overview. Lista produtos cadastrados (linhas: product_id, funnel_role, launch); botão "Adicionar produto" abre modal com selects.
- [apps/edge/src/routes/workspace-config.ts](apps/edge/src/routes/workspace-config.ts) (verificar se existe; criar se não) — endpoint para PATCH parcial de `workspace.config`.

### Arquivos novos

- [apps/edge/src/lib/guru-launch-resolver.ts](apps/edge/src/lib/guru-launch-resolver.ts) — implementa estratégia primária + fallback + audit_log entry. Retorna `{ launch_id, funnel_role, strategy }`.

### Reuso

- `audit_log` table e `safeLog` middleware.
- JSONB merge pattern (SELECT → merge JS → UPDATE com objeto plano) por causa do bug de encoding em CF Workers local — registrado em MEMORY.md §5.

### Verificação E2E

1. Configurar mapping na UI:
   - `prod_workshop_xyz → { launch: lcm-maio-2026, funnel_role: workshop }`
   - `prod_main_xyz → { launch: lcm-maio-2026, funnel_role: main_offer }`
2. Disparar webhook Guru Purchase com `product.id=prod_workshop_xyz` → raw_event tem `launch_id` e `funnel_role: workshop` → processor lê blueprint do launch, encontra stage com `source_event_filters: { funnel_role: 'workshop' }` → cria `lead_stages` com stage=`purchased_workshop`.
3. Disparar webhook Guru Purchase com `product.id=prod_main_xyz` → `lead_stages` com stage=`purchased_main`.
4. Audience "compradores_workshop_aquecimento" inclui o lead; "compradores_main" não inclui (porque ainda não comprou main).
5. Disparar segundo Purchase (main offer) → audience "compradores_workshop_aquecimento" remove o lead no próximo sync (porque agora tem stage=purchased_main); "compradores_main" inclui.
6. Webhook sem product mapeado → fallback last_attribution → audit_log mostra `strategy=last_attribution`, funnel_role=null.

---

## Decomposição em ondas (paralelização)

**Onda 1 (Fase 1, paralela):**
- T-FUNIL-001 (control-plane): expor type/objective/timeline no form de launch
- T-FUNIL-002 (control-plane): expor role + event_config defaults no form de page
- T-FUNIL-003 (control-plane): refatorar launch detail com tabs
- T-FUNIL-004 (edge): garantir endpoint `GET /v1/events?launch_id=` se faltante

**Onda 2 (Fase 2, parcialmente paralela):**
- T-FUNIL-010 (schema, serial): migration `0029_funnel_templates.sql` + Drizzle schema + barrel + Zod blueprint
- T-FUNIL-011 (edge, depende de 010): rota `funnel-templates.ts` + `funnel-scaffolder.ts`
- T-FUNIL-012 (edge, depende de 010): mexer em `raw-events-processor.ts` para usar blueprint do launch (incluindo `source_event_filters`)
- T-FUNIL-013 (control-plane, depende de 011): seletor de template no form de launch + UI de edição de stages
- T-FUNIL-014 (db, paralelo a 011-013): seed dos 4 presets

**Onda 3 (Fase 3, paralela com fim de Fase 2):**
- T-FUNIL-020 (edge): `guru-launch-resolver.ts` + integração no webhook
- T-FUNIL-021 (edge): endpoint `PATCH /v1/workspace/config` se faltante
- T-FUNIL-022 (control-plane, depende de 020+021): UI de cadastro de mapping product↔launch+funnel_role

### Armadilhas de paralelismo

- [apps/edge/src/lib/raw-events-processor.ts](apps/edge/src/lib/raw-events-processor.ts) é hot path. Apenas T-FUNIL-012 toca; nenhuma outra T-ID na mesma onda.
- `packages/db/src/schema/index.ts` (barrel) editado por T-FUNIL-010. Coordenar via mesmo commit.
- Migrations sequenciais: T-FUNIL-010 cria a única nova migration; sem conflito de prefixo.
- [apps/control-plane/src/app/(app)/launches/page.tsx](apps/control-plane/src/app/(app)/launches/page.tsx) tocado por Fase 1 (T-FUNIL-001) e Fase 2 (T-FUNIL-013). Sequenciar.
- [apps/control-plane/src/app/(app)/launches/[launch_public_id]/page.tsx](apps/control-plane/src/app/(app)/launches/%5Blaunch_public_id%5D/page.tsx) tocado por T-FUNIL-003 (Fase 1) e T-FUNIL-022 (Fase 3). Sequenciar.

---

## Documentação a atualizar (no fim de cada fase)

- [docs/20-domain/02-mod-launch.md](docs/20-domain/02-mod-launch.md) — type, funnel_template_id, funnel_blueprint
- [docs/20-domain/03-mod-page.md](docs/20-domain/03-mod-page.md) — defaults de event_config por role
- [docs/20-domain/06-mod-funnel.md](docs/20-domain/06-mod-funnel.md) — funnel_templates, blueprint shape, source_event_filters, mapeamento configurável event→stage
- [docs/20-domain/09-mod-audience.md](docs/20-domain/09-mod-audience.md) — audiences scaffoldadas por template
- [docs/30-contracts/05-api-server-actions.md](docs/30-contracts/05-api-server-actions.md) — endpoints novos `/v1/funnel-templates`, `/v1/workspace/config`
- [docs/40-integrations/13-digitalmanager-guru-webhook.md](docs/40-integrations/13-digitalmanager-guru-webhook.md) — resolução de launch + funnel_role via mapping/fallback
- [docs/70-ux/02-information-architecture.md](docs/70-ux/02-information-architecture.md) — rotas novas (tabs do launch, /funnel)
- [docs/70-ux/04-screen-page-registration.md](docs/70-ux/04-screen-page-registration.md) — seletor de role e event_config defaults

Despachar `globaltracker-docs-sync` ao final de cada fase.

---

## Verificação final E2E (toda a entrega)

Cenário do Funil B completo (mais complexo):

1. Criar workspace de teste em ambiente local (Supabase já configurado).
2. Onboarding até Step 5 normalmente.
3. `POST /v1/launches` (via UI) com template `lancamento_pago_workshop_com_main_offer` → confirmar 4 pages + 5 audiences criadas.
4. Configurar 2 mappings Guru na tab Overview:
   - `prod_workshop_xyz → { lcm-maio-2026, workshop }`
   - `prod_main_xyz → { lcm-maio-2026, main_offer }`
5. Editar stage `watched_class_2` na UI de funil — renomear label para "Assistiu Aula 2 (peak interest)".
6. Disparar via curl/playwright a sequência:
   - PageView na page de captura paga
   - InitiateCheckout (clicou comprar workshop)
   - Webhook Guru Purchase com product=prod_workshop_xyz → stage=`purchased_workshop`
   - Contact (entrou wpp)
   - custom:watched_class_1, custom:watched_class_2 → stages registrados
   - PageView na page de vendas main offer
   - InitiateCheckout (clicou comprar main offer)
   - Webhook Guru Purchase com product=prod_main_xyz → stage=`purchased_main`
7. Verificar `lead_stages` populada com TODOS os stages corretos.
8. Verificar `dispatch_jobs` para Meta CAPI criados para todos os eventos elegíveis.
9. Forçar audience sync, verificar:
   - `compradores_workshop_aquecimento` NÃO inclui o lead (porque agora tem purchased_main)
   - `compradores_main` inclui o lead
   - `engajados_workshop` inclui (assistiu aula 2)
10. Repetir o fluxo criando outro launch com `lancamento_gratuito_3_aulas` para validar Funil A em paralelo.
