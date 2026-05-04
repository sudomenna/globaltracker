# Sprint 10 — Funil Configurável: Templates + Scaffolding (Fase 2)

## Duração estimada
2–3 semanas.

## Objetivo
Introduzir o conceito de **funnel template** como blueprint reutilizável. Ao criar um launch, operador escolhe um dos 4 presets (Lançamento Gratuito 3 Aulas, Lançamento Pago Workshop + Main Offer, Lançamento Pago Apenas Workshop, Evergreen) e o sistema scaffolda automaticamente pages + audiences + mapeamento event→stage. Stages ficam como cópia editável no launch sem afetar o template. O `raw-events-processor` passa a usar o blueprint do launch para determinar stages, incluindo `source_event_filters` para distinguir Purchase do workshop vs main offer.

## Pré-requisitos
- Sprint 9 completo (UX Hardening — form de launch e page já expõem os campos necessários).
- Migrations 0000–0028 aplicadas.

## Critério de aceite global

- [ ] Migration `0029_funnel_templates` aplicada; tabela `funnel_templates` criada; `launches` tem colunas `funnel_template_id` e `funnel_blueprint`.
- [ ] `GET /v1/funnel-templates` retorna 4 presets globais.
- [ ] `POST /v1/launches` com `funnel_template_slug=lancamento_pago_workshop_com_main_offer` cria launch + 4 pages + 5 audiences; `launches.funnel_blueprint` populado.
- [ ] Evento `custom:watched_class_2` disparado cria `lead_stages` row com stage `watched_class_2` (usando blueprint do launch, não hardcode).
- [ ] UI de edição de stages no launch permite renomear label; stage renomeado é usado pelo processor.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` verdes ao fim de cada onda.

---

## T-IDs — decomposição completa

> `parallel-safe=yes` = pode rodar em paralelo com outras T-IDs da mesma onda (ownership disjunto).

### Tabela mestre

| T-ID | Tipo | Título curto | Onda | parallel-safe | Deps | Agente |
|---|---|---|---|---|---|---|
| T-FUNIL-010 | schema | Migration 0029 + Drizzle schema + Zod blueprint | 0 | **no** | Sprint 9 | schema-author |
| T-FUNIL-011 | edge | `GET /v1/funnel-templates` + `funnel-scaffolder` + `launches.ts` POST | 1 | yes | T-FUNIL-010 | edge-author |
| T-FUNIL-012 | domain | `raw-events-processor` usa blueprint do launch | 1 | yes | T-FUNIL-010 | domain-author |
| T-FUNIL-014 | schema | Seed dos 4 presets globais | 1 | yes | T-FUNIL-010 | schema-author |
| T-FUNIL-013 | cp | Seletor de template no form de launch + UI de edição de stages | 2 | yes | T-FUNIL-011 | general-purpose |
| T-FUNIL-015 | test | Testes unit + integration Fase 2 | 3 | yes | T-FUNIL-010..014 | test-author |
| T-FUNIL-016 | docs-sync | Doc sync Fase 2 | 3 | yes | T-FUNIL-010..014 | docs-sync |
| T-FUNIL-017 | br-auditor | Auditoria BR pré-merge | 4 | **no** | T-FUNIL-010..016 | br-auditor |

---

## Plano de ondas

> Máximo de 5 T-IDs por onda. Verificação `pnpm typecheck && pnpm lint && pnpm test` entre cada onda.

---

### Onda 0 — Schema (serial, sozinha)

> Mudança de schema é sempre serial. Bloqueia onda 1.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-010** | `packages/db/src/schema/funnel_template.ts` (novo), `packages/db/src/schema/launch.ts` (extensão), `packages/db/src/schema/index.ts` (barrel), `packages/db/migrations/0029_funnel_templates.sql`, `supabase/migrations/20260503000029_funnel_templates.sql`, `packages/shared/src/schemas/funnel-blueprint.ts` (novo) | **Migration SQL** — duas instruções: `CREATE TABLE funnel_templates` (campos: `id uuid pk`, `workspace_id uuid NULL REFERENCES workspaces(id)`, `slug text NOT NULL`, `name text NOT NULL`, `description text`, `blueprint jsonb NOT NULL`, `is_system boolean NOT NULL DEFAULT false`, `status text NOT NULL DEFAULT 'active'`, `created_at`, `updated_at`) + índice `UNIQUE ON (coalesce(workspace_id::text,'_global'), slug)` + `ALTER TABLE launches ADD COLUMN funnel_template_id uuid NULL REFERENCES funnel_templates(id), ADD COLUMN funnel_blueprint jsonb NULL`. **RLS** — presets globais (`workspace_id IS NULL`): `SELECT` para `authenticated` sem restrição de workspace. Presets customizados (`workspace_id IS NOT NULL`): dual-mode pattern da migration 0028 (GUC `app.current_workspace_id` OR `auth_workspace_id()`). **Drizzle schema** — `packages/db/src/schema/funnel_template.ts` com tabela e Zod infer. Atualizar barrel `packages/db/src/schema/index.ts`. **Zod blueprint** — `packages/shared/src/schemas/funnel-blueprint.ts` exportando `FunnelBlueprintSchema` com shape: `{ type, has_main_offer, has_workshop, checkout_variant?, stages: [{ slug, label, is_recurring, source_events, source_event_filters? }], pages: [{ role, suggested_public_id, event_config, suggested_funnel_role? }], audiences: [{ slug, name, platform, query_template }] }`. Copiar migration para ambos diretórios conforme convenção (MEMORY.md §5). `pnpm db:generate` verde. |

**Verificação após onda 0:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 1 — Implementação paralela (3 em paralelo)

> Deps: todos dependem de T-FUNIL-010. Entre si: ownership disjunto (edge routes vs domain lib vs seed SQL).

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-011** | `apps/edge/src/routes/funnel-templates.ts` (novo), `apps/edge/src/lib/funnel-scaffolder.ts` (novo), `apps/edge/src/routes/launches.ts` (extensão) | **(A) Rota `funnel-templates.ts`:** `GET /v1/funnel-templates` — lista todos os templates do workspace + globais (`workspace_id IS NULL OR workspace_id = current_workspace`), resposta `{ templates: [{ id, slug, name, description, blueprint, is_system }] }`. `GET /v1/funnel-templates/:slug` — detalhe, incluindo blueprint completo. Auth: `auth-cp` middleware. **(B) `funnel-scaffolder.ts`:** exporta `scaffoldLaunch({ templateSlug, launchId, workspaceId, db })`. Dentro de uma transação: (1) busca template por slug; (2) cria pages declaradas no blueprint (skip se `public_id` já existe — idempotente); (3) cria audiences declaradas no blueprint (skip se `slug+launch_id` já existe — idempotente); (4) copia `blueprint` para `launches.funnel_blueprint` (substitui stages por cópia editável); (5) seta `launches.funnel_template_id`. Usa `DATABASE_URL ?? HYPERDRIVE.connectionString` (MEMORY.md §5). **(C) `launches.ts` POST handler:** aceitar campo opcional `funnel_template_slug: string`. Quando presente, após inserir launch, chamar `scaffoldLaunch(...)` via `c.executionCtx.waitUntil` (não bloqueia resposta). Retornar `{ launch, scaffolded: true }` se template foi aplicado. |
| **T-FUNIL-012** | `apps/edge/src/lib/raw-events-processor.ts` | Substituir `LEAD_STAGE_IDENTIFY_EVENT_NAMES` hardcoded por lookup dinâmico em `launches.funnel_blueprint.stages`. Lógica: ao processar raw_event com `launch_id`, carregar `launches.funnel_blueprint` (cache em memória por `launch_id` com TTL 60s usando `Map` + timestamp). Para cada stage do blueprint, verificar se `raw_event.event_name` está em `stage.source_events`. Se `stage.source_event_filters` existe, verificar também se `raw_event.payload.funnel_role === stage.source_event_filters.funnel_role` (e outros filtros presentes). Se match: chamar `insertLeadStageIgnoreDuplicate`. **Fallback**: se launch não tem `funnel_blueprint` (IS NULL), continuar com comportamento atual (array hardcoded) — backward compatible. Cache invalidado quando `launches.funnel_blueprint` é atualizado (a partir da requisição PATCH do CP). Não tocar em nenhum outro arquivo fora de `raw-events-processor.ts`. |
| **T-FUNIL-014** | `packages/db/migrations/0029_funnel_templates.sql` (extensão — bloco INSERT ao final), `supabase/migrations/20260503000029_funnel_templates.sql` (idem) | Seed dos 4 presets globais (INSERT INTO funnel_templates com `workspace_id = NULL`, `is_system = true`). **Preset 1 — `lancamento_gratuito_3_aulas`**: `has_workshop: false`, `has_main_offer: true`. Stages: `lead_identified` (source_events: ['Lead']), `wpp_joined` (source_events: ['Contact']), `watched_class_1` (source_events: ['custom:watched_class_1']), `watched_class_2` (source_events: ['custom:watched_class_2']), `watched_class_3` (source_events: ['custom:watched_class_3']), `clicked_buy_main` (source_events: ['InitiateCheckout']), `purchased_main` (source_events: ['Purchase']). Pages: capture, sales, thankyou_main. Audiences: `aquecimento_cadastrados_sem_compra`, `engajados_aula_2`, `abandono_checkout_main`, `compradores_main`. **Preset 2 — `lancamento_pago_workshop_com_main_offer`**: `has_workshop: true`, `has_main_offer: true`. Stages: `lead_workshop` (source_events: ['Lead'], is_recurring: false), `clicked_buy_workshop` (source_events: ['InitiateCheckout'], source_event_filters: {funnel_role: 'workshop'}), `purchased_workshop` (source_events: ['Purchase'], source_event_filters: {funnel_role: 'workshop'}), `wpp_joined` (source_events: ['Contact']), `watched_class_1/2/3`, `clicked_buy_main` (source_events: ['InitiateCheckout'], source_event_filters: {funnel_role: 'main_offer'}), `purchased_main` (source_events: ['Purchase'], source_event_filters: {funnel_role: 'main_offer'}). Pages: capture (role=sales), thankyou_workshop, sales (main offer), thankyou_main. Audiences: `compradores_workshop_aquecimento`, `engajados_workshop`, `abandono_main_offer`, `compradores_main`, `compradores_apenas_workshop`. **Preset 3 — `lancamento_pago_workshop_apenas`**: stages até `purchased_workshop`. **Preset 4 — `evergreen_direct_sale`**: stages `clicked_buy_main`, `purchased_main`. Pages: sales, checkout, thankyou_main. |

**Verificação após onda 1:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 2 — CP: seletor + UI stages (1 T-ID)

> Dep: T-FUNIL-011 (rota funnel-templates deve existir para o CP consumir).

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-013** | `apps/control-plane/src/app/(app)/launches/page.tsx` (extensão de T-FUNIL-001), `apps/control-plane/src/app/(app)/launches/[launch_public_id]/funnel/page.tsx` (novo) | **(A) Seletor de template no form de criação:** antes do form atual, adicionar passo "Escolha um template" com 4 cards (um por preset) + opção "Em branco". Cards mostram nome, descrição resumida, número de stages/pages/audiences do blueprint. Default = "Em branco" (preserva fluxo atual). Ao selecionar preset, passar `funnel_template_slug` no POST de criação. **(B) UI de edição de stages** em `/launches/[launch_public_id]/funnel`: lista os stages de `launches.funnel_blueprint.stages` em ordem. Cada stage: (a) campo `label` editável inline; (b) chips de `source_events`; (c) badge se `source_event_filters` presente; (d) toggle `is_recurring`. Botão "Salvar alterações" chama `PATCH /v1/launches/:id` atualizando `funnel_blueprint.stages`. Link para `/funnel` adicionado na tab "Funil" do launch detail (tab nova no shell refatorado em T-FUNIL-003). Nota: apenas edição de label e is_recurring na v1; adicionar/remover stages fica fora de escopo. |

**Verificação após onda 2:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 3 — Testes + doc sync (2 em paralelo)

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-015** | `tests/unit/funil/fase-2/`, `tests/integration/funil/fase-2/` | Unit: `funnel-blueprint-schema.test.ts` — Zod aceita blueprint válido com `source_event_filters`; rejeita stages sem `source_events`. `funnel-scaffolder.test.ts` — scaffold idempotente (segunda chamada com mesmo launchId não duplica pages/audiences). `raw-events-processor-blueprint.test.ts` — processor usa stages do blueprint; `source_event_filters.funnel_role` distingue Purchase workshop vs main offer; fallback hardcoded funciona quando blueprint = NULL. Integration: `funnel-templates-route.test.ts` — `GET /v1/funnel-templates` retorna 4 presets; workspace isolation (preset customizado de outro workspace não aparece). `launch-scaffolding.test.ts` — `POST /v1/launches` com `funnel_template_slug` cria launch + pages + audiences + popula `funnel_blueprint`. `stage-edit-ui.test.tsx` — edição de label persiste em `funnel_blueprint.stages`. Mínimo 25 novos testes verdes. |
| **T-FUNIL-016** | `docs/20-domain/06-mod-funnel.md`, `docs/20-domain/09-mod-audience.md`, `docs/30-contracts/05-api-server-actions.md`, `docs/70-ux/02-information-architecture.md` | Atualizar: (1) `06-mod-funnel.md` — documentar `funnel_templates` (campos, RLS, blueprint shape, `source_event_filters`), `launches.funnel_blueprint` (cópia editável), lógica de match no processor (cache 60s, fallback). (2) `09-mod-audience.md` — audiences scaffoldadas por template; query_template dinâmico por stage slug. (3) `05-api-server-actions.md` — adicionar `GET /v1/funnel-templates`, `GET /v1/funnel-templates/:slug` e documentar campo `funnel_template_slug` no `POST /v1/launches`. (4) `02-information-architecture.md` — adicionar rota `/launches/[id]/funnel` ao mapa. |

**Verificação após onda 3:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 4 — Auditoria pré-merge (serial)

| T-ID | Critério de aceite |
|---|---|
| **T-FUNIL-017** | Auditor verifica: (1) `funnel_templates` RLS: presets globais (`workspace_id IS NULL`) legíveis por qualquer authenticated; presets customizados isolados por workspace. (2) `raw-events-processor` — cache de blueprint não vaza dados entre workspaces (cache key inclui `launch_id` que é UUID único). (3) `funnel-scaffolder` é idempotente: INSERT de page/audience usa ON CONFLICT DO NOTHING ou skip explícito. (4) `source_event_filters` com `funnel_role` não causa crash quando campo ausente no payload (null-safe). (5) INV-FUNNEL-001..004 citados no código onde relevante. Relatório com BRs OK / missing. |

---

## Grafo de dependências (resumo visual)

```
Onda 0 (serial — schema):
  T-FUNIL-010 (schema + migration + Zod blueprint)

