# Sprint 11 — Funil Configurável: Webhook Guru Contextualizado (Fase 3)

## Duração estimada
1–2 semanas.

## Objetivo
Fechar o ciclo do funil: webhook do Guru Digital Manager chega já sabendo a qual launch pertence **e qual papel desempenha no funil** (`funnel_role: 'workshop' | 'main_offer'`). Isso permite que o `raw-events-processor` (já preparado na Fase 2) distinga corretamente `purchased_workshop` de `purchased_main`, completando o Funil B. Operador configura o mapeamento `product_id ↔ launch + funnel_role` pela UI sem tocar em config manual.

## Pré-requisitos
- Sprint 10 completo (blueprint no launch + processor com `source_event_filters`).
- `apps/edge/src/routes/webhooks/guru.ts` existente (Sprint 3).

## Critério de aceite global

- [ ] `guru-launch-resolver.ts` resolve `launch_id + funnel_role` por `product_id` via mapeamento explícito em `workspace.config.integrations.guru.product_launch_map`.
- [ ] Fallback: se `product_id` não está no map, usa `last_attribution` do lead e `funnel_role = null`.
- [ ] Cada estratégia usada é registrada em `audit_log` com campo `strategy: 'mapping' | 'last_attribution' | 'none'`.
- [ ] `PATCH /v1/workspace/config` permite atualizar subcampos de `workspace.config` de forma segura (JSONB merge).
- [ ] UI no launch detail (tab Overview, painel "Mapeamento Guru") permite cadastrar/editar mappings product↔launch+funnel_role.
- [ ] Webhook Guru Purchase com `product_id` mapeado → `lead_stages` row com stage `purchased_workshop` ou `purchased_main` conforme `funnel_role`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` verdes ao fim de cada onda.

---

## T-IDs — decomposição completa

> `parallel-safe=yes` = pode rodar em paralelo com outras T-IDs da mesma onda (ownership disjunto).

### Tabela mestre

| T-ID | Tipo | Título curto | Onda | parallel-safe | Deps | Agente |
|---|---|---|---|---|---|---|
| T-FUNIL-020 | domain | `guru-launch-resolver.ts` — resolver primário + fallback + audit | 1 | yes | Sprint 10 | domain-author |
| T-FUNIL-021 | edge | `PATCH /v1/workspace/config` — endpoint de merge de config | 1 | yes | Sprint 10 | edge-author |
| T-FUNIL-022 | webhook | `webhooks/guru.ts` — integrar resolver, injetar launch_id + funnel_role | 2 | yes | T-FUNIL-020 | webhook-author |
| T-FUNIL-023 | cp | UI de mapeamento product↔launch+funnel_role no launch detail | 2 | yes | T-FUNIL-020, T-FUNIL-021 | general-purpose |
| T-FUNIL-024 | test | Testes unit + integration Fase 3 | 3 | yes | T-FUNIL-020..023 | test-author |
| T-FUNIL-025 | docs-sync | Doc sync Fase 3 + verificação E2E final | 3 | yes | T-FUNIL-020..023 | docs-sync |
| T-FUNIL-026 | br-auditor | Auditoria BR pré-merge final | 4 | **no** | T-FUNIL-020..025 | br-auditor |

---

## Plano de ondas

> Máximo de 5 T-IDs por onda. Verificação `pnpm typecheck && pnpm lint && pnpm test` entre cada onda.

---

### Onda 1 — Fundação paralela (2 em paralelo)

> Ownership disjunto: T-FUNIL-020 em `apps/edge/src/lib/`, T-FUNIL-021 em `apps/edge/src/routes/`.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-020** | `apps/edge/src/lib/guru-launch-resolver.ts` (novo) | Exportar `resolveLaunchForGuruEvent({ workspaceId, productId, leadHints, db })` que retorna `{ launch_id: string | null, funnel_role: string | null, strategy: 'mapping' | 'last_attribution' | 'none' }`. **Estratégia primária (mapping)**: ler `workspaces.config.integrations.guru.product_launch_map` (objeto `{ [product_id]: { launch_public_id, funnel_role } }`). Se `productId` está no map: resolver `launch_public_id → launch_id` (UUID) via query; retornar `launch_id + funnel_role + strategy='mapping'`. **Fallback (last_attribution)**: se `productId` não está no map OU `launch_id` não encontrado: usar `leadHints.email | phone | visitor_id` para buscar `lead_attribution` mais recente do lead e copiar `launch_id`. `funnel_role = null`. `strategy = 'last_attribution'`. **Nenhum dado (none)**: se nem lead identificável: retornar `{ launch_id: null, funnel_role: null, strategy: 'none' }`. **Audit log**: em qualquer caso, chamar `safeLog` com `action='guru_launch_resolved'`, `metadata: { product_id, strategy, launch_id, funnel_role }`. Usar `DATABASE_URL ?? HYPERDRIVE.connectionString`. |
| **T-FUNIL-021** | `apps/edge/src/routes/workspace-config.ts` (novo, ou extensão de rota existente) | Verificar se `PATCH /v1/workspace/config` existe. Se não: criar `apps/edge/src/routes/workspace-config.ts` com `PATCH /v1/workspace/config` autenticado (auth-cp, role OPERATOR/ADMIN). Body: objeto parcial de `workspace.config` (validado via Zod — deve aceitar subcampos conhecidos; rejeitar campos extras). Merge seguro: SELECT config atual → merge JS em subcampo (`integrations.guru.product_launch_map`) → UPDATE. Não usar `||` SQL (bug de encoding — MEMORY.md §5). Retornar `{ config: <merged> }`. Registrar `audit_log` com `action='workspace_config_updated'`, `metadata: { fields_updated }`. Registrar a rota em `apps/edge/src/index.ts`. |

**Verificação após onda 1:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 2 — Integração + UI (2 em paralelo)

> T-FUNIL-022 depende de T-FUNIL-020 (resolver). T-FUNIL-023 depende de T-FUNIL-020 e T-FUNIL-021. Entre si: ownership disjunto.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-022** | `apps/edge/src/routes/webhooks/guru.ts` | Após resolver workspace e antes de inserir `raw_event` (onde atualmente `launch_id` pode não estar no payload), chamar `resolveLaunchForGuruEvent({ workspaceId, productId: payload.product?.id, leadHints: { email: payload.customer?.email, phone: payload.customer?.phone }, db })`. Injetar no payload do raw_event: `launch_id` (se resolvido) e `funnel_role` (se presente). O `raw-events-processor` (T-FUNIL-012) já lê `payload.funnel_role` no filtro de stages. Se `launch_id` já estava sendo injetado anteriormente por outro mecanismo, garantir que o novo mecanismo tem precedência (mapping explícito > fallback anterior). |
| **T-FUNIL-023** | `apps/control-plane/src/app/(app)/launches/[launch_public_id]/page.tsx` (extensão, tab Overview) | Adicionar painel "Mapeamento Guru" na tab Overview do launch detail. O painel mostra: tabela com linhas `{ product_id, funnel_role, launch }` dos mappings existentes em `workspace.config.integrations.guru.product_launch_map` filtrados por `launch_public_id` atual. Botão "+ Adicionar produto" abre modal com dois campos: `product_id` (texto, ex.: `prod_workshop_xyz`) e `funnel_role` (select: `workshop` / `main_offer` / `outro`). Ao confirmar: `PATCH /v1/workspace/config` com merge em `integrations.guru.product_launch_map[product_id] = { launch_public_id, funnel_role }`. Botão de exclusão por linha remove a entrada do map. Exibir `strategy` na última coluna para os últimos webhooks resolvidos (se disponível via audit_log — opcional, pode ser placeholder). **Nota**: este painel está em `launches/[id]/page.tsx` — mesmo arquivo tocado por T-FUNIL-003. Garantir que a extensão de T-FUNIL-023 é feita sobre o resultado de T-FUNIL-003 (Sprint 9), adicionando o painel apenas na tab Overview. |

**Verificação após onda 2:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 3 — Testes + doc sync (2 em paralelo)

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-024** | `tests/unit/funil/fase-3/`, `tests/integration/funil/fase-3/`, `tests/e2e/funil-b.spec.ts` | Unit: `guru-launch-resolver.test.ts` — strategy=mapping retorna launch_id+funnel_role corretos; strategy=last_attribution copia launch_id correto e funnel_role=null; strategy=none quando nenhum dado disponível. `workspace-config-merge.test.ts` — PATCH aceita subcampo válido; rejeita campo extra; merge não sobrescreve outros subcampos. Integration: `guru-webhook-resolved.test.ts` — webhook Guru Purchase com product_id mapeado insere raw_event com launch_id+funnel_role; processor cria stage correto (`purchased_workshop` vs `purchased_main`). `guru-webhook-fallback.test.ts` — product_id não mapeado usa last_attribution; audit_log registra strategy. E2E (playwright ou curl script): sequência completa Funil B — webhook Purchase workshop → stage `purchased_workshop` ✓; webhook Purchase main_offer → stage `purchased_main` ✓; audience `compradores_workshop_aquecimento` exclui lead após purchased_main. Mínimo 20 novos testes verdes. |
| **T-FUNIL-025** | `docs/40-integrations/13-digitalmanager-guru-webhook.md`, `docs/30-contracts/05-api-server-actions.md`, `docs/20-domain/06-mod-funnel.md`, `docs/20-domain/01-mod-workspace.md` | Atualizar: (1) `13-digitalmanager-guru-webhook.md` — documentar `resolveLaunchForGuruEvent`, mapeamento explícito, fallback last_attribution, campo `funnel_role` injetado no payload, audit_log por strategy. (2) `05-api-server-actions.md` — adicionar `PATCH /v1/workspace/config` com body shape e campos suportados. (3) `06-mod-funnel.md` — atualizar seção "Distinção Purchase por funnel_role" com o pipeline completo (mapeamento Guru → funnel_role no payload → processor usa source_event_filters). (4) `01-mod-workspace.md` — documentar `config.integrations.guru.product_launch_map` shape. |

**Verificação após onda 3:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 4 — Auditoria pré-merge (serial)

| T-ID | Critério de aceite |
|---|---|
| **T-FUNIL-026** | Auditor verifica: (1) `guru-launch-resolver` — `product_launch_map` é lido de `workspaces.config`, nunca de source não-autenticada. (2) `PATCH /v1/workspace/config` — body validado via Zod; nenhum campo arbitrário aceito; `workspace_id` sempre do JWT (não do body). (3) Audit log registrado em TODAS as estratégias de resolução (mapping, last_attribution, none). (4) `webhooks/guru.ts` — `funnel_role` injetado no payload mas NÃO vaza PII do cliente. (5) BR-AUDIT-001 citado em todas as mutações sensíveis (workspace config, audit_log). (6) BR-WEBHOOK-001..004 verificados no adapter Guru. (7) INV-FUNNEL-001..004 ainda íntegros após mudanças no processor. Relatório com BRs OK / missing + gap list. |

---

## Grafo de dependências (resumo visual)

```
Onda 1 (paralela — sem deps entre si):
  T-FUNIL-020 (domain: guru-launch-resolver)
  T-FUNIL-021 (edge: PATCH workspace/config)

