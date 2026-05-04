# Sprint 9 — Funil Configurável: UX Hardening (Fase 1)

## Duração estimada
1–2 semanas.

## Objetivo
Expor na UI todo o domínio que já existe no backend mas está oculto: `page.role`, `event_config`, `launch.config.type`, timeline de launch, e eventos por launch. Ao final, operador consegue construir Funil A (Lançamento Gratuito) e Funil B (Lançamento Pago) **manualmente** pela UI sem tocar em código ou API diretamente. Sem schema novo — apenas control-plane e um endpoint de Edge faltante.

## Pré-requisitos
- Sprints 0–8 completos.
- Migrations 0000–0028 aplicadas (incluindo RLS dual-mode de 0028).

## Critério de aceite global

- [ ] Form de criação de launch inclui campos `type` (radio), `objective` (texto) e `start_date`/`end_date`; valores persistem em `launches.config` (JSONB).
- [ ] Form de criação de page inclui seletor `role` (capture/sales/thankyou/webinar/checkout/survey) e pré-popula `event_config` com defaults por role.
- [ ] Painel "Configuração de eventos" no detalhe da page permite editar `event_config` (checkboxes canônicos + textarea custom) e salvar.
- [ ] Launch detail refatorado em tabs: Overview, Pages (chip de role visível), Eventos, Audiences, Performance.
- [ ] Tab "Eventos" exibe stream de eventos reais do launch via `GET /v1/events?launch_id=`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` verdes ao fim de cada onda.

---

## T-IDs — decomposição completa

> `parallel-safe=yes` = pode rodar em paralelo com outras T-IDs da mesma onda (ownership disjunto).

### Tabela mestre

| T-ID | Tipo | Título curto | Onda | parallel-safe | Deps | Agente |
|---|---|---|---|---|---|---|
| T-FUNIL-001 | cp | Form de launch: type + objective + timeline | 1 | yes | — | general-purpose |
| T-FUNIL-002 | cp | Form de page: role + event_config defaults + page-detail-client panel | 1 | yes | — | general-purpose |
| T-FUNIL-003 | cp | Launch detail refatorado com tabs | 1 | yes | — | general-purpose |
| T-FUNIL-004 | edge | `GET /v1/events?launch_id=` — garantir endpoint | 1 | yes | — | edge-author |
| T-FUNIL-005 | test | Testes unit + integration Fase 1 | 2 | yes | T-FUNIL-001..004 | test-author |
| T-FUNIL-006 | docs-sync | Doc sync Fase 1 | 2 | yes | T-FUNIL-001..004 | docs-sync |
| T-FUNIL-007 | br-auditor | Auditoria BR pré-merge | 3 | **no** | T-FUNIL-001..006 | br-auditor |

---

## Plano de ondas

> Máximo de 5 T-IDs por onda. Verificação `pnpm typecheck && pnpm lint && pnpm test` entre cada onda.

---

### Onda 1 — Implementação paralela (4 em paralelo)

> Sem dependências cruzadas. Ownership disjunto: T-FUNIL-001 toca `launches/page.tsx`, T-FUNIL-002 toca `pages/new/page.tsx` + `pages/[id]/page-detail-client.tsx` + `lib/`, T-FUNIL-003 toca `launches/[id]/page.tsx`, T-FUNIL-004 toca `apps/edge/`.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-001** | `apps/control-plane/src/app/(app)/launches/page.tsx` | Form de criação de launch (`/launches/new` ou dialog inline) ganha três novos campos: (1) `type` — radio group com opções `lancamento_gratuito` / `lancamento_pago` / `evergreen` / `outro`, mapeado para `config.type`; (2) `objective` — textarea livre, mapeado para `config.objective`; (3) `start_date` / `end_date` — date pickers, mapeados para `config.timeline.start_date` e `config.timeline.end_date`. Todos campos opcionais (não quebram fluxo existente). Persistir via `PATCH /v1/launches/:id` ou no POST de criação. Validação Zod no front: `start_date <= end_date` quando ambos presentes. Tipo exibido como badge na lista de launches. |
| **T-FUNIL-002** | `apps/control-plane/src/app/(app)/launches/[launch_public_id]/pages/new/page.tsx`, `apps/control-plane/src/app/(app)/launches/[launch_public_id]/pages/[page_public_id]/page-detail-client.tsx`, `apps/control-plane/src/lib/page-role-defaults.ts` | (A) Criar `apps/control-plane/src/lib/page-role-defaults.ts` exportando mapa `role → defaultEventConfig`. Defaults: `capture → ['PageView','Lead']`; `sales → ['PageView','ViewContent','InitiateCheckout']`; `checkout → ['PageView','InitiateCheckout']`; `thankyou → ['PageView','Purchase']`; `webinar → ['PageView','ViewContent']`; `survey → ['PageView']`. (B) Form de criação de page ganha seletor `role` (select/radio com 6 opções já listadas). Ao selecionar role, `event_config` é pré-populado com defaults via `page-role-defaults.ts`. (C) `page-detail-client.tsx`: adicionar seção "Configuração de eventos" com checkboxes para eventos canônicos (`PageView`, `Lead`, `ViewContent`, `InitiateCheckout`, `Purchase`, `Contact`, `CompleteRegistration`) + textarea para custom events (um por linha, prefixo `custom:`). Botão "Salvar configuração" persiste via `PATCH /v1/pages/:id` com `event_config`. Verificar se `packages/shared/src/schemas/event-config.ts` (ou equivalente) existe — se não, criar Zod schema ali e importar tanto no CP quanto como referência. |
| **T-FUNIL-003** | `apps/control-plane/src/app/(app)/launches/[launch_public_id]/page.tsx` | Refatorar o layout em tabs usando `<Tabs>` do shadcn/ui. **Overview** — conteúdo atual (nome, status, tipo, datas, snippet de instalação). **Pages** — lista de pages com chip de `role` visível por item (badge colorido: capture=azul, sales=laranja, thankyou=verde, webinar=roxo, checkout=amarelo, survey=cinza) + botão "+ Nova page". **Eventos** — painel que consome `GET /v1/events?launch_id=&limit=50` com auto-refresh a cada 10s; lista eventos em ordem cronológica com `event_name`, `created_at`, `lead_public_id` (link). **Audiences** — lista de audiences filtradas por `launch_id` (se endpoint existir; se não, placeholder "Em breve"). **Performance** — métricas básicas: total de leads, total de eventos, últimas 24h (pode ser placeholder se endpoint não existir). Estado ativo da tab é mantido em URL query param `?tab=` para shareable links. |
| **T-FUNIL-004** | `apps/edge/src/routes/events.ts` | Verificar se `GET /v1/events` aceita query param `launch_id`. Se não aceitar: adicionar filtro `WHERE events.launch_id = $launch_id` quando `launch_id` está presente na query. Retornar `{ events: [...], total, next_cursor }` com paginação cursor-based (`limit` default 50, max 200). Autenticação: session CP (auth-cp middleware). RLS via `events.launch_id` — launch deve pertencer ao workspace do token. Adicionar ao contrato em `docs/30-contracts/05-api-server-actions.md` na seção Events se ausente (nota: se precisar criar seção nova no contrato, cria em onda própria serial — para esta T-ID, apenas verificar e adicionar inline se a seção já existe). |

**Verificação após onda 1:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 2 — Testes + doc sync (2 em paralelo)

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-FUNIL-005** | `tests/unit/control-plane/funil/`, `tests/integration/funil/fase-1/` | Unit: `page-role-defaults.test.ts` — valida que cada role retorna array correto de events; `event-config-schema.test.ts` — Zod schema aceita eventos canônicos e custom e rejeita strings vazias. Integration: `launch-form-type.test.tsx` — create launch com `type=lancamento_pago` persiste em `config.type`; `page-form-role.test.tsx` — selecionar role `capture` pré-popula `event_config` correto; `events-by-launch.test.ts` — `GET /v1/events?launch_id=` retorna só eventos do launch correto (cross-launch isolation). Mínimo 15 novos testes verdes. |
| **T-FUNIL-006** | `docs/20-domain/02-mod-launch.md`, `docs/20-domain/03-mod-page.md`, `docs/30-contracts/05-api-server-actions.md`, `docs/70-ux/02-information-architecture.md`, `docs/70-ux/04-screen-page-registration.md` | Atualizar: (1) `02-mod-launch.md` — adicionar `config.type`, `config.objective`, `config.timeline` na seção de campos. (2) `03-mod-page.md` — documentar defaults de `event_config` por `role`; referenciar `page-role-defaults.ts`. (3) `05-api-server-actions.md` — confirmar/adicionar `GET /v1/events?launch_id=` na seção Events. (4) `02-information-architecture.md` — adicionar tabs do launch detail (`?tab=overview|pages|eventos|audiences|performance`) ao mapa de rotas. (5) `04-screen-page-registration.md` — adicionar seção sobre seletor de role e painel de event_config. |

**Verificação após onda 2:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 3 — Auditoria pré-merge (serial)

| T-ID | Critério de aceite |
|---|---|
| **T-FUNIL-007** | Auditor verifica: (1) Nenhum campo de PII exposto sem mascaramento nos novos endpoints. (2) `GET /v1/events?launch_id=` aplica RLS correto (workspace isolation — eventos de outro workspace não retornam). (3) `page-role-defaults.ts` não introduz dependência circular. (4) Tabs do launch detail têm `aria-label` e `role="tablist"` (acessibilidade). Relatório com BRs OK / missing. |

---

## Grafo de dependências (resumo visual)

```
Onda 1 (paralela, sem deps):
  T-FUNIL-001 (CP: form launch type+timeline)
  T-FUNIL-002 (CP: form page role+event_config)   ←── chip de role usado em T-FUNIL-003 (leitura)
  T-FUNIL-003 (CP: launch detail tabs)
  T-FUNIL-004 (Edge: events?launch_id)