Onda 1 (paralela — 3 T-IDs):
  T-FUNIL-011 (edge: rotas + scaffolder + launches POST) ← T-FUNIL-010
  T-FUNIL-012 (domain: processor usa blueprint)          ← T-FUNIL-010
  T-FUNIL-014 (schema: seed 4 presets)                   ← T-FUNIL-010

Onda 2 (1 T-ID):
  T-FUNIL-013 (CP: seletor template + UI stages)         ← T-FUNIL-011

Onda 3 (paralela):
  T-FUNIL-015 (tests) ← T-FUNIL-010..014
  T-FUNIL-016 (docs-sync) ← T-FUNIL-010..014

Onda 4 (serial):
  T-FUNIL-017 (br-auditor) ← T-FUNIL-010..016
```

---

## Blueprint shape (referência completa)

```ts
type FunnelBlueprint = {
  type: 'lancamento_gratuito' | 'lancamento_pago' | 'evergreen'
  has_main_offer: boolean
  has_workshop: boolean
  checkout_variant?: 'direto_guru' | 'checkout_proprio' | 'com_popup'
  stages: Array<{
    slug: string
    label: string
    is_recurring: boolean
    source_events: string[]
    source_event_filters?: Record<string, string>  // ex.: { funnel_role: 'workshop' }
  }>
  pages: Array<{
    role: 'capture' | 'sales' | 'thankyou' | 'webinar' | 'checkout' | 'survey'
    suggested_public_id?: string
    event_config: { canonical: string[]; custom: string[] }
    suggested_funnel_role?: 'workshop' | 'main_offer'
  }>
  audiences: Array<{
    slug: string
    name: string
    platform: 'meta' | 'google' | 'internal'
    query_template: Record<string, unknown>  // DSL de audience existente
  }>
}
```

## Notas técnicas

### Hot path do processor — cache de blueprint

Cache implementado com `Map<launchId, { blueprint, fetchedAt }>` em módulo-level (singleton no CF Worker instance). TTL 60s. Verificar: `if (now - fetchedAt > 60_000) refetch`. Em dev, TTL pode ser reduzido para 5s para facilitar testes.

### Scaffold via `waitUntil`

`scaffoldLaunch` é chamado em `c.executionCtx.waitUntil(scaffoldLaunch(...))` para não bloquear a resposta do `POST /v1/launches`. O CP deve exibir um indicador de "scaffolding em andamento" e fazer polling após criação.

### Distinção Purchase workshop vs main offer

`source_event_filters: { funnel_role: 'workshop' }` só funciona quando Fase 3 (Sprint 11) injeta `funnel_role` no payload via mapeamento Guru. Antes disso, ambos os Purchases vão para o stage genérico (fallback). Documentar este gap no código com um comentário explicativo.

### Dois diretórios de migrations (MEMORY.md §5)

Copiar `packages/db/migrations/0029_funnel_templates.sql` para `supabase/migrations/20260503000029_funnel_templates.sql`.

### `launches/page.tsx` — conflito de paralelismo

`apps/control-plane/src/app/(app)/launches/page.tsx` foi tocado por T-FUNIL-001 (Sprint 9). T-FUNIL-013 estende o mesmo arquivo. Sequenciar corretamente: T-FUNIL-013 só começa após Sprint 9 estar commitado.

---

## Trade-offs registrados (ADR candidatos)

| Decisão | Trade-off |
|---|---|
| Blueprint copiado para `launches.funnel_blueprint` | Stages editáveis por launch sem afetar template. Custo: duplicação de dados. Ganho: independência por launch. |
| Não suportar troca de template após criar launch (v1) | Simplifica implementação. Workaround: duplicar launch. |
| Cache 60s do blueprint no processor | Hot path O(1) após cache warm. Risco: delay de até 60s para ver stage renomeado em produção. |
| Fallback hardcoded quando `funnel_blueprint IS NULL` | Backward compatible com launches existentes. Remove friction de migração. |

---

## Referências

- [`docs/80-roadmap/funil-templates-plan.md §Fase 2`](funil-templates-plan.md)
- [`docs/20-domain/06-mod-funnel.md`](../20-domain/06-mod-funnel.md)
- [`docs/20-domain/09-mod-audience.md`](../20-domain/09-mod-audience.md)
- [`docs/30-contracts/02-db-schema-conventions.md`](../30-contracts/02-db-schema-conventions.md)
- [`docs/50-business-rules/BR-EVENT.md`](../50-business-rules/BR-EVENT.md)