Onda 2 (paralela — deps de onda 1):
  T-FUNIL-022 (webhook: guru.ts integration)   ← T-FUNIL-020
  T-FUNIL-023 (CP: UI mapping Guru)            ← T-FUNIL-020, T-FUNIL-021

Onda 3 (paralela):
  T-FUNIL-024 (tests)     ← T-FUNIL-020..023
  T-FUNIL-025 (docs-sync) ← T-FUNIL-020..023

Onda 4 (serial):
  T-FUNIL-026 (br-auditor) ← T-FUNIL-020..025
```

---

## Notas técnicas

### Formato do `product_launch_map`

```json
{
  "prod_workshop_xyz": {
    "launch_public_id": "lcm-maio-2026",
    "funnel_role": "workshop"
  },
  "prod_main_xyz": {
    "launch_public_id": "lcm-maio-2026",
    "funnel_role": "main_offer"
  },
  "prod_evergreen_abc": {
    "launch_public_id": "evergreen-cs",
    "funnel_role": "main_offer"
  }
}
```

Armazenado em `workspace.config.integrations.guru.product_launch_map`.

### Merge seguro de JSONB (MEMORY.md §5)

O bug de encoding do CF Worker local com `||` SQL e Drizzle afeta o PATCH de workspace config. Usar padrão: SELECT → merge JS (spread profundo no subcampo) → UPDATE com objeto completo. Exemplo:

```ts
const current = await db.select({ config: workspaces.config }).from(workspaces).where(...)
const merged = {
  ...current.config,
  integrations: {
    ...current.config?.integrations,
    guru: {
      ...current.config?.integrations?.guru,
      product_launch_map: {
        ...current.config?.integrations?.guru?.product_launch_map,
        [productId]: { launch_public_id, funnel_role }
      }
    }
  }
}
await db.update(workspaces).set({ config: merged }).where(...)
```

### Dependência entre T-FUNIL-022 e Sprint 10

T-FUNIL-022 modifica `webhooks/guru.ts` que foi criado no Sprint 3. O processor modificado em T-FUNIL-012 (Sprint 10) já espera `payload.funnel_role`. A integração só fecha com os dois sprints aplicados.

### `funnel_role` no raw_event payload

O campo `funnel_role` é injetado no `raw_event.payload` (JSONB) — não em uma coluna tipada. O processor já acessa `payload.funnel_role` via `source_event_filters`. Não é necessário schema change adicional.

### Auditoria por estratégia

O campo `strategy` fica em `audit_log.metadata`. O painel de mapeamento no CP pode exibir a estratégia usada nos últimos webhooks consultando `audit_log` filtrado por `action='guru_launch_resolved' AND metadata->>'product_id' IN (...)`.

---

## Verificação E2E — Funil B completo (cenário de aceite final desta entrega)

1. Criar workspace de teste; onboarding até Step 5.
2. `POST /v1/launches` com `funnel_template_slug=lancamento_pago_workshop_com_main_offer` → confirmar 4 pages + 5 audiences + `funnel_blueprint` populado.
3. Cadastrar 2 mappings na UI (tab Overview > Mapeamento Guru):
   - `prod_workshop_xyz → { lcm-maio-2026, workshop }`
   - `prod_main_xyz → { lcm-maio-2026, main_offer }`
4. Editar stage `watched_class_2` → label "Assistiu Aula 2 (peak interest)".
5. Disparar sequência de eventos:
   - PageView capture → Lead → InitiateCheckout (funnel_role: workshop) → Webhook Guru Purchase product=prod_workshop_xyz → Contact → custom:watched_class_1 → custom:watched_class_2 → PageView sales → InitiateCheckout (funnel_role: main_offer) → Webhook Guru Purchase product=prod_main_xyz
6. Verificar `lead_stages`: todos os stages esperados presentes (`lead_workshop`, `clicked_buy_workshop`, `purchased_workshop`, `wpp_joined`, `watched_class_1`, `watched_class_2`, `clicked_buy_main`, `purchased_main`).
7. Audience sync: `compradores_workshop_aquecimento` NÃO inclui o lead (tem purchased_main); `compradores_main` inclui; `engajados_workshop` inclui (watched_class_2).

---

## Referências

- [`docs/80-roadmap/funil-templates-plan.md §Fase 3`](funil-templates-plan.md)
- [`docs/40-integrations/13-digitalmanager-guru-webhook.md`](../40-integrations/13-digitalmanager-guru-webhook.md)
- [`docs/20-domain/06-mod-funnel.md`](../20-domain/06-mod-funnel.md)
- [`docs/30-contracts/06-audit-trail-spec.md`](../30-contracts/06-audit-trail-spec.md)
- [`docs/50-business-rules/BR-WEBHOOK.md`](../50-business-rules/BR-WEBHOOK.md)
- [`docs/50-business-rules/BR-AUDIT.md`](../50-business-rules/BR-AUDIT.md)