Onda 2 (paralela):
  T-FUNIL-005 (tests) ← T-FUNIL-001..004
  T-FUNIL-006 (docs-sync) ← T-FUNIL-001..004

Onda 3 (serial):
  T-FUNIL-007 (br-auditor) ← T-FUNIL-001..006
```

---

## Notas técnicas

### Persistência de `launches.config` (JSONB)

`launches.config` já é JSONB — sem migration necessária. O merge de subcampos deve seguir o padrão já documentado em MEMORY.md §5: `SELECT → merge JS → UPDATE com objeto plano` (bug de encoding do CF Worker local com `||` SQL e Drizzle).

### `event_config` — formato canônico

```ts
type EventConfig = {
  canonical: string[]  // ex.: ['PageView', 'Lead', 'InitiateCheckout']
  custom: string[]     // ex.: ['custom:watched_class_1', 'custom:watched_class_2']
}
```

Validar via Zod em `packages/shared/src/schemas/event-config.ts` (criar se não existir). Edge já usa esse formato; CP deve espelhar a mesma validação.

### Tabs no launch detail

Usar componente `<Tabs>` do shadcn/ui já instalado. URL param `?tab=` via `useSearchParams()` (App Router). Default tab = `overview`.

### Chip de role na lista de pages

Usar `<Badge variant="outline">` com mapa de cores por role definido em `page-role-defaults.ts` (ou constante separada). Não usar cores inline — usar variantes do design system (`docs/70-ux/01-design-system-tokens.md`).

### Endpoint `GET /v1/events?launch_id=` — AUTH

O endpoint deve usar o middleware `auth-cp` (já existente em `apps/edge/src/middleware/auth-cp.ts`). Se o middleware ainda estiver em modo DEV_WORKSPACE_ID hardcoded, isso é aceito nesta sprint (está documentado em MEMORY.md §5 como pendência de produção).

---

## Verificação E2E manual (após sprint)

1. Criar launch "Funil A Teste" com `type=lancamento_gratuito`, `start_date=2026-06-01`. Confirmar que `launches.config.type = 'lancamento_gratuito'` via Supabase Studio.
2. Criar 4 pages para o launch com roles: `capture`, `sales`, `thankyou`, `webinar`. Confirmar chips de role na tab Pages do launch.
3. Na page `sales`: abrir painel "Configuração de eventos", desmarcar `InitiateCheckout`, salvar. Confirmar que `pages.event_config` não inclui `InitiateCheckout`.
4. Disparar evento via `curl` com `launch_id` e verificar que aparece na tab Eventos do launch.
5. Tab Audiences: placeholder ou lista (se endpoint existir).

---

## Referências

- [`docs/80-roadmap/funil-templates-plan.md §Fase 1`](funil-templates-plan.md)
- [`docs/70-ux/02-information-architecture.md`](../70-ux/02-information-architecture.md) — rotas e IA
- [`docs/70-ux/04-screen-page-registration.md`](../70-ux/04-screen-page-registration.md) — tela de page
- [`docs/20-domain/03-mod-page.md`](../20-domain/03-mod-page.md) — módulo page (role, event_config)
- [`docs/20-domain/02-mod-launch.md`](../20-domain/02-mod-launch.md) — módulo launch (config JSONB)
